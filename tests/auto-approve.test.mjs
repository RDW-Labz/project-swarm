// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  evaluateHandbuildAutoApprove,
  isSwarmAdminHandbuildPath,
  policyGitCommitAllowed,
  policyGitPushAllowed,
  policyGitSwitchAllowed,
  policyGitWorktreeAllowed,
  policyBranchAllowed,
  originIsProjectRepository,
  AUTO_OFF_FILE,
  POLICY_ID,
  MAX_POLICY_MINUTES,
  MAX_POLICY_FILES,
  DEFAULT_MAX_ACTIONS_PER_WINDOW,
  headOf,
  branchOf,
} from '../tools/auto-approve-policy.mjs';
import {
  createRequest,
  decideRequest,
  listRequests,
  readHandbuildStats,
  bumpHandbuildStats,
  handbuildStatsJson,
  guardDecision,
  LOG_FILE,
  STATS_FILE,
  AUTO_OFF_FILE as HB_AUTO_OFF,
  handbuildPolicyGuardCheck,
  recordPolicyGuardAllow,
} from '../tools/handbuild.mjs';
import { orchestratorModeCommandAllowed } from '../tools/shell-writes.mjs';
import { cleanupTestProject } from './_isolate-config.mjs';

const exec = promisify(execFile);
const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const T0 = () => Date.UTC(2026, 9, 22, 12, 0, 0);

