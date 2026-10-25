import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { execute, killCursorProcessGroup } from '../tools/swarm/core-41.mjs';

const envelope = JSON.stringify({ files_changed: [], notes: [] });
const cursorLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: envelope });

const realProcessKill = process.kill.bind(process);

before(() => {
  process.kill = () => { throw new Error('cursor-process-group tests must inject killImpl'); };
});

after(() => {
  process.kill = realProcessKill;
});

function recordingKillImpl({ alive = true, onCall } = {}) {
  const calls = [];
  const killImpl = (target, signal) => {
    calls.push({ target, signal });
    onCall?.(target, signal);
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    if (signal === 'SIGTERM' && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  return { calls, killImpl };
}

function fakeCursorChild(pid = 6000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end() {}, on() {}, destroy() {} };
  return child;
}

function cursorJob(overrides = {}) {
  return { agent: 'cursor', model: 'composer-2.5', context: [], outputs: [], timeoutMs: 200, ...overrides };
}

const launch = { profile: '/repo/sandbox.sb', bin: '/opt/cursor/cursor-agent', worktree: '/repo/wt', env: {} };

function spawnCursorChild(child, { complete = false, hang = false } = {}) {
  return () => {
    if (complete) {
      setTimeout(() => {
        child.stdout.write(`${cursorLine}\n`);
        child.emit('close', 0);
      }, 5);
    } else if (!hang) {
      setTimeout(() => child.emit('close', 0), 5);
    }
    return child;
  };
}

function noopSleep() {
  return Promise.resolve();
}

function killImplEndsChild(child) {
  return (target, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 0) {
      setImmediate(() => child.emit('close', null));
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }
  };
}

function killGroupViaKillImpl(pid, { killImpl }) {
  try { killImpl(-pid, 'SIGTERM'); } catch { /* ESRCH ok */ }
  return Promise.resolve({ refused: false, error: null });
}

test('killCursorProcessGroup refuses invalid pids and never signals', async () => {
  const { calls, killImpl } = recordingKillImpl();
  assert.deepEqual(await killCursorProcessGroup(0, { killImpl, sleep: noopSleep }), { refused: true, error: null });
  assert.deepEqual(await killCursorProcessGroup(1, { killImpl, sleep: noopSleep }), { refused: true, error: null });
  assert.equal(calls.length, 0);
});

test('killCursorProcessGroup refuses our own pid and parent pid', async () => {
  const { calls, killImpl } = recordingKillImpl();
  assert.deepEqual(await killCursorProcessGroup(process.pid, { killImpl, sleep: noopSleep }), { refused: true, error: null });
  assert.deepEqual(await killCursorProcessGroup(process.ppid, { killImpl, sleep: noopSleep }), { refused: true, error: null });
  assert.equal(calls.length, 0);
});

test('killCursorProcessGroup treats an already-dead group as success', async () => {
  const { calls, killImpl } = recordingKillImpl({ alive: false });
  const result = await killCursorProcessGroup(4242, { killImpl, sleep: noopSleep });
  assert.deepEqual(result, { refused: false, error: null });
  assert.deepEqual(calls, [{ target: -4242, signal: 'SIGTERM' }]);
});

test('killCursorProcessGroup escalates to SIGKILL only when the group survives the grace window', async () => {
  let clock = 0;
  const { calls, killImpl } = recordingKillImpl();
  await killCursorProcessGroup(5000, {
    killImpl,
    graceMs: 200,
    pollIntervalMs: 50,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  assert.deepEqual(calls[0], { target: -5000, signal: 'SIGTERM' });
  assert.ok(calls.filter(c => c.signal === 0).length >= 1);
  assert.deepEqual(calls.at(-1), { target: -5000, signal: 'SIGKILL' });
});

test('killCursorProcessGroup skips SIGKILL when polling sees the group exit early', async () => {
  let clock = 0;
  let alive = true;
  const calls = [];
  const killImpl = (target, signal) => {
    calls.push({ target, signal });
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  const sleep = async ms => {
    clock += ms;
    if (clock >= 50) alive = false;
  };
  await killCursorProcessGroup(5001, {
    killImpl,
    graceMs: 5000,
    pollIntervalMs: 50,
    now: () => clock,
    sleep,
  });
  assert.deepEqual(calls.filter(c => c.signal === 'SIGKILL'), []);
  assert.ok(calls.some(c => c.signal === 0));
});

test('killCursorProcessGroup re-probes with signal 0 immediately before SIGKILL', async () => {
  let clock = 0;
  const calls = [];
  const killImpl = (target, signal) => { calls.push({ target, signal }); };
  await killCursorProcessGroup(5010, {
    killImpl,
    graceMs: 100,
    pollIntervalMs: 50,
    now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  const killIdx = calls.findIndex(c => c.signal === 'SIGKILL');
  const lastProbeIdx = calls.findLastIndex(c => c.signal === 0);
  assert.ok(killIdx > 0);
  assert.equal(killIdx, lastProbeIdx + 1);
});

test('execute cursor jobs kill the recorded group on complete', async () => {
  const child = fakeCursorChild(6100);
  const groups = [];
  const { killImpl } = recordingKillImpl();
  const result = await execute(cursorJob({ timeoutMs: 5000 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { complete: true }),
    cursor: launch,
    killImpl,
    killGroupImpl: pid => { groups.push(pid); return Promise.resolve({ refused: false, error: null }); },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(groups, [6100]);
});

test('execute cursor jobs kill the recorded group on timeout', async () => {
  const child = fakeCursorChild(6200);
  const groups = [];
  const killImpl = killImplEndsChild(child);
  const result = await execute(cursorJob({ timeoutMs: 30 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { hang: true }),
    cursor: launch,
    killImpl,
    killGroupImpl: (pid, opts) => { groups.push(pid); return killGroupViaKillImpl(pid, opts); },
  });
  assert.equal(result.status, 'timeout');
  assert.deepEqual(groups, [6200]);
});

test('execute cursor jobs kill the recorded group on cancel', async () => {
  const child = fakeCursorChild(6300);
  const groups = [];
  const controller = new AbortController();
  const killImpl = killImplEndsChild(child);
  const pending = execute(cursorJob({ timeoutMs: 5000 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { hang: true }),
    cursor: launch,
    signal: controller.signal,
    killImpl,
    killGroupImpl: (pid, opts) => { groups.push(pid); return killGroupViaKillImpl(pid, opts); },
  });
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(groups, [6300]);
});

test('execute cursor jobs refuse an invalid group pid without signalling', async () => {
  const child = fakeCursorChild(1);
  const { calls, killImpl } = recordingKillImpl();
  const result = await execute(cursorJob({ timeoutMs: 5000 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { complete: true }),
    cursor: launch,
    killImpl,
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 0);
});

test('execute cursor stop runs one kill sequence when exit races timeout', async () => {
  const child = fakeCursorChild(6400);
  let sequences = 0;
  const killImpl = killImplEndsChild(child);
  const killGroupImpl = async (pid, opts) => {
    sequences += 1;
    return killGroupViaKillImpl(pid, opts);
  };
  const pending = execute(cursorJob({ timeoutMs: 40 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { complete: true }),
    cursor: launch,
    killImpl,
    killGroupImpl,
  });
  const result = await pending;
  assert.equal(result.status, 'complete');
  assert.equal(sequences, 1);
});
