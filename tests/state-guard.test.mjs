// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertNotStateHolder,
  deletionsLogFile,
  holdsSwarmState,
  recordDeletion,
} from '../tools/state-guard.mjs';
import { collectProjectGcPlan, applyProjectGcPlan } from '../tools/gc.mjs';
import { scratchRootDir } from '../tools/claude-shell.mjs';
import { removeWorktreeCheckout } from '../tools/swarm/core-71.mjs';
import { runMerge, parseGitWorktreeListPorcelain } from '../tools/merge-guard.mjs';

test('holdsSwarmState: tickets.json under .swarm/project', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-tickets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await holdsSwarmState(dir, { fs }), false);
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(dir, '.swarm', 'project', 'tickets.json'), '{}');
  assert.equal(await holdsSwarmState(dir, { fs }), true);
});

test('holdsSwarmState: any entry under .swarm/runs', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-runs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.swarm', 'runs', 'r1'), { recursive: true });
  assert.equal(await holdsSwarmState(dir, { fs }), true);
});

test('holdsSwarmState: registry root match', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-reg-'));
  const registry = path.join(dir, 'projects.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(registry, JSON.stringify([{ id: 'p1', root: dir }]));
  assert.equal(await holdsSwarmState(dir, { fs, registryFile: registry }), true);
  const other = path.join(dir, 'other');
  await fs.mkdir(other);
  assert.equal(await holdsSwarmState(other, { fs, registryFile: registry }), false);
});

test('holdsSwarmState: .project-swarm.json ledger field', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-pointer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '.project-swarm.json'), JSON.stringify({ ledger: { root: '/elsewhere' } }));
  assert.equal(await holdsSwarmState(dir, { fs }), true);
});

test('assertNotStateHolder throws state-holder-refused', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-refuse-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.swarm', 'runs', 'x'), { recursive: true });
  await assert.rejects(
    assertNotStateHolder(dir, 'test-caller', { fs }),
    err => err.code === 'state-holder-refused' && /test-caller/.test(err.message),
  );
});

test('recordDeletion appends one JSON line with mode 0600', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-log-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await recordDeletion({ dir: '/tmp/x', caller: 'unit', outcome: 'allowed', home, env, now: () => new Date('2026-01-01T00:00:00.000Z') });
  const log = deletionsLogFile(home, env);
  const text = await fs.readFile(log, 'utf8');
  const row = JSON.parse(text.trim());
  assert.equal(row.caller, 'unit');
  assert.equal(row.outcome, 'allowed');
  const mode = (await fs.stat(log)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('gc scratch plan skips state-holding checkout', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-gc-plan-'));
  const scratchBase = path.join(home, 'scratch');
  const env = { ...process.env, SWARM_SCRATCH_ROOT: scratchBase, SWARM_TEST_TMP: process.env.SWARM_TEST_TMP };
  const project = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-gc-proj-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(scratchBase, { recursive: true });
  const holder = path.join(scratchBase, 'ledger-checkout');
  await fs.mkdir(holder, { recursive: true });
  await fs.mkdir(path.join(holder, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(holder, '.swarm', 'project', 'tickets.json'), '{"tickets":[]}');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(holder, old, old);
  const gitImpl = async (cwd, args) => {
    if (args[0] === 'status' && args[1] === '--porcelain') return '';
    if (args[0] === 'rev-parse') return 'HEAD\n';
    if (args[0] === 'log') return '';
    return '';
  };
  const plan = await collectProjectGcPlan(project, {
    env,
    home,
    includeScratch: true,
    olderThanDays: 0,
    nowMs: Date.now(),
    gitImpl,
    registryFile: path.join(home, 'empty-registry.json'),
  });
  assert.equal(scratchRootDir({ env, home }), scratchBase);
  assert.equal(plan.categories.scratch.some(row => row.path === holder), false);
});

test('gc apply refuses scratch removal for state holder and logs refusal', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-gc-apply-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps'), SWARM_SCRATCH_ROOT: path.join(home, 'scratch') };
  const project = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-gc-apply-proj-'));
  const holder = path.join(env.SWARM_SCRATCH_ROOT, 'keep-me');
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(holder, { recursive: true });
  await fs.mkdir(path.join(holder, '.swarm', 'runs', 'r1'), { recursive: true });
  const plan = {
    bases: [env.SWARM_SCRATCH_ROOT],
    categories: { finishedRuns: [], orphans: [], oldRunFolders: [], scratch: [{ path: holder, bytes: 1 }], untrackedArchives: [] },
  };
  await applyProjectGcPlan(project, plan, { env, home });
  await fs.access(holder);
  const log = await fs.readFile(deletionsLogFile(home, env), 'utf8');
  assert.match(log, /"outcome":"refused"/);
  assert.match(log, /gc\.applyScratch/);
});

test('removeWorktreeCheckout skips state-holding worktree', async t => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-core71-'));
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-core71-root-'));
  const worktree = path.join(home, 'wt');
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, '.project-swarm.json'), JSON.stringify({ ledger: { path: 'x' } }));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  let removed = false;
  const gitImpl = async () => { removed = true; return ''; };
  const res = await removeWorktreeCheckout(root, worktree, { gitImpl, env, home, caller: 'test' });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'state-holder');
  assert.equal(removed, false);
});

