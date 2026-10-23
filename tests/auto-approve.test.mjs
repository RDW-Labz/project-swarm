// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  evaluateHandbuildAutoApprove,
  isSwarmAdminHandbuildPath,
  isPolicyWindowFileEntry,
  policyFilePath,
  POLICY_STATS_UNREADABLE,
  AUTO_OFF_FILE,
  POLICY_ID,
  MAX_POLICY_MINUTES,
  MAX_POLICY_FILES,
  DEFAULT_MAX_ACTIONS_PER_WINDOW,
  DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY,
  STATS_INITIALIZED_FILE,
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
import { isSelfApprovalCommand } from '../tools/self-approval.mjs';
import { cleanupTestProject } from './_isolate-config.mjs';

const exec = promisify(execFile);
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const T0 = () => Date.UTC(2026, 9, 22, 12, 0, 0);
const ORCHESTRATOR_TEST_MARKER_BODY = 'project-swarm-orchestrator-mode-test-harness-v1';

async function tempRepo(t) {
  const base = process.env.SWARM_TEST_TMP || os.tmpdir();
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'auto-ap-')));
  t.after(async () => {
    await cleanupTestProject(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'state'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'design'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination', 'review'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'orchestrator-mode'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'orchestrator-mode', 'off'), '');
  await fs.writeFile(path.join(root, '.swarm', 'orchestrator-mode', 'test-harness-signed'), ORCHESTRATOR_TEST_MARKER_BODY);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', path.basename(STATS_INITIALIZED_FILE)), `${POLICY_ID}\n`);
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', 'stats.json'), '{}\n');
  await fs.writeFile(path.join(root, 'docs/scope/plan.md'), '# plan\n');
  await exec('git', ['add', 'docs/scope/plan.md'], { cwd: root });
  await exec('git', ['commit', '-q', '-m', 'init', '--author', 't <t@t>'], { cwd: root });
  return root;
}

function guardBash(root, command) {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    return guardDecision({
      tool: 'Bash',
      toolInput: { command },
      root,
      cwd: root,
      now: T0,
    });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
}

test('exact window entries: folder and extensionless paths rejected', async t => {
  const root = await tempRepo(t);
  assert.equal(isPolicyWindowFileEntry('docs/scope/'), false);
  assert.equal(isPolicyWindowFileEntry('docs/scope'), false);
  assert.equal(isPolicyWindowFileEntry('docs/scope/plan'), false);
  assert.equal(isPolicyWindowFileEntry('docs/scope/plan.md'), true);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/scope/'], minutes: 30 }).ok, false);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/scope/plan.md', 'docs/plans/'], minutes: 30 }).ok, false);
});

test('allowed paths and blocked areas', async t => {
  const root = await tempRepo(t);
  for (const f of [
    'docs/scope/plan.md',
    'docs/plans/ideas.md',
    'docs/state/x.yaml',
    'docs/design/note.txt',
    'coordination/handoff-agent.md',
  ]) {
    assert.equal(isSwarmAdminHandbuildPath(f, { root }), true, f);
  }
  for (const f of [
    'coordination/review/r.md',
    'coordination/manifests/w.json',
    '.project-swarm.json',
    'docs/design/app.mjs',
    'tools/handbuild.mjs',
    '.swarm/project/tickets.json',
  ]) {
    assert.equal(isSwarmAdminHandbuildPath(f, { root }), false, f);
  }
});

test('write-time re-check rejects disallowed extension at guard', async t => {
  const root = await tempRepo(t);
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'policy window for scope markdown only',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(req.status, 'approved');
  assert.equal(isSwarmAdminHandbuildPath('docs/scope/evil.mjs', { root }), false);
  const bad = handbuildPolicyGuardCheck(root, {
    approvals: [req],
    files: ['docs/scope/evil.mjs'],
    now: T0(),
  });
  assert.equal(bad?.ok, false);
});

test('symlinked ancestor rejected for policy paths', async t => {
  const root = await tempRepo(t);
  const scopeLink = path.join(root, 'docs', 'scope-link');
  await fs.symlink(path.join(root, 'docs', 'scope'), scopeLink);
  assert.equal(isSwarmAdminHandbuildPath('docs/scope-link/plan.md', { root }), false);
});

