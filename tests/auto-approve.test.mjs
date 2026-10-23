// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
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
  trustedRepositoryUrl,
  normalizeGitRemoteUrl,
  policyCommandShellBlocked,
  headDescendsFromGranted,
  POLICY_STATS_UNREADABLE,
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
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'state'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'design'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'review'), { recursive: true });
  await fs.mkdir(path.join(root, 'jobs', 'wave'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'orchestrator-mode'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'orchestrator-mode', 'off'), '');
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/plan.md'), '# plan\n');
  await exec('git', ['add', 'docs/scope/plan.md'], { cwd: root });
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  const hooksDir = path.join(root, '.git', 'hooks');
  try {
    for (const name of await fs.readdir(hooksDir)) {
      if (!name.endsWith('.sample')) await fs.rm(path.join(hooksDir, name));
    }
  } catch { /* no hooks */ }
  return root;
}

function writeTrustedRepository(url) {
  const policyFile = path.join(path.dirname(process.env.SWARM_CONFIG), 'policy.json');
  fsSync.writeFileSync(policyFile, `${JSON.stringify({
    rules: [{ id: POLICY_ID, enabled: true, repository: url }],
  }, null, 2)}\n`);
}

async function addOrigin(root, name = 'origin', url = root) {
  await exec('git', ['remote', 'add', name, url], { cwd: root });
  if (name === 'origin') {
    const out = await exec('git', ['remote', 'get-url', 'origin'], { cwd: root });
    writeTrustedRepository(normalizeGitRemoteUrl(out.stdout.trim()));
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
    'coordination/HANDOFF.md',
    'coordination/review/r.md',
    '.swarm/project/tickets.json',
    'jobs/wave/manifest.json',
  ];
  for (const f of ok) assert.equal(isSwarmAdminHandbuildPath(f, { root }), true, f);
  assert.equal(isSwarmAdminHandbuildPath('coordination/manifests/w.json', { root }), false);
  assert.equal(isSwarmAdminHandbuildPath('.project-swarm.json', { root }), false);
  assert.equal(isSwarmAdminHandbuildPath('jobs/wave/manifest.md', { root }), false);
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
    files: 'docs/scope/plan.md',
    minutes: 30,
    git: 'commit',
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  const check = handbuildPolicyGuardCheck(root, {
    command: 'git commit -m x',
    approvals: [req],
    policyGitOps: [{ tool: 'git', sub: 'commit', rest: ['-m', 'x'] }],
    branch: 'feat/other',
    head: req.policyHead,
    now: T0(),
  });
  assert.equal(check.ok, false);
  assert.equal(headDescendsFromGranted(root, 'deadbeef', { cwd: root }), false);
  await exec('git', ['commit', '--allow-empty', '-m', 'child'], { cwd: root });
  assert.ok(headDescendsFromGranted(root, req.policyHead, { cwd: root }));
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

test('security (5): worktree commands denied under policy', async t => {
  const root = await tempRepo(t, 'swarm/wt');
  const home = process.env.HOME;
  assert.equal(policyGitWorktreeAllowed(['worktree', 'prune'], { root, home }), false);
  assert.equal(policyGitWorktreeAllowed(['worktree', 'add', path.join(home, '.project-swarm-scratch', 'x'), '-b', 'feat/x'], { root, home }), false);
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
    files: 'docs/scope/plan.md',
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
    files: ['docs/scope/plan.md'],
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
    files: 'docs/scope/plan.md',
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
    files: 'docs/scope/plan.md',
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

test('guard: auto-approved write in window', async t => {
  const root = await tempRepo(t);
  createRequest(root, {
    kind: 'tiny',
    reason: 'write manifest via policy',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  const d = guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(root, 'docs/scope/plan.md'), content: '# x\n' },
    root,
    cwd: root,
    now: T0,
  });
  assert.equal(d.allow, true);
  assert.ok(d.approval);
});

test('branch name in command cannot override git state for push guard', async t => {
  const root = await tempRepo(t, 'feat/truth');
  await addOrigin(root);
  const d = guardBash(root, 'git push origin swarm/fake-branch', 'feat/truth');
  assert.equal(d.allow, false);
});

test('finding 1: denied policy push verdict and owner+policy guard check', async t => {
  const root = await tempRepo(t, 'feat/policy-push');
  await addOrigin(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const owner = createRequest(root, {
    kind: 'tiny',
    reason: 'owner approval for unrelated source file',
    files: 'src/owner-only.ts',
    minutes: 30,
    git: 'commit',
  }, { now: T0 });
  assert.equal(owner.status, 'pending');
  decideRequest(root, owner.id, 'approve', { now: T0, by: 'owner' });
  const policy = createRequest(root, {
    kind: 'tiny',
    reason: 'policy push window for scope doc',
    files: 'docs/scope/plan.md',
    minutes: 30,
    git: 'push',
  }, { now: T0 });
  assert.equal(policy.status, 'approved');
  const denied = guardBash(root, 'git push --force origin feat/policy-push', 'feat/policy-push');
  assert.equal(denied.allow, false);
  const check = handbuildPolicyGuardCheck(root, {
    command: 'git push origin feat/policy-push',
    approvals: [owner, policy],
    policyGitOps: [{ tool: 'git', sub: 'push', rest: ['origin', 'feat/policy-push'] }],
    cwd: root,
    now: T0(),
  });
  assert.equal(check?.ok, true);
});

test('finding 2: origin trust is policy-only exact match', async t => {
  const root = await tempRepo(t, 'feat/origin');
  await exec('git', ['remote', 'add', 'origin', root], { cwd: root });
  await fs.writeFile(path.join(root, '.project-swarm.json'), `${JSON.stringify({ repository: 'github.com/evil/fake' })}\n`);
  assert.equal(originIsProjectRepository(root), false);
  const trusted = normalizeGitRemoteUrl(root);
  writeTrustedRepository(trusted);
  assert.ok(originIsProjectRepository(root));
  assert.equal(trustedRepositoryUrl(), trusted);
});

test('finding 5: session blocks writes under .git', async t => {
  const root = await tempRepo(t);
  const d = guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(root, '.git', 'config'), content: 'x' },
    root,
    cwd: root,
    now: T0,
  });
  assert.equal(d.allow, false);
});

