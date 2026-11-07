// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findDeadRun, finalizeDeadRun, listRunSpendKeys, STALE_MS } from '../tools/dead-run.mjs';
import { releaseSpend, withSpendStore } from '../tools/spend.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dead-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runningState(id, jobs) {
  return {
    id,
    status: 'running',
    startedAt: '2026-10-20T12:00:00.000Z',
    jobs,
  };
}

async function writeRunState(root, id, state) {
  const dir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

function memoryState(root, id, state) {
  let current = structuredClone(state);
  return {
    readState: async () => structuredClone(current),
    writeState: async (_root, _id, next) => { current = structuredClone(next); },
    get: () => current,
  };
}

test('a live pid is not dead', async t => {
  const root = await tempRoot(t);
  const id = 'run-live';
  await writeRunState(root, id, runningState(id, [{ id: 'j1', status: 'running' }]));
  const livePid = process.pid;
  const result = await findDeadRun(root, id, {
    readState: async () => runningState(id, [{ id: 'j1', status: 'running' }]),
    listLiveRuns: async () => [{ runId: id, pid: livePid, root }],
    isAlive: pid => pid === livePid,
  });
  assert.deepEqual(result, { dead: false });
});

test('a dead pid is dead', async t => {
  const root = await tempRoot(t);
  const id = 'run-dead';
  await writeRunState(root, id, runningState(id, [{ id: 'j1', status: 'running' }]));
  const result = await findDeadRun(root, id, {
    readState: async () => runningState(id, [{ id: 'j1', status: 'running' }]),
    listLiveRuns: async () => [{ runId: id, pid: 424242, root }],
    isAlive: () => false,
  });
  assert.deepEqual(result, { dead: true, reason: 'pid-gone' });
});

test('no live record and stale state file is dead', async t => {
  const root = await tempRoot(t);
  const id = 'run-stale';
  const file = await writeRunState(root, id, runningState(id, [{ id: 'j1', status: 'queued' }]));
  const now = Date.parse('2026-10-20T13:00:00.000Z');
  await fs.utimes(file, now / 1000 - STALE_MS / 1000 - 60, now / 1000 - STALE_MS / 1000 - 60);
  const result = await findDeadRun(root, id, {
    readState: async () => runningState(id, [{ id: 'j1', status: 'queued' }]),
    listLiveRuns: async () => [],
    isAlive: () => true,
    now: () => now,
  });
  assert.deepEqual(result, { dead: true, reason: 'pid-gone' });
});

test('finalize marks jobs cancelled and the run cancelled', async t => {
  const root = await tempRoot(t);
  const id = 'run-finalize';
  const initial = runningState(id, [
    { id: 'done', status: 'complete', finishedAt: '2026-10-20T12:01:00.000Z' },
    { id: 'q', status: 'queued' },
    { id: 'p', status: 'pending' },
    { id: 'h', status: 'held', heldReason: 'budget' },
    { id: 'r', status: 'running', startedAt: '2026-10-20T12:02:00.000Z' },
  ]);
  const mem = memoryState(root, id, initial);
  const now = () => Date.parse('2026-10-20T12:30:00.000Z');
  const out = await finalizeDeadRun(root, id, {
    readState: mem.readState,
    writeState: mem.writeState,
    unregisterLiveRun: async () => {},
    releaseSpend: async () => {},
    spendKeys: async () => [],
    now,
  });
  assert.deepEqual(out.cancelledJobs.sort(), ['h', 'p', 'q', 'r']);
  assert.equal(out.status, 'cancelled');
  const state = mem.get();
  assert.equal(state.status, 'cancelled');
  assert.equal(state.cancelReason, 'runner-gone');
  assert.equal(state.cancelledAt, '2026-10-20T12:30:00.000Z');
  assert.equal(state.jobs.find(j => j.id === 'done').status, 'complete');
  for (const jobId of ['q', 'p', 'h', 'r']) {
    const job = state.jobs.find(j => j.id === jobId);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.finishedAt, '2026-10-20T12:30:00.000Z');
    assert.equal(job.heldReason, undefined);
  }
});

