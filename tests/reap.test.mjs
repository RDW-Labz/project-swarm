// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reapStuckRuns } from '../tools/reap.mjs';
import { withSpendStore } from '../tools/spend.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function entry(overrides = {}) {
  return {
    day: '2026-11-06',
    lane: 'openrouter',
    runId: 'run-a',
    root: '/fixture',
    jobId: 'j',
    usd: 0.5,
    tokens: 10,
    kind: 'reservation',
    pid: 1,
    host: 'x',
    at: '2026-11-06T12:00:00.000Z',
    flagged: false,
    ...overrides,
  };
}

async function writeRun(root, runId, state, { mtimeMs } = {}) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
  if (mtimeMs !== undefined) await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('dry run reports a stale running run and changes nothing', async t => {
  const root = await tempRoot(t);
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const old = now - 3 * 60 * 60 * 1000;
  const state = {
    id: 'run-stale',
    status: 'running',
    jobs: [{ id: 'j1', status: 'running', startedAt: '2026-11-06T11:00:00.000Z' }],
  };
  await writeRun(root, 'run-stale', state, { mtimeMs: old });

  const before = await fs.readFile(path.join(root, '.swarm/runs/run-stale/state.json'), 'utf8');
  const out = await reapStuckRuns({
    roots: [root],
    olderThanMinutes: 120,
    liveRuns: [],
    now: () => now,
  });
  const after = await fs.readFile(path.join(root, '.swarm/runs/run-stale/state.json'), 'utf8');

  assert.equal(out.applied, false);
  assert.equal(out.stuck.length, 1);
  assert.deepEqual(out.stuck[0].jobs, ['j1']);
  assert.equal(before, after);
});

