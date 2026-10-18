import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STOP_FILE,
  readStopMarker,
  stopGuard,
  clearStop,
  runStopAll,
  exitCodeFor,
  formatStopLines,
} from '../tools/stop-all.mjs';

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'stop-all-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeDeps(over = {}) {
  const sleeps = [];
  const deps = {
    pollMs: 500,
    waitMs: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    listRuns: async () => [],
    cancelRun: async () => {},
    readAutopilotPid: async () => null,
    kill: async () => {},
    isAlive: async () => false,
    gpuSession: async () => null,
    gpuDown: async () => {},
    gpuStatus: async () => ({ session: null }),
    backup: async () => ({ id: '20240101-000000-abcd' }),
    ...over,
  };
  return { deps, sleeps };
}

function stepOf(res, name) {
  return res.steps.find((s) => s.name === name);
}

test('marker is written first and nothing runs before it', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps();
    let markerSeen = false;
    deps.listRuns = async () => {
      const raw = await readFile(join(root, STOP_FILE), 'utf8');
      markerSeen = JSON.parse(raw).reason === 'swarm stop --all';
      return [];
    };
    const res = await runStopAll(root, deps);
    assert.equal(markerSeen, true);
    assert.deepEqual(res.steps.map((s) => s.name), ['marker', 'autopilot', 'runs', 'gpu', 'backup']);
    assert.equal(res.ok, true);
    assert.equal(res.billingRisk, false);
    assert.equal(stepOf(res, 'runs').status, 'nothing');
  });
});

test('running runs are cancelled and polled until none run', async () => {
  await withRoot(async (root) => {
    const { deps, sleeps } = makeDeps();
    const cancelled = [];
    let calls = 0;
    deps.listRuns = async () => {
      calls++;
      if (calls === 1) return [{ id: 'r1', status: 'running' }, { id: 'r2', status: 'done' }];
      if (calls === 2) return [{ id: 'r1', status: 'running' }];
      return [{ id: 'r1', status: 'done' }];
    };
    deps.cancelRun = async (_root, id) => {
      cancelled.push(id);
    };
    const res = await runStopAll(root, deps);
    assert.deepEqual(cancelled, ['r1']);
    assert.equal(stepOf(res, 'runs').status, 'done');
    assert.ok(calls >= 3);
    assert.ok(sleeps.includes(500));
    assert.equal(res.ok, true);
  });
});

test('runs still running after waitMs fail with the ids listed', async () => {
  await withRoot(async (root) => {
    const { deps, sleeps } = makeDeps({ waitMs: 1000, pollMs: 500 });
    deps.listRuns = async () => [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'running' },
    ];
    const res = await runStopAll(root, deps);
    const step = stepOf(res, 'runs');
    assert.equal(step.status, 'failed');
    assert.ok(step.detail.startsWith('still running: a, b'));
    assert.deepEqual(sleeps.filter((ms) => ms === 500), [500, 500]);
    assert.equal(res.ok, false);
  });
});

test('autopilot exact pid gets SIGTERM then SIGKILL when it stays alive', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps();
    const kills = [];
    deps.readAutopilotPid = async () => 4242;
    deps.kill = async (pid, sig) => {
      kills.push([pid, sig]);
    };
    deps.isAlive = async () => true;
    const res = await runStopAll(root, deps);
    assert.deepEqual(kills, [
      [4242, 'SIGTERM'],
      [4242, 'SIGKILL'],
    ]);
    assert.equal(stepOf(res, 'autopilot').status, 'failed');
    assert.equal(res.ok, false);
  });
});

test('autopilot exiting after SIGTERM gets no SIGKILL', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps();
    const kills = [];
    let alive = true;
    deps.readAutopilotPid = async () => 777;
    deps.kill = async (pid, sig) => {
      kills.push([pid, sig]);
      if (sig === 'SIGTERM') alive = false;
    };
    deps.isAlive = async () => alive;
    const res = await runStopAll(root, deps);
    assert.deepEqual(kills, [[777, 'SIGTERM']]);
    assert.equal(stepOf(res, 'autopilot').status, 'done');
  });
});

