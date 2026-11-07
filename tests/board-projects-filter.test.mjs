// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectId } from '../tools/projects.mjs';
import { boardSnapshot, isTestOrTempProject } from '../tools/board-data.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';

const now = Date.UTC(2026, 9, 21, 15, 0, 0);
const iso = value => new Date(value).toISOString();

function project(root, name = path.basename(root), extra = {}) {
  return { id: projectId(root), root, name, ...extra };
}

async function runState(root, runId, state) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: runId, jobs: [], ...state }));
}

test('test/temp filtering keeps a live scratch project, hides idle scratch projects, and shows badges on toggle', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-filter-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const liveRoot = path.join(home, 'live-scratch');
  await runState(liveRoot, 'live', { status: 'running', startedAt: iso(now - 1000) });
  const real = Array.from({ length: 4 }, (_, i) => project(`/workspace/real-${i}`, `real-${i}`, { pinned: true }));
  const live = project(liveRoot, 'live-scratch');
  const hidden = Array.from({ length: 25 }, (_, i) => project(`/tmp/board-filter-${i}`, `test-${i}`));
  const all = [...real, live, ...hidden];
  const file = path.join(home, 'projects.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: all }));
  const api = createBoardApi({
    env: { ...process.env, SWARM_PROJECTS_FILE: file, SWARM_CONFIG: path.join(home, 'missing.json') },
    now: () => now,
    live: async () => [{ runId: 'live', root: liveRoot, pid: process.pid, startedAt: iso(now - 1000) }],
    cacheMs: 0,
    listPeers: async () => [],
  });
  t.after(() => api.close());
  const shown = await api.snapshot({ local: true });
  assert.equal(shown.projects.length, 5);
  assert.ok(shown.projects.some(item => item.id === live.id));
  const expanded = await api.snapshot({ local: true, scratch: true });
  assert.equal(expanded.projects.length, 30);
  assert.equal(expanded.projects.filter(item => item.testOrTemp).length, 25);
  assert.equal(expanded.scratch.total, 25);
});

test('isTestOrTempProject protects live, recent, approved-open, and pinned projects', () => {
  const root = '/tmp/board-filter/project';
  const facts = { isScratchRoot: true, approvedLedger: false, openTickets: false, spendUsd: 0 };
  assert.equal(isTestOrTempProject(project(root), facts), true);
  for (const extra of [{ live: true }, { recentRun: true }, { approvedLedger: true, openTickets: true }]) {
    assert.equal(isTestOrTempProject(project(root), { ...facts, ...extra }), false);
  }
  assert.equal(isTestOrTempProject(project(root, 'p', { pinned: true }), facts), false);
  assert.equal(isTestOrTempProject(project('/workspace/idle'), { hasScope: false, recentRun: false, openTickets: false, spendUsd: 0 }), true);
  assert.equal(isTestOrTempProject(project('/workspace/scoped'), { scopeFile: true }), false);
});

test('snapshot orders active, blocked, then idle projects with a stable name tie', async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-order-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const roots = ['active', 'blocked', 'idle-z', 'idle-a'].map(name => path.join(home, name));
  await runState(roots[0], 'active-run', { status: 'running', startedAt: iso(now - 1000) });
  const projects = roots.map(name => project(name, path.basename(name)));
  const liveRoot = roots[0];
  const summary = async root => root === roots[1] ? { spendUsd: 1, reached: true, capUsd: 1 } : { spendUsd: 0, capUsd: null };
  const snapshot = await boardSnapshot({
    projects,
    liveRuns: [{ runId: 'active-run', root: liveRoot, startedAt: iso(now - 1000) }],
    now,
    summary,
  });
  assert.deepEqual(snapshot.projects.map(item => item.name), ['active', 'blocked', 'idle-a', 'idle-z']);
});

test('a parent card counts live runs from its main checkout and two worktrees', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-family-')));
  const childA = path.join(root, 'child-a');
  const childB = path.join(root, 'child-b');
  const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-other-')));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(other, { recursive: true, force: true })]));
  await Promise.all([
    runState(root, 'main-run', { status: 'running', startedAt: iso(now - 3000) }),
    runState(childA, 'child-a-run', { status: 'running', startedAt: iso(now - 2000) }),
    runState(childB, 'child-b-run', { status: 'paused', startedAt: iso(now - 1000) }),
    runState(other, 'other-run', { status: 'running', startedAt: iso(now - 1000) }),
  ]);
  const main = project(root, 'main');
  const a = project(childA, 'child-a');
  const b = project(childB, 'child-b');
  const unrelated = project(other, 'other');
  const liveRuns = [
    { runId: 'main-run', root },
    { runId: 'child-a-run', root: childA },
    { runId: 'child-b-run', root: childB },
    { runId: 'other-run', root: other },
  ];
  const snapshot = await boardSnapshot({
    projects: [main, a, b, unrelated],
    liveRuns,
    now,
    worktreeRoot: candidate => candidate === childA || candidate === childB ? root : null,
  });
  const parent = snapshot.projects.find(item => item.id === main.id);
  assert.equal(parent.liveCount, 3);
  assert.deepEqual(parent.live.map(item => item.runId).sort(), ['child-a-run', 'child-b-run', 'main-run']);
  assert.equal(snapshot.projects.find(item => item.id === unrelated.id).liveCount, 1);
});