test('apply marks the run and active jobs failed and keeps other fields', async t => {
  const root = await tempRoot(t);
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const state = {
    id: 'run-apply',
    status: 'running',
    manifest: 'm.json',
    jobs: [
      { id: 'done', status: 'complete', finishedAt: '2026-11-06T10:00:00.000Z', costUsd: 1 },
      { id: 'run', status: 'running', startedAt: '2026-11-06T11:00:00.000Z' },
      { id: 'q', status: 'queued' },
    ],
  };
  await writeRun(root, 'run-apply', state, { mtimeMs: now - 3 * 60 * 60 * 1000 });

  const out = await reapStuckRuns({
    roots: [root],
    olderThanMinutes: 60,
    apply: true,
    liveRuns: [],
    now: () => now,
    deps: { unregisterLiveRun: async () => {}, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
  });
  assert.equal(out.applied, true);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/run-apply/state.json'), 'utf8'));
  assert.equal(saved.status, 'failed');
  assert.match(saved.error, /reaped: no progress/);
  assert.equal(saved.reapedAt, '2026-11-06T15:00:00.000Z');
  assert.equal(saved.manifest, 'm.json');
  assert.equal(saved.jobs.find(j => j.id === 'done').status, 'complete');
  assert.equal(saved.jobs.find(j => j.id === 'run').error, 'reaped: run stopped making progress');
  assert.equal(saved.jobs.find(j => j.id === 'q').status, 'failed');
});

test('a live run id is never reaped even when stale', async t => {
  const root = await tempRoot(t);
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  await writeRun(root, 'run-live', {
    id: 'run-live',
    status: 'running',
    jobs: [{ id: 'j', status: 'running', startedAt: '2026-11-06T11:00:00.000Z' }],
  }, { mtimeMs: now - 5 * 60 * 60 * 1000 });

  const out = await reapStuckRuns({
    roots: [root],
    liveRuns: ['run-live'],
    olderThanMinutes: 30,
    now: () => now,
  });
  assert.equal(out.stuck.length, 0);
});

test('recent job activity prevents reaping', async t => {
  const root = await tempRoot(t);
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  await writeRun(root, 'run-fresh', {
    id: 'run-fresh',
    status: 'running',
    jobs: [{ id: 'j', status: 'running', startedAt: '2026-11-06T11:00:00.000Z', lastActivity: '2026-11-06T14:30:00.000Z' }],
  }, { mtimeMs: now - 5 * 60 * 60 * 1000 });

  const out = await reapStuckRuns({
    roots: [root],
    liveRuns: [],
    olderThanMinutes: 120,
    now: () => now,
  });
  assert.equal(out.stuck.length, 0);
});

test('apply releases only reservation spend entries', async t => {
  const root = await tempRoot(t);
  const spend = await fs.mkdtemp(path.join(os.tmpdir(), 'reap-spend-'));
  t.after(() => fs.rm(spend, { recursive: true, force: true }));
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const resKey = 'res-key';
  const actualKey = 'actual-key';
  const costKey = 'cost-key';
  await withSpendStore(store => {
    store.entries[resKey] = entry({ kind: 'reservation' });
    store.entries[actualKey] = entry({ kind: 'actual' });
    store.entries[costKey] = entry({ kind: 'reserved-as-cost' });
  }, { dir: spend, now: () => now });

  await writeRun(root, 'run-spend', {
    id: 'run-spend',
    status: 'running',
    ledgerKeys: [resKey, actualKey, costKey],
    jobs: [{ id: 'j', status: 'running', spendKey: resKey, startedAt: '2026-11-06T11:00:00.000Z' }],
  }, { mtimeMs: now - 3 * 60 * 60 * 1000 });

  const out = await reapStuckRuns({
    roots: [root],
    apply: true,
    olderThanMinutes: 60,
    liveRuns: [],
    spendDir: spend,
    now: () => now,
    deps: { unregisterLiveRun: async () => {}, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
  });
  assert.deepEqual(out.released, [resKey]);
  const store = JSON.parse(await fs.readFile(path.join(spend, 'daily.json'), 'utf8'));
  assert.equal(store.entries[resKey], undefined);
  assert.ok(store.entries[actualKey]);
  assert.ok(store.entries[costKey]);
});

test('worktree remove runs only under the run worktrees path then prune', async t => {
  const root = await tempRoot(t);
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const good = path.join(root, '.swarm', 'worktrees', 'run-wt', 'job-a');
  const bad = path.join(root, '.swarm', 'workspaces', 'run-wt', 'job-b');
  const foreign = path.join(root, '.swarm', 'worktrees', 'other-run', 'job-c');
  // The real layout: ~/.project-swarm-scratch/worktrees/<project>-<hash>/<runId>/<job>.
  const real = path.join(root, 'scratch', 'worktrees', 'bot-fleet-57b285f39a1d', 'run-wt', '.attempts', 'job-d', '2');
  const prefixOnly = path.join(root, 'scratch', 'worktrees', 'bot-fleet-57b285f39a1d', 'run-wt-2', 'job-e');
  await fs.mkdir(real, { recursive: true });
  await fs.mkdir(prefixOnly, { recursive: true });
  await fs.mkdir(good, { recursive: true });
  await fs.mkdir(bad, { recursive: true });
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(good, 'marker'), 'x');
  await fs.writeFile(path.join(foreign, 'marker'), 'x');

  const calls = [];
  await writeRun(root, 'run-wt', {
    id: 'run-wt',
    status: 'running',
    jobs: [
      { id: 'a', status: 'running', worktreePath: good, startedAt: '2026-11-06T11:00:00.000Z' },
      { id: 'b', status: 'running', keptWorkspace: bad, startedAt: '2026-11-06T11:00:00.000Z' },
      { id: 'c', status: 'running', worktreePath: foreign, startedAt: '2026-11-06T11:00:00.000Z' },
      { id: 'd', status: 'running', worktreePath: real, startedAt: '2026-11-06T11:00:00.000Z' },
      { id: 'e', status: 'running', worktreePath: prefixOnly, startedAt: '2026-11-06T11:00:00.000Z' },
    ],
  }, { mtimeMs: now - 3 * 60 * 60 * 1000 });

  await reapStuckRuns({
    roots: [root],
    apply: true,
    olderThanMinutes: 60,
    liveRuns: [],
    now: () => now,
    deps: {
      unregisterLiveRun: async () => {},
      git: async (cwd, args) => {
        calls.push({ cwd, args: [...args] });
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });

  assert.deepEqual(calls.filter(c => c.args[0] === 'worktree' && c.args[1] === 'remove'), [
    { cwd: root, args: ['worktree', 'remove', '--force', good] },
    { cwd: root, args: ['worktree', 'remove', '--force', real] },
  ]);
  assert.deepEqual(calls.filter(c => c.args[1] === 'prune'), [{ cwd: root, args: ['worktree', 'prune'] }]);
});

test('corrupt state.json is recorded and the next run is still reaped', async t => {
  const root = await tempRoot(t);
  const now = Date.parse('2026-11-06T15:00:00.000Z');
  const badDir = path.join(root, '.swarm', 'runs', 'run-bad');
  await fs.mkdir(badDir, { recursive: true });
  await fs.writeFile(path.join(badDir, 'state.json'), '{not json');
  await writeRun(root, 'run-good', {
    id: 'run-good',
    status: 'running',
    jobs: [{ id: 'j', status: 'queued', startedAt: '2026-11-06T11:00:00.000Z' }],
  }, { mtimeMs: now - 3 * 60 * 60 * 1000 });

  const out = await reapStuckRuns({
    roots: [root],
    olderThanMinutes: 60,
    apply: true,
    liveRuns: [],
    now: () => now,
    deps: { unregisterLiveRun: async () => {}, git: async () => ({ code: 0, stdout: '', stderr: '' }) },
  });
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].runId, 'run-bad');
  assert.equal(out.stuck.some(s => s.runId === 'run-good'), true);
  assert.equal(out.applied, true);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/run-good/state.json'), 'utf8'));
  assert.equal(saved.status, 'failed');
});

test('swarm reap CLI: dry run by default, --apply and --all-projects are passed through, bad flags refused', async () => {
  const { runReapCommand } = await import('../tools/reap.mjs');
  const calls = [];
  const deps = {
    listProjects: async () => [{ root: '/a' }, { root: '/b' }, { root: '/a' }],
    reapStuckRuns: async options => { calls.push(options); return { stuck: [{ root: '/a', runId: 'r1', minutes: 200, jobs: ['j'] }], released: [], removedWorktrees: [], errors: [] }; },
  };
  const dry = await runReapCommand([], { root: '/here', deps });
  assert.deepEqual(calls[0], { roots: ['/here'], olderThanMinutes: 120, apply: false });
  assert.match(dry.stdout, /stuck r1 in \/a: no progress for 200 min[\s\S]*Dry run\. Add --apply/);
  await runReapCommand(['--apply', '--all-projects', '--older-than', '180'], { root: '/here', deps });
  assert.deepEqual(calls[1], { roots: ['/a', '/b'], olderThanMinutes: 180, apply: true });
  assert.equal((await runReapCommand(['--older-than', '5'], { root: '/here', deps })).exitCode, 2);
  assert.equal((await runReapCommand(['--force'], { root: '/here', deps })).exitCode, 2);
});