test('gpu down is retried three times, verified, and sets billingRisk on failure', async () => {
  await withRoot(async (root) => {
    const { deps, sleeps } = makeDeps();
    let downs = 0;
    deps.gpuSession = async () => ({ id: 's1' });
    deps.gpuDown = async () => {
      downs++;
      throw new Error('api 500');
    };
    const res = await runStopAll(root, deps);
    const gpu = stepOf(res, 'gpu');
    assert.equal(downs, 3);
    assert.equal(gpu.status, 'failed');
    assert.equal(sleeps.filter((ms) => ms === 1000).length, 2);
    assert.equal(res.billingRisk, true);
    assert.equal(res.ok, false);
    assert.ok(gpu.detail.includes('the rented node may still be billing: terminate the instance in the provider console now'));
  });
});

test('gpu succeeding on the second attempt is done and not billing', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps();
    let downs = 0;
    deps.gpuSession = async () => (downs >= 2 ? null : { id: 's1' });
    deps.gpuDown = async () => {
      downs++;
    };
    const res = await runStopAll(root, deps);
    assert.equal(downs, 2);
    assert.equal(stepOf(res, 'gpu').status, 'done');
    assert.equal(res.billingRisk, false);
    assert.equal(res.ok, true);
  });
});

test('a failed backup makes ok false but later steps still run', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps();
    deps.backup = async () => {
      throw new Error('disk full');
    };
    const res = await runStopAll(root, deps);
    assert.equal(stepOf(res, 'backup').status, 'failed');
    assert.equal(res.ok, false);
    assert.equal(res.billingRisk, false);
    assert.equal(exitCodeFor(res), 2);
    assert.equal(formatStopLines(res).length, res.steps.length);
  });
});

test('stopGuard and clearStop work with the marker', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps();
    await runStopAll(root, deps);
    const guard = await stopGuard(root);
    assert.equal(guard.code, 'stopped');
    assert.ok(guard.message.includes('swarm stop --clear first'));
    assert.deepEqual(await clearStop(root), { cleared: true });
    assert.equal(await stopGuard(root), null);
    assert.deepEqual(await clearStop(root), { cleared: false });
  });
});

test('readStopMarker returns null when absent and flags bad JSON', async () => {
  await withRoot(async (root) => {
    assert.equal(await readStopMarker(root), null);
    await mkdir(join(root, '.swarm'), { recursive: true });
    await writeFile(join(root, STOP_FILE), 'not json');
    assert.deepEqual(await readStopMarker(root), { at: null, reason: 'unreadable marker' });
  });
});

test('a pid from the lock that is not an autopilot is never signalled; a dead pid is a stale lock', async () => {
  await withRoot(async (root) => {
    const signals = [];
    const { deps } = makeDeps({ readAutopilotPid: async () => 4242, isAlive: async () => true, isAutopilot: async () => false, kill: async (pid, sig) => { signals.push([pid, sig]); } });
    const res = await runStopAll(root, deps);
    assert.equal(stepOf(res, 'autopilot').status, 'failed');
    assert.match(stepOf(res, 'autopilot').detail, /not a swarm autopilot/);
    assert.deepEqual(signals, []);
    assert.equal(res.ok, false);
    const stale = makeDeps({ readAutopilotPid: async () => 4242, isAlive: async () => false, isAutopilot: async () => true, kill: async (pid, sig) => { signals.push([pid, sig]); } });
    assert.equal(stepOf(await runStopAll(root, stale.deps), 'autopilot').status, 'nothing');
    assert.deepEqual(signals, []);
  });
});

test('a failed gpu down is never verified, even when the session record is already gone; a failing status check is not a verification', async () => {
  await withRoot(async (root) => {
    let session = { id: 's' };
    const { deps } = makeDeps({ gpuSession: async () => session, gpuDown: async () => { session = null; throw new Error('ssh unreachable'); } });
    const res = await runStopAll(root, deps);
    assert.equal(stepOf(res, 'gpu').status, 'failed');
    assert.equal(res.billingRisk, true);
    const { deps: d2 } = makeDeps({ gpuSession: async () => ({ id: 's' }), gpuDown: async () => {}, gpuStatus: async () => { throw new Error('status failed'); } });
    assert.equal(stepOf(await runStopAll(root, d2), 'gpu').status, 'failed');
  });
});

test('a non-array run list is a failed step and does not skip the later steps; NaN timings fall back', async () => {
  await withRoot(async (root) => {
    const { deps } = makeDeps({ listRuns: async () => 'oops', pollMs: NaN, waitMs: NaN });
    const res = await runStopAll(root, deps);
    assert.equal(stepOf(res, 'runs').status, 'failed');
    assert.deepEqual(res.steps.map((s) => s.name), ['marker', 'autopilot', 'runs', 'gpu', 'backup']);
  });
});
