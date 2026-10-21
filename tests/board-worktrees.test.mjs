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
import { checkProjectCap, mainWorktreeRoot, projectSpend, projectSummary, worktreeFamily } from '../tools/project-spend.mjs';

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
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, jobs: [{ id: `job-${id}`, agent: 'anthropic', costUsd, usage: { total_tokens: 100 } }] }));
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

test('one project cap covers the main checkout and every linked worktree', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const worktree = await addWorktree(t, root, 'inherited');
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 4 } } }));
  const config = path.join(path.dirname(root), 'config.json');
  await fs.writeFile(config, JSON.stringify({}));
  const env = { ...process.env, SWARM_CONFIG: config };

  await writeRun(root, 'main-run', 3);
  await writeRun(worktree, 'worktree-run', 2);
  const mainSpent = await projectSpend(root);
  const worktreeSpent = await projectSpend(worktree);
  assert.equal(mainSpent.usd, 5);
  assert.equal(worktreeSpent.usd, 5);
  assert.deepEqual(mainSpent.trees.map(tree => tree.root), [root, worktree]);
  assert.deepEqual(worktreeSpent.trees.map(tree => tree.root), [root, worktree]);

  const mainDecision = await checkProjectCap(root, { env });
  const worktreeDecision = await checkProjectCap(worktree, { env });
  for (const decision of [mainDecision, worktreeDecision]) {
    assert.equal(decision.reason, 'project-cap');
    assert.match(decision.message, /been billed \$5\.00 \(list value \$5\.00 across 2 runs\)/);
    assert.match(decision.message, /only metered lanes/);
  }
  const reached = await projectSummary(worktree, { env, ttlMs: 0 });
  assert.equal(reached.spendUsd, 5);
  assert.equal(reached.billedUsd, 5);
  assert.equal(reached.treeUsd, 2);
  assert.equal(reached.sharedTrees, 2);
  assert.equal(reached.reached, true);

  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 10 } } }));
  assert.equal(await checkProjectCap(root, { env }), null);
  assert.equal(await checkProjectCap(worktree, { env }), null);
  const under = await projectSummary(worktree, { env, ttlMs: 0 });
  assert.equal(under.capUsd, 10);
  assert.equal(under.capInherited, true);
  assert.equal(under.inheritedFrom, root);
  assert.match(under.capSource, /inherited from .*$/);
  assert.equal(under.why, null);

  const second = await addWorktree(t, root, 'second');
  await writeRun(second, 'second-run', 1);
  assert.equal((await projectSpend(root)).usd, 6);
  assert.equal((await projectSpend(worktree)).usd, 6);
});

test('a worktree pointer wins over the main profile pointer', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const own = await addWorktree(t, root, 'own');
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 5 } } }));
  const config = path.join(path.dirname(root), 'config.json');
  await fs.writeFile(config, JSON.stringify({}));
  const env = { ...process.env, SWARM_CONFIG: config };
  await fs.writeFile(path.join(own, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 7 } } }));
  const ownSummary = await projectSummary(own, { env, ttlMs: 0 });
  assert.equal(ownSummary.capUsd, 7);
  assert.equal(ownSummary.capInherited, false);
  assert.equal(ownSummary.inheritedFrom, null);
  assert.equal(ownSummary.capSource, 'profile budget.projectMaxUsd');
});

test('boardSnapshot groups registered worktrees while keeping the flat projects and machine totals', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const worktree = await addWorktree(t, root, 'feature');
  await writeRun(root, 'main-run', 3);
  await writeRun(worktree, 'worktree-run', 2);
  const main = { id: projectId(root), root, name: 'main' };
  const child = { id: projectId(worktree), root: worktree, name: 'feature' };
  const snapshot = await boardSnapshot({
    projects: [main, child],
    liveRuns: [],
  });
  const mainOverview = snapshot.projects.find(project => project.id === main.id);
  const childOverview = snapshot.projects.find(project => project.id === child.id);
  assert.equal(childOverview.parentId, main.id);
  assert.equal(childOverview.worktree, true);
  assert.deepEqual(mainOverview.worktreeIds, [child.id]);
  assert.deepEqual(snapshot.projects.map(project => project.id), [main.id, child.id]);
  assert.equal(mainOverview.spend.familyUsd, 5);
  assert.equal(childOverview.spend.familyUsd, 5);
  assert.equal(mainOverview.spend.sharedTrees, 2);
  assert.equal(childOverview.spend.sharedTrees, 2);
  for (const key of ['todayUsd', 'weekUsd', 'allUsd', 'paidUsd', 'paidEstimatedUsd', 'flatRateListUsd']) {
    assert.equal(snapshot.machine.cost[key], snapshot.projects.reduce((sum, project) => sum + project.cost[key], 0), key);
  }
});

test('a plain repository keeps the old spend totals and has one tree', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  await writeRun(root, 'plain-run', 1.25);
  const spent = await projectSpend(root);
  assert.equal(spent.usd, 1.25);
  assert.equal(spent.runs, 1);
  assert.equal(spent.trees.length, 1);
  assert.equal(spent.trees[0].root, root);
});

test('a job worktree under SWARM_SCRATCH_ROOT is excluded from the family but counted when scratch env points elsewhere', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const scratchDir = await tempDir(t);
  const otherScratch = await tempDir(t);
  const jobPath = path.join(scratchDir, 'job-worktree');
  await fs.mkdir(scratchDir, { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-b', 'swarm-scratch-job', jobPath]);
  const jobRoot = await fs.realpath(jobPath);

  const excluded = await worktreeFamily(root, { env: { SWARM_SCRATCH_ROOT: scratchDir } });
  assert.deepEqual(excluded, [root]);

  const included = await worktreeFamily(root, { env: { SWARM_SCRATCH_ROOT: otherScratch } });
  assert.deepEqual(included, [root, jobRoot]);
});

test('worktree metadata under .swarm is ignored so a swarm job worktree is not counted twice', async t => {
  const root = await tempDir(t);
  await initRepo(root);
  const swarmWorktree = path.join(root, '.swarm', 'job-worktree');
  await fs.mkdir(path.dirname(swarmWorktree), { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-b', 'swarm-job', swarmWorktree]);
  await writeRun(root, 'main-run', 3);
  const spent = await projectSpend(root);
  assert.equal(spent.usd, 3);
  assert.deepEqual(spent.trees.map(tree => tree.root), [root]);
});
