// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectId } from '../tools/projects.mjs';
import { boardSnapshot } from '../tools/board-data.mjs';
import { mainWorktreeRoot, projectSummary } from '../tools/project-spend.mjs';

const execFileAsync = promisify(execFile);

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-board-worktrees-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function git(cwd, args) { return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout; }
async function initRepo(dir) {
  await git(dir, ['init', '-q']);
  await git(dir, ['checkout', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.invalid']);
  await git(dir, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(dir, 'input.txt'), 'fixture\n');
  await git(dir, ['add', 'input.txt']);
  await git(dir, ['commit', '-qm', 'fixture']);
}
async function emptyPath(t) {
  const dir = await tempDir(t);
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}
async function addWorktree(t, root, branch) {
  const dir = await emptyPath(t);
  await git(root, ['worktree', 'add', '-q', '-b', branch, dir]);
  return await fs.realpath(dir);
}
async function writeRun(root, id, costUsd) {
  const dir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, jobs: [{ id: `job-${id}`, costUsd, usage: { total_tokens: 100 } }] }));
}

test('mainWorktreeRoot identifies linked worktrees and rejects the main checkout and non-git directories', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const worktree = await addWorktree(t, root, 'feature');
  const nonGit = await tempDir(t);
  assert.equal(await mainWorktreeRoot(root), null);
  assert.equal(await mainWorktreeRoot(nonGit), null);
  assert.equal(await mainWorktreeRoot(worktree), root);
});

test('worktree spend inherits the main profile cap, but an own pointer wins and its own runs reach the inherited cap', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const inherited = await addWorktree(t, root, 'inherited');
  const own = await addWorktree(t, root, 'own');
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 5 } } }));
  const config = path.join(path.dirname(root), 'config.json');
  await fs.writeFile(config, JSON.stringify({}));
  const env = { ...process.env, SWARM_CONFIG: config };

  const under = await projectSummary(inherited, { env, ttlMs: 0 });
  assert.equal(under.capUsd, 5);
  assert.equal(under.capInherited, true);
  assert.equal(under.inheritedFrom, root);
  assert.match(under.capSource, /inherited from .*$/);
  assert.equal(under.why, null);

  await fs.writeFile(path.join(own, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 7 } } }));
  const ownSummary = await projectSummary(own, { env, ttlMs: 0 });
  assert.equal(ownSummary.capUsd, 7);
  assert.equal(ownSummary.capInherited, false);
  assert.equal(ownSummary.inheritedFrom, null);
  assert.equal(ownSummary.capSource, 'profile budget.projectMaxUsd');

  await writeRun(inherited, 'run-a', 3);
  await writeRun(inherited, 'run-b', 2);
  const reached = await projectSummary(inherited, { env, ttlMs: 0 });
  assert.equal(reached.capUsd, 5);
  assert.match(reached.why, /^project-cap:/);
});

test('boardSnapshot groups registered worktrees while keeping the flat projects and machine totals', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const worktree = await addWorktree(t, root, 'feature');
  await writeRun(root, 'main-run', 1.25);
  await writeRun(worktree, 'worktree-run', 2.5);
  const main = { id: projectId(root), root, name: 'main' };
  const child = { id: projectId(worktree), root: worktree, name: 'feature' };
  const snapshot = await boardSnapshot({
    projects: [main, child],
    liveRuns: [],
    summary: async () => ({ capUsd: null, capSource: null, capInherited: false, inheritedFrom: null, why: null }),
  });
  const mainOverview = snapshot.projects.find(project => project.id === main.id);
  const childOverview = snapshot.projects.find(project => project.id === child.id);
  assert.equal(childOverview.parentId, main.id);
  assert.equal(childOverview.worktree, true);
  assert.deepEqual(mainOverview.worktreeIds, [child.id]);
  assert.deepEqual(snapshot.projects.map(project => project.id), [main.id, child.id]);
  for (const key of ['todayUsd', 'weekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) {
    assert.equal(snapshot.machine.cost[key], snapshot.projects.reduce((sum, project) => sum + project.cost[key], 0), key);
  }
});
