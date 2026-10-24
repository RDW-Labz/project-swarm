// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyAutopilotDeps, sameRoot } from '../tools/autopilot-ready-deps.mjs';

const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'swarm.mjs');
const ROOT = '/tmp/project-a';
const OTHER = '/tmp/project-b';

function makeDeps(overrides = {}) {
  const spawnCalls = [];
  const spawnImpl = (execPath, args, opts) => {
    spawnCalls.push({ execPath, args, opts });
    const child = {
      pid: 4242,
      unref() { this.unrefed = true; },
      once(event, fn) {
        if (event === 'error' && overrides.spawnAsyncError) {
          queueMicrotask(() => fn(overrides.spawnAsyncError));
        }
      },
    };
    if (overrides.spawnThrows) throw overrides.spawnThrows;
    return child;
  };
  const injected = {
    env: { TEST_ENV: '1' },
    memoryAware: false,
    spawnImpl,
    selfPid: 1000,
    liveBusyMarkers: async () => overrides.markers ?? [],
    listLiveRuns: async () => overrides.liveRuns ?? [],
    checkProjectCap: async () => overrides.capped ?? null,
    readTickets: async () => overrides.tickets ?? [],
    readPending: async () => overrides.pending ?? [],
    ...overrides.injected,
  };
  const deps = readyAutopilotDeps(ROOT, injected);
  return { deps, spawnCalls, injected };
}

test('readyTickets returns only ready tickets from readTickets', async () => {
  const tickets = [
    { id: 'T-1', status: 'ready', files: ['a.ts'] },
    { id: 'T-2', status: 'todo', files: ['b.ts'] },
    { id: 'T-3', status: 'ready', file: 'c.ts' },
  ];
  const { deps } = makeDeps({ tickets });
  const ready = await deps.readyTickets(ROOT);
  assert.deepEqual(ready.map(t => t.id), ['T-1', 'T-3']);
  assert.deepEqual(ready[0].files, ['a.ts']);
  assert.deepEqual(ready[1].files, ['c.ts']);
});

test('pendingApprovals merges hand-build pending and readPending with files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-hb-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(dir, '.swarm', 'handbuild', 'state.json'), `${JSON.stringify({
    version: 1,
    requests: {
      r1: { id: 'r1', status: 'pending', files: ['hand.ts'], kind: 'tiny', reason: 'test', minutes: 10, requestedAt: '2030-01-01T00:00:00.000Z', requestedBy: 'owner' },
      r2: { id: 'r2', status: 'approved', files: ['skip.ts'], kind: 'tiny', reason: 'test', minutes: 10, requestedAt: '2030-01-01T00:00:00.000Z', requestedBy: 'owner' },
    },
  })}\n`);
  const { deps } = makeDeps({ pending: [{ status: 'pending', files: ['proposed.ts'] }] });
  const approvals = await deps.pendingApprovals(dir);
  assert.deepEqual(approvals, [
    { status: 'pending', files: ['hand.ts'] },
    { status: 'pending', files: ['proposed.ts'] },
  ]);
});

test('busyMarkers drops selfPid and other project roots', async () => {
  const markers = [
    { pid: 1000, root: ROOT, command: 'swarm go' },
    { pid: 2000, root: ROOT, command: 'swarm run' },
    { pid: 3000, root: OTHER, command: 'swarm go' },
  ];
  const { deps } = makeDeps({ markers });
  const busy = await deps.busyMarkers();
  assert.deepEqual(busy.map(m => m.pid), [2000]);
});

test('liveRuns keeps only runs for this project root', async () => {
  const liveRuns = [
    { runId: 'r1', root: ROOT },
    { runId: 'r2', root: OTHER },
    { runId: 'r3', root: path.resolve(ROOT) },
  ];
  const { deps } = makeDeps({ liveRuns });
  const live = await deps.liveRuns(ROOT);
  assert.deepEqual(live.map(r => r.runId), ['r1', 'r3']);
});

test('capRoom is false when checkProjectCap reports capped', async () => {
  const open = makeDeps({ capped: null });
  assert.equal(await open.deps.capRoom(ROOT), true);
  const capped = makeDeps({ capped: { reason: 'project-cap', message: 'full' } });
  assert.equal(await capped.deps.capRoom(ROOT), false);
});

test('startScope spawns detached swarm go --scope and unrefs', async () => {
  const { deps, spawnCalls } = makeDeps();
  const out = await deps.startScope({ root: ROOT });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'started go --scope (pid 4242)');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].execPath, process.execPath);
  assert.deepEqual(spawnCalls[0].args, [swarmEntry, '--root', path.resolve(ROOT), 'go', '--scope', '--max-jobs', '1']);
  assert.equal(spawnCalls[0].opts.detached, true);
  assert.deepEqual(spawnCalls[0].opts.stdio, 'ignore');
  assert.equal(spawnCalls[0].opts.env.TEST_ENV, '1');
});

test('startScope returns ok false when spawn throws', async () => {
  const { deps } = makeDeps({ spawnThrows: new Error('spawn failed') });
  const out = await deps.startScope({ root: ROOT });
  assert.deepEqual(out, { ok: false, result: 'spawn failed' });
});

test('startScope returns ok false on an asynchronous spawn error', async () => {
  const { deps } = makeDeps({ spawnAsyncError: new Error('async spawn failed') });
  const out = await deps.startScope({ root: ROOT });
  assert.deepEqual(out, { ok: false, result: 'async spawn failed' });
});

test('startScope passes cwd as the resolved project root', async () => {
  const { deps, spawnCalls } = makeDeps();
  await deps.startScope({ root: './relative-root' });
  assert.equal(spawnCalls[0].opts.cwd, path.resolve('./relative-root'));
});

test('startScope does not spawn under hard memory pressure when memoryAware', async () => {
  const { deps, spawnCalls } = makeDeps({
    injected: {
      memoryAware: true,
      readMachine: async () => ({ memTotal: 1e9, memAvailable: 1 }),
    },
  });
  const out = await deps.startScope({ root: ROOT });
  assert.deepEqual(out, { ok: true, result: 'held-memory' });
  assert.equal(spawnCalls.length, 0);
});

test('sameRoot is false for non-string roots and matches symlinked paths', async t => {
  assert.equal(sameRoot(null, ROOT), false);
  assert.equal(sameRoot(ROOT, 42), false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-root-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'link');
  await fs.symlink(dir, link);
  assert.equal(sameRoot(dir, link), true);
  assert.equal(sameRoot('/definitely/missing/root-a', '/definitely/missing/root-b'), false);
  assert.equal(sameRoot('/definitely/missing/root-a', '/definitely/missing/root-a'), true);
});