test('per-window rate limit', async t => {
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

test('stats and handbuild paths protected from writes', async t => {
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
    assert.equal(guardDecision({
      tool: 'Write',
      toolInput: { file_path: path.join(root, STATS_FILE), content: '{}' },
      root,
      cwd: root,
      now: T0,
    }).allow, false);
    assert.equal(guardDecision({
      tool: 'Write',
      toolInput: { file_path: path.join(root, LOG_FILE), content: 'x' },
      root,
      cwd: root,
      now: T0,
    }).allow, false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

test('createRequest auto-approves admin window', async t => {
  const root = await tempRepo(t);
  const r = createRequest(root, {
    kind: 'tiny',
    reason: 'coordination manifest update only',
    files: 'docs/scope/plan.md',
    minutes: 45,
  }, { now: T0 });
  assert.equal(r.status, 'approved');
  assert.equal(r.policyId, POLICY_ID);
  assert.equal(r.autoApproved, true);
  const log = (await fs.readFile(path.join(root, LOG_FILE), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(e => e.event === 'auto-approved'));
  assert.equal(readHandbuildStats(root, { now: T0 }).autoApproved, 1);
});

test('kill switch and validation bounds', async t => {
  const root = await tempRepo(t);
  await fs.writeFile(path.join(root, HB_AUTO_OFF), '');
  const blocked = createRequest(root, {
    kind: 'tiny',
    reason: 'manifest only while switch on',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(blocked.status, 'pending');
  await fs.rm(path.join(root, HB_AUTO_OFF));
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/scope/a.md'], minutes: 61 }).ok, false);
  const many = Array.from({ length: MAX_POLICY_FILES + 1 }, (_, i) => `docs/scope/f${i}.md`);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: many, minutes: 30 }).ok, false);
});

test('policy window does not auto-approve git commit', async t => {
  const root = await tempRepo(t);
  createRequest(root, {
    kind: 'tiny',
    reason: 'policy window for scope doc only',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  const d = guardBash(root, 'git commit -m "manifest"');
  assert.equal(d.allow, false);
});

test('orchestrator mode still blocks git writes', async t => {
  const root = await tempRepo(t);
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    assert.equal(orchestratorModeCommandAllowed('git commit -m "manifest"', { root, cwd: root }), false);
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

test('unreadable stats block auto-approve', async t => {
  const root = await tempRepo(t);
  await fs.writeFile(path.join(root, STATS_FILE), 'not-json');
  const pending = createRequest(root, {
    kind: 'tiny',
    reason: 'stats corrupt should not auto approve',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(pending.status, 'pending');
});

test('missing stats after initialized marker blocks auto-approve', async t => {
  const root = await tempRepo(t);
  await fs.rm(path.join(root, STATS_FILE), { force: true });
  const pending = createRequest(root, {
    kind: 'tiny',
    reason: 'deleted stats should not reset counters',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(pending.status, 'pending');
});

test('policy file path ignores SWARM_POLICY_FILE without signed harness', () => {
  const cfgDir = path.dirname(process.env.SWARM_CONFIG);
  const evil = path.join(cfgDir, 'evil-policy.json');
  fsSync.writeFileSync(evil, `${JSON.stringify({ rules: [{ id: POLICY_ID, limits: { maxActionsPerWindow: 1 } }] })}\n`);
  const prev = process.env.SWARM_POLICY_FILE;
  process.env.SWARM_POLICY_FILE = evil;
  try {
    assert.equal(policyFilePath(), path.join(process.env.HOME, '.config', 'project-swarm', 'policy.json'));
  } finally {
    if (prev === undefined) delete process.env.SWARM_POLICY_FILE;
    else process.env.SWARM_POLICY_FILE = prev;
    fsSync.rmSync(evil, { force: true });
  }
});

test('kill switch blocks policy write at execution', async t => {
  const root = await tempRepo(t);
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'policy write window for scope',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  await fs.writeFile(path.join(root, HB_AUTO_OFF), '');
  const killed = guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(root, 'docs/scope/plan.md'), content: '# x\n' },
    root,
    cwd: root,
    now: T0,
  });
  assert.equal(killed.allow, false);
  await fs.rm(path.join(root, HB_AUTO_OFF));
  const check = handbuildPolicyGuardCheck(root, { approvals: [req], files: ['docs/scope/plan.md'], now: T0() });
  assert.equal(check?.ok, true);
});

test('daily auto-approve window cap', async t => {
  const root = await tempRepo(t);
  createRequest(root, {
    kind: 'tiny',
    reason: 'write scope under policy window',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  for (let i = 1; i < DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY; i += 1) {
    createRequest(root, {
      kind: 'tiny',
      reason: `extra policy window number ${i}`,
      files: 'docs/scope/plan.md',
      minutes: 5,
    }, { now: T0 });
  }
  const capped = createRequest(root, {
    kind: 'tiny',
    reason: 'one more policy window should be capped',
    files: 'docs/scope/plan.md',
    minutes: 5,
  }, { now: T0 });
  assert.equal(capped.status, 'pending');
});

test('ambiguous overlapping policy windows denied', async t => {
  const root = await tempRepo(t);
  const a = createRequest(root, {
    kind: 'tiny',
    reason: 'first overlapping policy window',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  const b = createRequest(root, {
    kind: 'tiny',
    reason: 'second overlapping policy window',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  assert.equal(a.status, 'approved');
  assert.equal(b.status, 'approved');
  const check = handbuildPolicyGuardCheck(root, {
    approvals: [a, b],
    files: ['docs/scope/plan.md'],
    now: T0(),
  });
  assert.equal(check?.ok, false);
});

test('standing swarm merge alone skips policy guard; git combo does not', async t => {
  const root = await tempRepo(t);
  const policyPath = path.join(path.dirname(process.env.SWARM_CONFIG), 'policy.json');
  fsSync.writeFileSync(policyPath, `${JSON.stringify({ rules: [{ id: 'merge-swarm-pr', enabled: true }] })}\n`);
  createRequest(root, {
    kind: 'tiny',
    reason: 'policy window alongside standing merge',
    files: 'docs/scope/plan.md',
    minutes: 30,
  }, { now: T0 });
  const mergeOnly = guardDecision({
    tool: 'Bash',
    toolInput: { command: 'swarm merge 12' },
    root,
    cwd: root,
    now: T0,
  });
  assert.equal(mergeOnly.allow, true);
  assert.equal(mergeOnly.standing, 'merge-swarm-pr');
  const combo = guardDecision({
    tool: 'Bash',
    toolInput: { command: 'swarm merge 12 && git commit -m x' },
    root,
    cwd: root,
    now: T0,
  });
  assert.equal(combo.allow, false);
});

test('SAFE_SWARM: full-segment match and compound commands', () => {
  assert.equal(isSelfApprovalCommand('echo ok; swarm handbuild status'), false);
  assert.equal(isSelfApprovalCommand('swarm handbuild status'), false);
  assert.equal(isSelfApprovalCommand('swarm handbuild status; echo x'), false);
});

test('session cannot write home gitconfig or ssh config', async t => {
  const root = await tempRepo(t);
  const home = process.env.HOME;
  const d = guardDecision({
    tool: 'Bash',
    toolInput: { command: `echo x > ${home}/.gitconfig` },
    root,
    cwd: root,
    now: T0,
    home,
  });
  assert.equal(d.allow, false);
  const d2 = guardDecision({
    tool: 'Bash',
    toolInput: { command: `echo x > ${home}/.ssh/config` },
    root,
    cwd: root,
    now: T0,
    home,
  });
  assert.equal(d2.allow, false);
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

test('swarm handbuild git subcommand removed', async t => {
  const root = await tempRepo(t);
  try {
    await exec(process.execPath, [SWARM_MJS, 'handbuild', 'git', 'status'], { cwd: root });
    assert.fail('expected non-zero exit');
  } catch (e) {
    assert.match(String(e.stdout ?? ''), /Usage: swarm handbuild/i);
    assert.doesNotMatch(String(e.stdout ?? ''), /handbuild git/i);
  }
});