test('parseGitWorktreeListPorcelain reads branch lines', () => {
  const rows = parseGitWorktreeListPorcelain('worktree /a\nbranch refs/heads/feat\n\nworktree /b\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].branch, 'refs/heads/feat');
});

test('runMerge omits --delete-branch when head branch worktree holds state', async t => {
  const wtRoot = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sg-merge-wt-'));
  t.after(() => fs.rm(wtRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(wtRoot, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(wtRoot, '.swarm', 'project', 'tickets.json'), '{}');
  const porcelain = `worktree ${wtRoot}\nbranch refs/heads/feat\n\n`;
  const calls = [];
  const exec = async (command, args, opts = {}) => {
    calls.push({ command, args: [...args], cwd: opts.cwd });
    const key = [command, ...args].join(' ');
    const routes = {
      'gh repo view --json defaultBranchRef,nameWithOwner': { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'octo/repo' }), stderr: '' },
      'gh pr view 123 --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup': { code: 0, stdout: JSON.stringify({
        state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc123',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }), stderr: '' },
      'gh pr list --repo octo/repo --base feat --state open --json number': { code: 0, stdout: '[]', stderr: '' },
      'gh pr merge 123 --squash --match-head-commit abc123': { code: 0, stdout: '', stderr: '' },
      'gh api repos/octo/repo/branches/main/protection/required_status_checks': { code: 1, stdout: '', stderr: '404' },
      'gh api -X DELETE repos/octo/repo/git/refs/heads/feat': { code: 0, stdout: '', stderr: '' },
      'gh pr view 123 --json state': { code: 0, stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' },
      'git worktree list --porcelain': { code: 0, stdout: porcelain, stderr: '' },
      'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
      'git remote get-url origin': { code: 0, stdout: 'git@github.com:octo/repo.git\n', stderr: '' },
      'git status --porcelain': { code: 0, stdout: '', stderr: '' },
      'git fetch origin': { code: 0, stdout: '', stderr: '' },
      'git checkout main --': { code: 0, stdout: '', stderr: '' },
      'git pull --ff-only origin main': { code: 0, stdout: '', stderr: '' },
    };
    if (!routes[key]) return { code: 1, stdout: '', stderr: 'unexpected ' + key };
    return routes[key];
  };
  const r = await runMerge('/repo', ['123'], { exec, sleep: async () => {}, home: process.env.HOME });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  const mergeCall = calls.find(c => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(mergeCall);
  assert.equal(mergeCall.args.includes('--delete-branch'), false);
  assert.ok(calls.some(c => c.command === 'gh' && c.args[0] === 'api' && c.args[1] === '-X'));
});

test('runMerge uses --delete-branch when no state-holding worktree on head branch', async () => {
  const calls = [];
  const exec = async (command, args, opts = {}) => {
    calls.push({ command, args: [...args], cwd: opts.cwd });
    const key = [command, ...args].join(' ');
    const routes = {
      'gh repo view --json defaultBranchRef,nameWithOwner': { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'octo/repo' }), stderr: '' },
      'gh pr view 123 --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup': { code: 0, stdout: JSON.stringify({
        state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc123',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }), stderr: '' },
      'gh pr list --repo octo/repo --base feat --state open --json number': { code: 0, stdout: '[]', stderr: '' },
      'gh pr merge 123 --squash --delete-branch --match-head-commit abc123': { code: 0, stdout: '', stderr: '' },
      'gh pr view 123 --json state': { code: 0, stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' },
      'git worktree list --porcelain': { code: 0, stdout: '', stderr: '' },
      'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
      'git remote get-url origin': { code: 0, stdout: 'git@github.com:octo/repo.git\n', stderr: '' },
      'git status --porcelain': { code: 0, stdout: '', stderr: '' },
      'git fetch origin': { code: 0, stdout: '', stderr: '' },
      'git checkout main --': { code: 0, stdout: '', stderr: '' },
      'git pull --ff-only origin main': { code: 0, stdout: '', stderr: '' },
    };
    if (!routes[key]) return { code: 1, stdout: '', stderr: 'unexpected ' + key };
    return routes[key];
  };
  const r = await runMerge('/repo', ['123'], { exec, sleep: async () => {} });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, undefined);
  const mergeCall = calls.find(c => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(mergeCall.args.includes('--delete-branch'));
});