async function tempRepo(t, branch = 'feat/auto-policy') {
  const base = process.env.SWARM_TEST_TMP || os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'auto-ap-')));
  t.after(async () => {
    await cleanupTestProject(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  await exec('git', ['init', '-q', '-b', 'main', root]);
  if (branch !== 'main') await exec('git', ['checkout', '-q', '-b', branch], { cwd: root });
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/plan.md'), '# plan\n');
  await exec('git', ['add', 'docs/scope/plan.md'], { cwd: root });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

async function addOrigin(root, name = 'origin', url = root) {
  await exec('git', ['remote', 'add', name, url], { cwd: root });
  if (name === 'origin') {
    await fs.writeFile(path.join(root, '.project-swarm.json'), `${JSON.stringify({ repository: url })}\n`);
  }
}

function guardBash(root, command, branch = 'feat/auto-policy') {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    return guardDecision({
      tool: 'Bash',
      toolInput: { command },
      root,
      cwd: root,
      now: T0,
      branchOf: () => branch,
    });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
}

test('policy paths: allowed admin files and rejects', async t => {
  const root = await tempRepo(t);
  const ok = [
    'docs/scope/plan.md',
    'docs/plans/ideas.md',
    'docs/state/x.md',
    'docs/design/note.md',
    'coordination/manifests/w.json',
    'coordination/HANDOFF.md',
    'coordination/review/r.md',
    '.project-swarm.json',
    '.swarm/project/tickets.json',
    'jobs/wave/manifest.json',
  ];
  for (const f of ok) assert.equal(isSwarmAdminHandbuildPath(f, { root }), true, f);
  assert.equal(isSwarmAdminHandbuildPath('docs/design/app.mjs', { root }), false);
  assert.equal(isSwarmAdminHandbuildPath('tools/handbuild.mjs', { root }), false);
});

test('security (1): push only to origin for this repository', async t => {
  const root = await tempRepo(t, 'swarm/policy-git');
  const branch = 'swarm/policy-git';
  await addOrigin(root, 'origin', root);
  await addOrigin(root, 'evil', root);
  assert.ok(originIsProjectRepository(root));
  assert.ok(policyGitPushAllowed(['push', 'origin', branch], { root, currentBranch: branch }));
  assert.equal(policyGitPushAllowed(['push', 'evil', branch], { root, currentBranch: branch }), false);
  assert.equal(policyGitPushAllowed(['push', 'origin', 'main'], { root, currentBranch: branch }), false);
  assert.equal(policyGitPushAllowed(['push', 'origin', '+swarm/policy-git'], { root, currentBranch: branch }), false);
  assert.equal(policyGitPushAllowed(['push', 'origin', `${branch}:other`], { root, currentBranch: branch }), false);
});

test('security (2): refuse bare push and git config overrides', async t => {
  const root = await tempRepo(t, 'feat/push');
  await addOrigin(root);
  const branch = 'feat/push';
  assert.equal(policyGitPushAllowed(['push'], { root, currentBranch: branch }), false);
  assert.equal(policyGitPushAllowed(['push', '-u', 'origin', branch], { root, currentBranch: branch }), false);
  assert.equal(policyGitCommitAllowed(['-c', 'core.sshCommand=id', 'commit', '-m', 'x'], { root, currentBranch: branch }), false);
});

test('security (3): branch and HEAD binding at execution', async t => {
  const root = await tempRepo(t, 'feat/bind');
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'coordination manifest update only',
    files: 'coordination/manifests/w.json',
    minutes: 30,
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  const check = handbuildPolicyGuardCheck(root, {
    command: 'git commit -m x',
    approvals: [req],
    policyOps: [{ tool: 'git', sub: 'commit', rest: ['-m', 'x'] }],
    branch: 'feat/other',
    head: req.policyHead,
    now: T0(),
  });
  assert.equal(check.ok, false);
  const checkHead = handbuildPolicyGuardCheck(root, {
    command: 'git commit -m x',
    approvals: [req],
    policyOps: [{ tool: 'git', sub: 'commit', rest: ['-m', 'x'] }],
    branch: req.policyBranch,
    head: 'deadbeef',
    now: T0(),
  });
  assert.equal(checkHead.ok, false);
});

test('security (4): switch only on clean tree; checkout paths denied', async t => {
  const root = await tempRepo(t, 'feat/switch');
  await fs.writeFile(path.join(root, 'docs/scope/dirty.md'), 'x\n');
  assert.equal(policyGitSwitchAllowed(['switch', 'feat/other'], { root, currentBranch: 'feat/switch' }), false);
  assert.equal(policyGitSwitchAllowed(['switch', '-c', 'feat/new'], { root, currentBranch: 'feat/switch' }), false);
  assert.equal(policyGitSwitchAllowed(['checkout', 'feat/new'], { root, currentBranch: 'feat/switch' }), false);
  assert.equal(policyGitSwitchAllowed(['checkout', '--', 'docs/scope/plan.md'], { root, currentBranch: 'feat/switch' }), false);
  assert.equal(policyGitSwitchAllowed(['switch', '--force', 'feat/other'], { root, currentBranch: 'feat/switch' }), false);
});

test('security (5): worktree prune and remove --force denied', async t => {
  const root = await tempRepo(t, 'swarm/wt');
  const home = process.env.HOME;
  assert.equal(policyGitWorktreeAllowed(['worktree', 'prune'], { root, home }), false);
  assert.equal(policyGitWorktreeAllowed(['worktree', 'remove', '--force', path.join(home, '.project-swarm-scratch', 'x')], { root, home }), false);
});

test('security (6): commit amend and hook-skipping forms denied', async t => {
  const root = await tempRepo(t, 'swarm/commit');
  const branch = 'swarm/commit';
  assert.ok(policyGitCommitAllowed(['commit', '-m', 'msg'], { root, currentBranch: branch }));
  assert.equal(policyGitCommitAllowed(['commit', '--amend', '-m', 'msg'], { root, currentBranch: branch }), false);
  assert.equal(policyGitCommitAllowed(['commit', '--no-verify', '-m', 'x'], { root, currentBranch: branch }), false);
  assert.equal(policyGitCommitAllowed(['commit', '-C', 'HEAD'], { root, currentBranch: branch }), false);
  assert.equal(policyGitCommitAllowed(['commit', '--reuse-message=HEAD'], { root, currentBranch: branch }), false);
});

test('security (7): per-window and per-day rate limits', async t => {
  const root = await tempRepo(t);
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'scope doc tweak for limits',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  for (let i = 0; i < DEFAULT_MAX_ACTIONS_PER_WINDOW; i += 1) {
    const rec = recordPolicyGuardAllow(root, { approvalId: req.id, files: ['docs/scope/plan.md'], rule: 'test' }, { now: T0 });
    assert.equal(rec.blocked, false);
  }
  const blocked = recordPolicyGuardAllow(root, { approvalId: req.id, files: ['docs/scope/plan.md'], rule: 'test' }, { now: T0 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'window-actions');
});

test('security (8): stats and log protected; policy allows are logged', async t => {
  const root = await tempRepo(t);
  createRequest(root, {
    kind: 'tiny',
    reason: 'write manifest via policy',
    files: 'coordination/manifests/g.json',
    minutes: 30,
  }, { now: T0 });
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    const d = guardDecision({
      tool: 'Write',
      toolInput: { file_path: STATS_FILE, content: '{}' },
      root,
      cwd: root,
      now: T0,
    });
    assert.equal(d.allow, false);
    const d2 = guardDecision({
      tool: 'Write',
      toolInput: { file_path: LOG_FILE, content: 'x' },
      root,
      cwd: root,
      now: T0,
    });
    assert.equal(d2.allow, false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
  recordPolicyGuardAllow(root, {
    approvalId: listRequests(root)[0].id,
    files: ['coordination/manifests/g.json'],
    rule: 'git-commit',
    command: 'git commit -m x',
    branch: 'feat/auto-policy',
    head: headOf(root),
  }, { now: T0 });
  const log = (await fs.readFile(path.join(root, LOG_FILE), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(e => e.event === 'policy-allowed' && e.rule === 'git-commit' && e.branch));
});

test('createRequest auto-approves admin window and logs', async t => {
  const root = await tempRepo(t);
  const r = createRequest(root, {
    kind: 'tiny',
    reason: 'coordination manifest update only',
    files: 'coordination/manifests/w.json',
    minutes: 45,
    git: 'commit,push',
  }, { now: T0 });
  assert.equal(r.status, 'approved');
  assert.equal(r.policyId, POLICY_ID);
  assert.equal(r.autoApproved, true);
  const log = (await fs.readFile(path.join(root, LOG_FILE), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  const ev = log.find(e => e.event === 'auto-approved');
  assert.ok(ev);
  assert.equal(ev.branch, 'feat/auto-policy');
  assert.ok(ev.head);
  assert.equal(readHandbuildStats(root, { now: T0 }).autoApproved, 1);
});

test('kill switch and non-admin pending', async t => {
  const root = await tempRepo(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, HB_AUTO_OFF), '');
  const blocked = createRequest(root, {
    kind: 'tiny',
    reason: 'manifest only while switch on',
    files: 'coordination/manifests/x.json',
    minutes: 30,
  }, { now: T0 });
  assert.equal(blocked.status, 'pending');
  await fs.rm(path.join(root, HB_AUTO_OFF));
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/scope/a.md'], minutes: 61, git: [] }).ok, false);
  const many = Array.from({ length: MAX_POLICY_FILES + 1 }, (_, i) => `docs/scope/f${i}.md`);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: many, minutes: 30, git: [] }).ok, false);
});

test('orchestrator mode does not allow policy git writes', async t => {
  const root = await tempRepo(t, 'feat/om-git');
  await addOrigin(root);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(orchestratorModeCommandAllowed('git commit -m "manifest"', { root, cwd: root }), false);
    assert.equal(orchestratorModeCommandAllowed('git push origin HEAD', { root, cwd: root }), false);
    assert.equal(orchestratorModeCommandAllowed('git switch -c feat/other', { root, cwd: root }), false);
    assert.equal(orchestratorModeCommandAllowed('git status', { root, cwd: root }), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('guard subprocess: auto-approved write in window', async t => {
  const root = await tempRepo(t);
  createRequest(root, {
    kind: 'tiny',
    reason: 'write manifest via policy',
    files: 'coordination/manifests/g.json',
    minutes: 30,
  }, { now: T0 });
  const run = input => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  const out = run({
    session_id: 's',
    cwd: root,
    tool_name: 'Write',
    tool_input: { file_path: 'coordination/manifests/g.json', content: '{}\n' },
  });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('branch name in command cannot override git state for push guard', async t => {
  const root = await tempRepo(t, 'feat/truth');
  await addOrigin(root);
  const d = guardBash(root, 'git push origin swarm/fake-branch', 'feat/truth');
  assert.equal(d.allow, false);
});

test('stats: ownerTerminal vs autoApproved', async t => {
  const root = await tempRepo(t);
  bumpHandbuildStats(root, 'ownerTerminal', { now: T0 });
  createRequest(root, {
    kind: 'tiny',
    reason: 'scope doc tweak for stats',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  const stats = JSON.parse(handbuildStatsJson(root, { now: T0 }));
  assert.equal(stats.autoApproved, 1);
  assert.equal(stats.ownerTerminal, 1);
});
