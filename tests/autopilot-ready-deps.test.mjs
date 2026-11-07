// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyAutopilotDeps, sameRoot } from '../tools/autopilot-ready-deps.mjs';

const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'swarm.mjs');
const ROOT = '/tmp/project-a';
const OTHER = '/tmp/project-b';

function makeDeps(overrides = {}) {
  const spawnCalls = [];
  let lastSpawnChild = null;
  const spawnImpl = (execPath, args, opts) => {
    spawnCalls.push({ execPath, args, opts });
    const child = new EventEmitter();
    child.pid = overrides.spawnPid ?? 4242;
    lastSpawnChild = child;
    child.unref = function unref() { this.unrefed = true; };
    child.once = function once(event, fn) {
      if (event === 'error' && overrides.spawnAsyncError) {
        queueMicrotask(() => fn(overrides.spawnAsyncError));
      }
      if (event === 'exit') {
        child._exitListener = fn;
        if (overrides.spawnEarlyExit !== undefined) {
          const { code, signal } = overrides.spawnEarlyExit;
          queueMicrotask(() => fn(code, signal));
        }
      }
      return EventEmitter.prototype.once.call(this, event, fn);
    };
    if (overrides.spawnThrows) throw overrides.spawnThrows;
    return child;
  };
  const injected = {
    env: { TEST_ENV: '1' },
    memoryAware: false,
    spawnImpl,
    selfPid: 1000,
    waitStartScopeExitGrace: () => Promise.resolve(),
    liveBusyMarkers: async () => overrides.markers ?? [],
    listLiveRuns: async () => overrides.liveRuns ?? [],
    checkProjectCap: async () => overrides.capped ?? null,
    readTickets: async () => overrides.tickets ?? [],
    readPending: async () => overrides.pending ?? [],
    ...overrides.injected,
  };
  const deps = readyAutopilotDeps(ROOT, injected);
  return { deps, spawnCalls, injected, lastSpawnChild: () => lastSpawnChild };
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

test('startScope spawns detached swarm go --scope, unrefs, and sets SWARM_AUTOPILOT_PID', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-scope-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { deps, spawnCalls, lastSpawnChild } = makeDeps();
  const out = await deps.startScope({ root: dir });
  assert.equal(out.ok, true);
  assert.equal(out.pid, 4242);
  assert.equal(out.result, 'started go --scope (pid 4242)');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].execPath, process.execPath);
  assert.deepEqual(spawnCalls[0].args, [swarmEntry, '--root', path.resolve(dir), 'go', '--scope', '--max-jobs', '1']);
  assert.equal(spawnCalls[0].opts.detached, true);
  assert.ok(Array.isArray(spawnCalls[0].opts.stdio));
  assert.equal(spawnCalls[0].opts.stdio[0], 'ignore');
  assert.equal(spawnCalls[0].opts.stdio[1], 'ignore');
  assert.equal(typeof spawnCalls[0].opts.stdio[2], 'number');
  assert.equal(spawnCalls[0].opts.env.TEST_ENV, '1');
  assert.equal(spawnCalls[0].opts.env.SWARM_AUTOPILOT_PID, '1000');
  assert.equal(lastSpawnChild()?.unrefed, true);
});

test('startScope returns ok false when spawn throws', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-spawn-throw-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { deps } = makeDeps({ spawnThrows: new Error('spawn failed') });
  const out = await deps.startScope({ root: dir });
  assert.deepEqual(out, { ok: false, result: 'spawn failed' });
});

test('startScope returns ok false on an asynchronous spawn error', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-spawn-async-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { deps } = makeDeps({ spawnAsyncError: new Error('async spawn failed') });
  const out = await deps.startScope({ root: dir });
  assert.deepEqual(out, { ok: false, result: 'async spawn failed' });
});

test('startScope passes cwd as the resolved project root', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-cwd-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rel = path.join(dir, 'nested');
  await fs.mkdir(rel, { recursive: true });
  const { deps, spawnCalls } = makeDeps();
  await deps.startScope({ root: rel });
  assert.equal(spawnCalls[0].opts.cwd, path.resolve(rel));
});

test('startScope reports ok false with exit code and log tail when child exits quickly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-exit-code-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const logDir = path.join(dir, '.swarm', 'project');
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, 'go-scope-spawn.log');
  await fs.writeFile(logPath, 'earlier\nfatal: boom\n', 'utf8');
  const { deps } = makeDeps({
    spawnEarlyExit: { code: 2, signal: null },
    injected: { waitStartScopeExitGrace: () => new Promise(() => {}) },
  });
  const out = await deps.startScope({ root: dir, waitExitGrace: () => new Promise(() => {}) });
  assert.equal(out.ok, false);
  assert.match(out.result, /^exit code 2:/);
  assert.match(out.result, /fatal: boom/);
});

test('startScope reports ok false when child is killed by signal', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-exit-sig-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  const { deps } = makeDeps({
    spawnEarlyExit: { code: null, signal: 'SIGTERM' },
    injected: { waitStartScopeExitGrace: () => new Promise(() => {}) },
  });
  const out = await deps.startScope({ root: dir, waitExitGrace: () => new Promise(() => {}) });
  assert.equal(out.ok, false);
  assert.match(out.result, /^killed by SIGTERM/);
});

test('startScope treats bare exit callback with no code or signal as non-failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-exit-bare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { deps, lastSpawnChild } = makeDeps({
    spawnEarlyExit: { code: undefined, signal: undefined },
  });
  const out = await deps.startScope({ root: dir });
  assert.equal(out.ok, true);
  assert.equal(out.pid, 4242);
  assert.equal(lastSpawnChild()?.unrefed, true);
});

test('startScope resolves ok true when child does not exit within grace period', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ready-deps-grace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { deps, lastSpawnChild } = makeDeps();
  const out = await deps.startScope({ root: dir });
  assert.equal(out.ok, true);
  assert.equal(out.result, 'started go --scope (pid 4242)');
  assert.equal(lastSpawnChild()?.unrefed, true);
});

test('startScope does not spawn under hard memory pressure when memoryAware', async () => {
  const { deps, spawnCalls } = makeDeps({
    injected: {
      memoryAware: true,
      readMachine: async () => ({ availRamGb: 1, swapUsedGb: 0, swapTotalGb: 8, cores: 8 }),
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