test('finding 6: policy git context uses command cwd', async t => {
  const root = await tempRepo(t, 'feat/cwd');
  const sub = path.join(root, 'docs', 'scope');
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'policy window for scope doc in subfolder',
    files: 'docs/scope/plan.md',
    minutes: 30,
    git: 'commit',
  }, { now: T0 });
  const check = handbuildPolicyGuardCheck(root, {
    command: 'git commit -m x',
    approvals: [req],
    policyGitOps: [{ tool: 'git', sub: 'commit', rest: ['-m', 'x'] }],
    cwd: sub,
    branch: 'feat/wrong',
    now: T0(),
  });
  assert.equal(check.ok, false);
});

test('finding 3: policy path blocks env and wrappers', async t => {
  assert.ok(policyCommandShellBlocked('GIT_DIR=/tmp/x git status'));
  assert.ok(policyCommandShellBlocked('env git status'));
  assert.ok(policyCommandShellBlocked('git -C /tmp/x status'));
  assert.ok(policyCommandShellBlocked('cd src && git status'));
});

test('finding 4: git config and pushurl rewrites block push', async t => {
  const root = await tempRepo(t, 'feat/pushmap');
  const branch = 'feat/pushmap';
  await addOrigin(root);
  await exec('git', ['config', 'remote.origin.pushurl', 'https://evil.example/x'], { cwd: root });
  assert.equal(policyGitPushAllowed(['push', 'origin', branch], { root, currentBranch: branch }), false);
});

test('finding 7: unreadable stats block auto-approve', async t => {
  const root = await tempRepo(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, STATS_FILE), 'not-json');
  const pending = createRequest(root, {
    kind: 'tiny',
    reason: 'stats corrupt should not auto approve',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(pending.status, 'pending');
});

test('finding 8: kill switch and git op list at execution', async t => {
  const root = await tempRepo(t, 'feat/kill');
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'policy commit window for scope',
    files: 'docs/scope/plan.md',
    minutes: 30,
    git: 'commit',
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, HB_AUTO_OFF), '');
  const off = handbuildPolicyGuardCheck(root, {
    command: 'git commit -m x',
    approvals: [req],
    policyGitOps: [{ tool: 'git', sub: 'push', rest: ['origin', 'feat/kill'] }],
    now: T0(),
  });
  assert.equal(off.ok, false);
  const wrongOp = handbuildPolicyGuardCheck(root, {
    command: 'git commit -m x',
    approvals: [{ ...req, git: ['commit'] }],
    policyGitOps: [{ tool: 'git', sub: 'push', rest: ['origin', 'feat/kill'] }],
    now: T0(),
  });
  await fs.rm(path.join(root, HB_AUTO_OFF));
  assert.equal(wrongOp.ok, false);
});

test('finding 10: commit then push within HEAD ancestry window', async t => {
  const root = await tempRepo(t, 'feat/seq');
  await addOrigin(root);
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'commit and push sequence on policy branch',
    files: 'docs/scope/plan.md',
    minutes: 30,
    git: 'commit,push',
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  await exec('git', ['commit', '--allow-empty', '-m', 'step'], { cwd: root });
  assert.ok(headDescendsFromGranted(root, req.policyHead, { cwd: root }));
  assert.ok(policyGitPushAllowed(['push', 'origin', 'feat/seq'], { root, currentBranch: 'feat/seq' }));
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
