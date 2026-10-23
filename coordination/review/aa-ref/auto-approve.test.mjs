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
  policyGitSwitchCheckoutAllowed,
  policyBranchAllowed,
  AUTO_OFF_FILE,
  POLICY_ID,
  MAX_POLICY_MINUTES,
  MAX_POLICY_FILES,
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
  AUTO_OFF_FILE as HB_AUTO_OFF,
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
  assert.equal(isSwarmAdminHandbuildPath('docs/scope/../tools/x.mjs', { root }), false);
});

test('forgery: traversal, wildcards, mixed code, unicode docs case', async t => {
  const root = await tempRepo(t);
  const files = ['docs/scope/a.md'];
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/scope/../tools/x.mjs'], minutes: 30, git: [] }).ok, false);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/scope/*.md'], minutes: 30, git: [] }).ok, false);
  assert.throws(() => createRequest(root, {
    kind: 'tiny',
    reason: 'blocked path pattern in request',
    files: 'docs/scope/**',
    minutes: 30,
  }, { now: T0 }), /not specific enough/);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: [...files, 'src/leak.ts'], minutes: 30, git: [] }).ok, false);
  assert.equal(isSwarmAdminHandbuildPath('Docs/Scope/x.md', { root }), false);
  await fs.mkdir(path.join(root, 'Docs', 'Scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'Docs/Scope/x.md'), 'x\n');
  assert.equal(isSwarmAdminHandbuildPath('Docs/Scope/x.md', { root }), false);
});

test('symlink escape into tools is not admin path', async t => {
  const root = await tempRepo(t);
  await fs.mkdir(path.join(root, 'docs', 'scope', 'trap'), { recursive: true });
  const target = path.join(root, 'tools', 'secret.mjs');
  await fs.writeFile(target, '//\n');
  const link = path.join(root, 'docs', 'scope', 'trap', 'link.md');
  try {
    await fs.symlink(target, link);
  } catch {
    t.skip('symlink not permitted');
    return;
  }
  assert.equal(isSwarmAdminHandbuildPath('docs/scope/trap/link.md', { root }), false);
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
  assert.equal(ev.policyId, POLICY_ID);
  assert.equal(ev.minutes, 45);
  assert.equal(ev.branch, 'feat/auto-policy');
  assert.ok(listRequests(root).some(x => x.id === r.id && x.status === 'approved'));
  assert.equal(readHandbuildStats(root, { now: T0 }).autoApproved, 1);
});

test('kill switch, window limits, and non-admin pending', async t => {
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
  const pending = createRequest(root, {
    kind: 'tiny',
    reason: 'needs real handbuild for code',
    files: 'tools/x.mjs',
    minutes: 30,
  }, { now: T0 });
  assert.equal(pending.status, 'pending');
});

test('stats: ownerTerminal vs autoApproved', async t => {
  const root = await tempRepo(t);
  bumpHandbuildStats(root, 'ownerTerminal', { now: T0 });
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'scope doc tweak for stats',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  const stats = JSON.parse(handbuildStatsJson(root, { now: T0 }));
  assert.equal(stats.autoApproved, 1);
  assert.equal(stats.ownerTerminal, 1);
  const pending = createRequest(root, {
    kind: 'tiny',
    reason: 'pending for owner approve stat',
    files: 'tools/y.mjs',
    minutes: 30,
  }, { now: T0 });
  decideRequest(root, pending.id, 'approve', { now: T0, by: 'owner', channel: 'cli' });
  assert.equal(readHandbuildStats(root, { now: T0 }).ownerTerminal, 2);
});

test('git policy: allowed commit/push and denials', async t => {
  const root = await tempRepo(t, 'swarm/policy-git');
  const branch = 'swarm/policy-git';
  assert.ok(policyBranchAllowed(branch));
  assert.ok(policyGitCommitAllowed(['commit', '-m', 'msg'], { root, currentBranch: branch }));
  assert.ok(policyGitCommitAllowed(['commit', '--amend', '-m', 'msg'], { root, currentBranch: branch }));
  assert.equal(policyGitCommitAllowed(['commit', '--no-verify', '-m', 'x'], { root, currentBranch: branch }), false);
  await exec('git', ['remote', 'add', 'origin', root], { cwd: root });
  assert.ok(policyGitPushAllowed(['push', 'origin', 'HEAD'], { root, currentBranch: branch }));
  assert.ok(policyGitPushAllowed(['push'], { root, currentBranch: branch }));
  assert.equal(policyGitPushAllowed(['push', 'origin', '+swarm/policy-git'], { root, currentBranch: branch }), false);
  assert.equal(policyGitPushAllowed(['push', 'https://evil.example/x.git', 'HEAD'], { root, currentBranch: branch }), false);
  assert.equal(policyGitPushAllowed(['push', 'origin', 'main'], { root, currentBranch: branch }), false);
  assert.equal(policyGitCommitAllowed(['-c', 'core.sshCommand=id', 'commit', '-m', 'x'], { root, currentBranch: branch }), false);
});

test('branch name in command cannot override git state for push guard', async t => {
  const root = await tempRepo(t, 'feat/truth');
  await exec('git', ['remote', 'add', 'origin', root], { cwd: root });
  const d = guardBash(root, 'git push origin swarm/fake-branch', 'feat/truth');
  assert.equal(d.allow, false);
});

test('orchestrator mode allows policy git on feat branch', async t => {
  const root = await tempRepo(t, 'feat/om-git');
  await exec('git', ['remote', 'add', 'origin', root], { cwd: root });
  const ctx = { root, cwd: root };
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(orchestratorModeCommandAllowed('git commit -m "manifest"', ctx), true);
    assert.equal(orchestratorModeCommandAllowed('git push origin HEAD', ctx), true);
    assert.equal(orchestratorModeCommandAllowed('git switch -c feat/other', ctx), true);
    assert.equal(orchestratorModeCommandAllowed('git merge main', ctx), false);
    assert.equal(orchestratorModeCommandAllowed('git push origin +feat/om-git', ctx), false);
    assert.equal(orchestratorModeCommandAllowed('git checkout -- tools/x.mjs', ctx), false);
    assert.equal(orchestratorModeCommandAllowed('git commit --no-verify -m x', ctx), false);
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

test('orchestrator cannot create auto-off kill switch file', async t => {
  const root = await tempRepo(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    const d = guardDecision({
      tool: 'Write',
      toolInput: { file_path: AUTO_OFF_FILE, content: '' },
      root,
      cwd: root,
      now: T0,
    });
    assert.equal(d.allow, false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});