test('finalize releases each reservation key once', async t => {
  const root = await tempRoot(t);
  const spend = await fs.mkdtemp(path.join(os.tmpdir(), 'dead-run-spend-'));
  t.after(() => fs.rm(spend, { recursive: true, force: true }));
  const id = 'run-spend';
  const keys = ['res-a', 'res-b'];
  await withSpendStore(store => {
    for (const key of keys) {
      store.entries[key] = { day: '2026-10-20', lane: 'openrouter', runId: id, root, jobId: key, usd: 0.5, tokens: 100, kind: 'reservation', pid: 1, host: 'x', at: '2026-10-20T12:00:00.000Z', flagged: false };
    }
  }, { dir: spend, now: () => Date.parse('2026-10-20T12:00:00.000Z') });
  assert.deepEqual(await listRunSpendKeys(spend, id), keys);

  const mem = memoryState(root, id, runningState(id, [{ id: 'j1', status: 'running' }]));
  const released = [];
  await finalizeDeadRun(root, id, {
    readState: mem.readState,
    writeState: mem.writeState,
    unregisterLiveRun: async () => {},
    releaseSpend: async ({ key }) => { await releaseSpend({ dir: spend, key }); released.push(key); },
    spendKeys: async runId => listRunSpendKeys(spend, runId),
    now: () => Date.parse('2026-10-20T12:05:00.000Z'),
  });
  assert.deepEqual(released.sort(), keys);
  assert.deepEqual((await finalizeDeadRun(root, id, {
    readState: mem.readState,
    writeState: mem.writeState,
    unregisterLiveRun: async () => {},
    releaseSpend: async ({ key }) => { await releaseSpend({ dir: spend, key }); released.push(key); },
    spendKeys: async runId => listRunSpendKeys(spend, runId),
    now: () => Date.parse('2026-10-20T12:06:00.000Z'),
  })).releasedKeys, []);
  assert.equal(released.length, keys.length);
  assert.deepEqual(await listRunSpendKeys(spend, id), []);
});

test('second finalize call is a no-op', async t => {
  const root = await tempRoot(t);
  const id = 'run-twice';
  const mem = memoryState(root, id, runningState(id, [{ id: 'j1', status: 'queued' }]));
  let releaseCalls = 0;
  const deps = {
    readState: mem.readState,
    writeState: mem.writeState,
    unregisterLiveRun: async () => {},
    releaseSpend: async () => { releaseCalls++; },
    spendKeys: async () => ['would-release'],
    now: () => Date.parse('2026-10-20T12:00:00.000Z'),
  };
  const first = await finalizeDeadRun(root, id, deps);
  assert.deepEqual(first.cancelledJobs, ['j1']);
  assert.equal(releaseCalls, 1);
  const second = await finalizeDeadRun(root, id, deps);
  assert.deepEqual(second, { id, status: 'cancelled', cancelledJobs: [], releasedKeys: [] });
  assert.equal(releaseCalls, 1);
});

test('a run that is not running is refused with a clear error', async t => {
  const root = await tempRoot(t);
  const id = 'run-complete';
  await assert.rejects(
    () => finalizeDeadRun(root, id, {
      readState: async () => ({ id, status: 'complete', jobs: [] }),
      writeState: async () => {},
      unregisterLiveRun: async () => {},
      releaseSpend: async () => {},
      spendKeys: async () => [],
    }),
    err => err.code === 'dead-run-refuse' && /not running/.test(err.message),
  );
});

test('listRunSpendKeys ignores non-reservation entries', async t => {
  const spend = await fs.mkdtemp(path.join(os.tmpdir(), 'dead-run-spend-'));
  t.after(() => fs.rm(spend, { recursive: true, force: true }));
  const id = 'run-mix';
  await withSpendStore(store => {
    store.entries.keep = { day: '2026-10-20', lane: 'openrouter', runId: id, jobId: 'a', usd: 1, tokens: 0, kind: 'reservation', at: '2026-10-20T12:00:00.000Z', flagged: false };
    store.entries.other = { day: '2026-10-20', lane: 'openrouter', runId: 'else', jobId: 'b', usd: 1, tokens: 0, kind: 'reservation', at: '2026-10-20T12:00:00.000Z', flagged: false };
    store.entries.settled = { day: '2026-10-20', lane: 'openrouter', runId: id, jobId: 'c', usd: 1, tokens: 0, kind: 'actual', at: '2026-10-20T12:00:00.000Z', flagged: false };
  }, { dir: spend });
  assert.deepEqual(await listRunSpendKeys(spend, id), ['keep']);
});
