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
  fold,
  isSwarmAdminHandbuildPath,
  isPolicyWindowFileEntry,
  policyFilePath,
  machinePolicyJsonPath,
  mergeStandingPolicyJsonPath,
  canonicalPolicyRel,
  POLICY_STATS_UNREADABLE,
  AUTO_OFF_FILE,
  POLICY_ID,
  MAX_POLICY_MINUTES,
  MAX_POLICY_FILES,
  DEFAULT_MAX_ACTIONS_PER_WINDOW,
  DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY,
  STATS_INITIALIZED_FILE,
  DOCS_STATE_READER_DENIED_BASENAMES,
  policyWindowParentDirSafe,
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
  STATE_FILE,
  STATS_FILE,
  AUTO_OFF_FILE as HB_AUTO_OFF,
  MERGE_BLOCKED_REASON,
  handbuildPolicyGuardCheck,
  recordPolicyGuardAllow,
  handbuildStatsInitialized,
  applyPolicyGuardedAllow,
  verifyPolicyWriteQueue,
  POLICY_INTEGRITY_ALERT_FILE,
} from '../tools/handbuild.mjs';
import { orchestratorModeCommandAllowed } from '../tools/shell-writes.mjs';
import { isSelfApprovalCommand } from '../tools/self-approval.mjs';
import { cleanupTestProject } from './_isolate-config.mjs';

const exec = promisify(execFile);
const SWARM_MJS = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const SHELL_WRITES_SRC = fsSync.readFileSync(new URL('../tools/shell-writes.mjs', import.meta.url), 'utf8');
const HANDBUILD_SRC = fsSync.readFileSync(new URL('../tools/handbuild.mjs', import.meta.url), 'utf8');
const T0 = () => Date.UTC(2026, 9, 22, 12, 0, 0);
const ORCHESTRATOR_TEST_MARKER_BODY = 'project-swarm-orchestrator-mode-test-harness-v1';
const PLAN = 'docs/state/plan.md';

async function tempRepo(t, { signed = true } = {}) {
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
  if (signed) await fs.writeFile(path.join(root, '.swarm', 'orchestrator-mode', 'test-harness-signed'), ORCHESTRATOR_TEST_MARKER_BODY);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', path.basename(STATS_INITIALIZED_FILE)), `${POLICY_ID}\n`);
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', 'stats.json'), '{}\n');
  await fs.writeFile(path.join(root, PLAN), '# plan\n');
  await exec('git', ['add', PLAN], { cwd: root });
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

function guardWrite(root, rel) {
  return guardDecision({
    tool: 'Write',
    toolInput: { file_path: path.join(root, rel), content: '# x\n' },
    root,
    cwd: root,
    now: T0,
  });
}

function windowRequest(root, files = PLAN, extra = {}) {
  return createRequest(root, {
    kind: 'tiny',
    reason: 'policy window for plain notes only',
    files,
    minutes: 30,
    ...extra,
  }, { now: T0 });
}

async function rewriteWindowFiles(root, id, files) {
  const file = path.join(root, STATE_FILE);
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.requests[id].files = files;
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

function policyJsonPath() {
  return path.join(path.dirname(process.env.SWARM_CONFIG), 'policy.json');
}

test('exact window entries: folder and extensionless paths rejected', async t => {
  const root = await tempRepo(t);
  assert.equal(isPolicyWindowFileEntry('docs/state/'), false);
  assert.equal(isPolicyWindowFileEntry('docs/state'), false);
  assert.equal(isPolicyWindowFileEntry('docs/state/plan'), false);
  assert.equal(isPolicyWindowFileEntry(PLAN), true);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/state/'], minutes: 30 }).ok, false);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: [PLAN, 'docs/design/'], minutes: 30 }).ok, false);
});

test('allowed paths and blocked areas', async t => {
  const root = await tempRepo(t);
  for (const f of [
    PLAN,
    'docs/state/x.csv',
    'docs/state/note.txt',
  ]) {
    assert.equal(isSwarmAdminHandbuildPath(f, { root }), true, f);
  }
  for (const f of [
    'docs/design/note.txt',
    'coordination/handoff-agent.md',
    'docs/state/CLAUDE.md',
    'docs/state/.cursor/rules/x.md',
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

test('allowed folders narrowed to docs/state only; instruction, dot-folder, json and yaml dropped', async t => {
  const root = await tempRepo(t);
  for (const f of [
    'docs/scope/plan.md',
    'docs/plans/ideas.md',
    'docs/design/note.md',
    'coordination/handoff-agent.md',
    'docs/state/x.json',
    'docs/state/x.yaml',
    'docs/state/AGENTS.md',
    'docs/state/foo.instructions.md',
    'docs/state/bar.rules.md',
  ]) {
    assert.equal(isPolicyWindowFileEntry(f), false, f);
    assert.equal(isSwarmAdminHandbuildPath(f, { root }), false, f);
    assert.equal(evaluateHandbuildAutoApprove(root, { files: [f], minutes: 30 }).ok, false, f);
  }
  assert.equal(windowRequest(root, 'docs/scope/plan.md').status, 'pending');
  assert.equal(windowRequest(root, 'docs/state/x.md').status, 'approved');
});

test('write-time re-check rejects disallowed extension at guard', async t => {
  const root = await tempRepo(t);
  const req = windowRequest(root);
  assert.equal(req.status, 'approved');
  assert.equal(isSwarmAdminHandbuildPath('docs/state/evil.mjs', { root }), false);
  const bad = handbuildPolicyGuardCheck(root, {
    approvals: [req],
    files: ['docs/state/evil.mjs'],
    now: T0(),
  });
  assert.equal(bad?.ok, false);
});

test('symlinked ancestor rejected for policy paths', async t => {
  const root = await tempRepo(t);
  const link = path.join(root, 'docs', 'state-link');
  await fs.symlink(path.join(root, 'docs', 'state'), link);
  assert.equal(isSwarmAdminHandbuildPath('docs/state-link/plan.md', { root }), false);
});

test('covered path spelled differently still gets the full policy check', async t => {
  const root = await tempRepo(t);
  const req = windowRequest(root);
  assert.equal(req.status, 'approved');
  assert.equal(guardWrite(root, PLAN).allow, true);
  // a wildcard row covers evil.mjs through the matcher, but not by an exact listed path: the full check runs and denies
  await rewriteWindowFiles(root, req.id, ['docs/state/*']);
  const evil = guardWrite(root, 'docs/state/evil.mjs');
  assert.equal(evil.allow, false);
  assert.equal(guardWrite(root, PLAN).allow, false);
  // a "./" spelling of the same file is covered by the matcher too: same canonical path, different spelling, denied
  await rewriteWindowFiles(root, req.id, [`./${PLAN}`]);
  assert.equal(guardWrite(root, PLAN).allow, false);
  assert.equal(canonicalPolicyRel(root, `./docs/state/../state/plan.md`), canonicalPolicyRel(root, PLAN));
  assert.equal(canonicalPolicyRel(root, '../outside.md'), null);
});

test('hard link to a window file is rejected; non-regular files too', async t => {
  const root = await tempRepo(t);
  await fs.mkdir(path.join(root, 'docs', 'state', 'dir.md'));
  assert.equal(isSwarmAdminHandbuildPath('docs/state/dir.md', { root }), false);
  const req = windowRequest(root);
  assert.equal(req.status, 'approved');
  assert.equal(guardWrite(root, PLAN).allow, true);
  await fs.link(path.join(root, PLAN), path.join(root, 'docs', 'design', 'alias.md'));
  assert.equal(isSwarmAdminHandbuildPath(PLAN, { root }), false);
  assert.equal(handbuildPolicyGuardCheck(root, { approvals: [req], files: [PLAN], now: T0() })?.ok, false);
  assert.equal(guardWrite(root, PLAN).allow, false);
  // a new window cannot be auto-approved over a hard-linked file
  assert.equal(windowRequest(root).status, 'pending');
});

test('policy window does not auto-approve Bash (policy row is file tools only)', async t => {
  const root = await tempRepo(t);
  const req = windowRequest(root);
  assert.equal(req.policyId, POLICY_ID);
  const d = guardBash(root, 'echo x > docs/state/not-listed.md');
  assert.equal(d.allow, false);
  assert.doesNotMatch(d.reason, /policy window/i);
  assert.match(d.reason, /write a ticket instead|blocked: writes/);
});

test('Bash cannot use a live policy row to write a listed window file', async t => {
  const root = await tempRepo(t);
  const without = guardBash(root, `echo x > ${PLAN}`);
  assert.equal(without.allow, false);
  windowRequest(root, PLAN);
  const withWindow = guardBash(root, `echo x > ${PLAN}`);
  assert.equal(withWindow.allow, false);
  assert.equal(withWindow.allow, without.allow);
  assert.match(withWindow.reason, /write a ticket instead|blocked: writes/);
});

test('authoritative reader basenames are denied for policy windows', () => {
  assert.ok(DOCS_STATE_READER_DENIED_BASENAMES.has(fold('usage-ledger.md')));
  assert.ok(DOCS_STATE_READER_DENIED_BASENAMES.has(fold('eval-scores.ndjson')));
  assert.equal(isPolicyWindowFileEntry('docs/state/usage-ledger.md'), false);
  assert.equal(isPolicyWindowFileEntry('docs/state/eval-scores.ndjson'), false);
  assert.equal(isPolicyWindowFileEntry('docs/state/scratch.ndjson'), false);
});

test('fold() path rules: case and NFKC; non-ASCII path components rejected', async t => {
  const root = await tempRepo(t);
  assert.equal(fold('docs/state/PLAN.md'), fold('docs/state/plan.md'));
  assert.equal(isPolicyWindowFileEntry('docs/state/plan.md'), true);
  assert.equal(isPolicyWindowFileEntry('docs/state/plan$.md'), false);
  assert.equal(isSwarmAdminHandbuildPath('docs/state/usage-ledger.md', { root }), false);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/state/eval-scores.ndjson'], minutes: 30 }).ok, false);
});

test('session cannot write ~/.config/project-swarm (policy.json and siblings)', async t => {
  const root = await tempRepo(t);
  const home = process.env.HOME;
  const cfg = path.join(home, '.config', 'project-swarm', 'policy.json');
  const d = guardDecision({
    tool: 'Bash',
    toolInput: { command: `echo x > ${cfg}` },
    root,
    cwd: root,
    now: T0,
    home,
  });
  assert.equal(d.allow, false);
});

test('session cannot write XDG_CONFIG_HOME project-swarm when set', async t => {
  const root = await tempRepo(t);
  const home = process.env.HOME;
  const xdg = path.join(home, 'xdg-config');
  await fs.mkdir(path.join(xdg, 'project-swarm'), { recursive: true });
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const cfg = path.join(xdg, 'project-swarm', 'policy.json');
    const d = guardDecision({
      tool: 'Bash',
      toolInput: { command: `echo x > ${cfg}` },
      root,
      cwd: root,
      now: T0,
      home,
    });
    assert.equal(d.allow, false);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test('protected home path via symlink is blocked', async t => {
  const root = await tempRepo(t);
  const home = process.env.HOME;
  const sshDir = path.join(home, '.ssh');
  await fs.mkdir(sshDir, { recursive: true });
  const link = path.join(home, 'ssh-link');
  await fs.symlink(sshDir, link);
  const d = guardDecision({
    tool: 'Bash',
    toolInput: { command: `echo x > ${link}/config` },
    root,
    cwd: root,
    now: T0,
    home,
  });
  assert.equal(d.allow, false);
});

test('session cannot write arbitrary file under ~/.ssh', async t => {
  const root = await tempRepo(t);
  const home = process.env.HOME;
  const d = guardDecision({
    tool: 'Bash',
    toolInput: { command: `echo x > ${home}/.ssh/id_ed25519` },
    root,
    cwd: root,
    now: T0,
    home,
  });
  assert.equal(d.allow, false);
});

test('recordPolicyGuardAllow skips stats when final path check fails', async t => {
  const root = await tempRepo(t);
  const req = windowRequest(root);
  await fs.writeFile(path.join(root, STATS_FILE), JSON.stringify({}));
  const before = JSON.parse(await fs.readFile(path.join(root, STATS_FILE), 'utf8'));
  const rec = recordPolicyGuardAllow(root, {
    approvalId: req.id,
    files: ['docs/state/evil.mjs'],
    rule: 'test',
  }, { now: T0 });
  assert.equal(rec.blocked, true);
  const after = JSON.parse(await fs.readFile(path.join(root, STATS_FILE), 'utf8'));
  assert.deepEqual(after, before);
});

test('opaque command without a policy window needs a commit-level approval', async t => {
  const root = await tempRepo(t);
  const d = guardBash(root, '$SOME_TOOL --flag');
  assert.equal(d.allow, false);
  assert.match(d.reason, /blocked: git commit/);
});

test('opaque command with a policy window live is not covered by the policy row', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
  const d = guardBash(root, '$SOME_TOOL --flag');
  assert.equal(d.allow, false);
  assert.match(d.reason, /blocked: git commit/);
});

test('policy windows never carry git ops', async t => {
  const root = await tempRepo(t);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: [PLAN], minutes: 30, git: ['commit'] }).ok, false);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: [PLAN], minutes: 30, git: 'push' }).ok, false);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: [PLAN], minutes: 30, git: [] }).ok, true);
  const withGit = windowRequest(root, PLAN, { git: 'commit,push' });
  assert.equal(withGit.status, 'pending');
  assert.deepEqual(withGit.git, ['commit', 'push']);
  const plain = windowRequest(root);
  assert.equal(plain.status, 'approved');
  assert.equal(plain.autoApproved, true);
  assert.deepEqual(plain.git, []);
  assert.deepEqual(listRequests(root).find(r => r.id === plain.id).git, []);
});

test('orchestrator mode allowlist has no swarm handbuild git', async t => {
  const root = await tempRepo(t);
  assert.equal(orchestratorModeCommandAllowed('swarm handbuild git status', { root, cwd: root }), false);
  assert.equal(orchestratorModeCommandAllowed('swarm handbuild git commit -m x', { root, cwd: root }), false);
  assert.doesNotMatch(SHELL_WRITES_SRC, /verb === 'git'/);
  assert.doesNotMatch(HANDBUILD_SRC, /handbuildGitAt/);
});

test('git push still denied with a policy window live', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
  const d = guardBash(root, 'git push');
  assert.equal(d.allow, false);
  assert.match(d.reason, /blocked: git push/);
});

test('mergeStandingPolicyJsonPath ignores SWARM_POLICY_FILE without signed harness', async t => {
  const unsigned = await tempRepo(t, { signed: false });
  const fallback = path.join(os.homedir(), '.config', 'project-swarm', 'policy.json');
  const prev = process.env.SWARM_POLICY_FILE;
  process.env.SWARM_POLICY_FILE = path.join(os.tmpdir(), 'evil-merge-policy.json');
  try {
    assert.equal(mergeStandingPolicyJsonPath({ home: os.homedir(), root: unsigned }), fallback);
  } finally {
    if (prev === undefined) delete process.env.SWARM_POLICY_FILE;
    else process.env.SWARM_POLICY_FILE = prev;
  }
});

test('policy file override needs the signed marker, never a temp directory', async t => {
  const unsigned = await tempRepo(t, { signed: false });
  const signed = await tempRepo(t);
  const home = path.join(os.tmpdir(), 'no-such-home');
  const fallback = path.join(home, '.config', 'project-swarm', 'policy.json');
  const override = path.join(path.dirname(process.env.SWARM_CONFIG), 'override-policy.json');
  const prev = process.env.SWARM_POLICY_FILE;
  process.env.SWARM_POLICY_FILE = override;
  try {
    assert.equal(machinePolicyJsonPath({ home, root: unsigned }), fallback);
    assert.equal(machinePolicyJsonPath({ home, root: unsigned, allowPolicyFile: true }), fallback);
    assert.equal(machinePolicyJsonPath({ home }), fallback);
    assert.equal(machinePolicyJsonPath({ home, root: signed }), override);
  } finally {
    if (prev === undefined) delete process.env.SWARM_POLICY_FILE;
    else process.env.SWARM_POLICY_FILE = prev;
  }
});

test('per-window rate limit', async t => {
  const root = await tempRepo(t);
  const req = windowRequest(root);
  assert.equal(req.status, 'approved');
  for (let i = 0; i < DEFAULT_MAX_ACTIONS_PER_WINDOW; i += 1) {
    const rec = recordPolicyGuardAllow(root, { approvalId: req.id, files: [PLAN], rule: 'test' }, { now: T0 });
    assert.equal(rec.blocked, false);
  }
  const blocked = recordPolicyGuardAllow(root, { approvalId: req.id, files: [PLAN], rule: 'test' }, { now: T0 });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'window-actions');
});

test('stats and handbuild paths protected from writes', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
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
    files: PLAN,
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
  const blocked = windowRequest(root);
  assert.equal(blocked.status, 'pending');
  await fs.rm(path.join(root, HB_AUTO_OFF));
  assert.equal(evaluateHandbuildAutoApprove(root, { files: ['docs/state/a.md'], minutes: 61 }).ok, false);
  const many = Array.from({ length: MAX_POLICY_FILES + 1 }, (_, i) => `docs/state/f${i}.md`);
  assert.equal(evaluateHandbuildAutoApprove(root, { files: many, minutes: 30 }).ok, false);
});

test('policy window does not auto-approve git commit', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
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
  windowRequest(root);
  const d = guardWrite(root, PLAN);
  assert.equal(d.allow, true);
  assert.ok(d.approval);
});

test('stats bootstrap initializes under lock before first auto-approve', async t => {
  const root = await tempRepo(t);
  await fs.rm(path.join(root, '.swarm', 'handbuild', path.basename(STATS_INITIALIZED_FILE)), { force: true });
  await fs.rm(path.join(root, STATS_FILE), { force: true });
  assert.equal(handbuildStatsInitialized(root), false);
  const r = windowRequest(root);
  assert.equal(r.status, 'approved');
  assert.equal(handbuildStatsInitialized(root), true);
  assert.ok(fsSync.existsSync(path.join(root, STATS_FILE)));
});

test('unreadable stats block auto-approve', async t => {
  const root = await tempRepo(t);
  await fs.writeFile(path.join(root, STATS_FILE), 'not-json');
  const pending = windowRequest(root);
  assert.equal(pending.status, 'pending');
});

test('bumpHandbuildStats does not persist unreadable flag', async t => {
  const root = await tempRepo(t);
  await fs.writeFile(path.join(root, STATS_FILE), 'not-json');
  bumpHandbuildStats(root, 'ownerTerminal', { now: T0 });
  const raw = await fs.readFile(path.join(root, STATS_FILE), 'utf8');
  assert.doesNotMatch(raw, /__policyStatsUnreadable/);
});

test('decideRequest ownerTerminal bump skips write when stats are unreadable', async t => {
  const root = await tempRepo(t);
  const pending = createRequest(root, {
    kind: 'tiny',
    reason: 'needs owner approval for stats test',
    files: 'docs/plans/ideas.md',
    minutes: 10,
  }, { now: T0 });
  assert.equal(pending.status, 'pending');
  await fs.writeFile(path.join(root, STATS_FILE), 'not-json');
  decideRequest(root, pending.id, 'approve', { now: T0, by: 'owner', channel: 'computer' });
  const raw = await fs.readFile(path.join(root, STATS_FILE), 'utf8');
  assert.equal(raw, 'not-json');
});

test('post-write verification engages kill switch when inode changes', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
  const allowed = guardWrite(root, PLAN);
  assert.equal(allowed.allow, true);
  const before = fsSync.readFileSync(path.join(root, PLAN), 'utf8');
  await fs.rm(path.join(root, PLAN));
  await fs.writeFile(path.join(root, PLAN), `${before}# replaced\n`);
  const verify = verifyPolicyWriteQueue(root, { now: T0 });
  assert.equal(verify.ok, false);
  assert.ok(fsSync.existsSync(path.join(root, HB_AUTO_OFF)));
  assert.ok(fsSync.existsSync(path.join(root, POLICY_INTEGRITY_ALERT_FILE)));
  const stats = JSON.parse(handbuildStatsJson(root, { now: T0 }));
  assert.equal(stats.policyIntegrityAlert, true);
  assert.equal(stats.killSwitch, true);
});

test('policy window rejects parent dir that is group-writable', async t => {
  const root = await tempRepo(t);
  const dir = path.join(root, 'docs', 'state', 'loose');
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o775);
  assert.equal(policyWindowParentDirSafe(root, 'docs/state/loose/note.md'), false);
  assert.equal(isSwarmAdminHandbuildPath('docs/state/loose/note.md', { root }), false);
});

test('missing stats after initialized marker blocks auto-approve', async t => {
  const root = await tempRepo(t);
  await fs.rm(path.join(root, STATS_FILE), { force: true });
  const pending = windowRequest(root);
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
  const req = windowRequest(root);
  await fs.writeFile(path.join(root, HB_AUTO_OFF), '');
  const killed = guardWrite(root, PLAN);
  assert.equal(killed.allow, false);
  await fs.rm(path.join(root, HB_AUTO_OFF));
  const check = handbuildPolicyGuardCheck(root, { approvals: [req], files: [PLAN], now: T0() });
  assert.equal(check?.ok, true);
});

test('kill switch does not block read-only git while policy window is live', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
  await fs.writeFile(path.join(root, HB_AUTO_OFF), '');
  const d = guardBash(root, 'git status');
  assert.equal(d.allow, true);
});

test('applyPolicyGuardedAllow denies policy row with empty files', async t => {
  const root = await tempRepo(t);
  const req = windowRequest(root);
  const out = applyPolicyGuardedAllow(root, {
    files: [],
    allowResult: { allow: true, approval: req.id },
    now: T0,
    h: os.homedir(),
    approvals: [req],
  });
  assert.equal(out.allow, false);
  assert.match(out.reason, /named files/);
});

test('protected home gitconfig compared case-insensitively', async t => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const root = await tempRepo(t);
  const home = process.env.HOME;
  const d = guardDecision({
    tool: 'Bash',
    toolInput: { command: `echo x > ${home}/.GITCONFIG` },
    root,
    cwd: root,
    now: T0,
    home,
  });
  assert.equal(d.allow, false);
});

test('daily auto-approve window cap', async t => {
  const root = await tempRepo(t);
  windowRequest(root);
  for (let i = 1; i < DEFAULT_MAX_AUTO_APPROVE_WINDOWS_PER_DAY; i += 1) {
    createRequest(root, {
      kind: 'tiny',
      reason: `extra policy window number ${i}`,
      files: PLAN,
      minutes: 5,
    }, { now: T0 });
  }
  const capped = createRequest(root, {
    kind: 'tiny',
    reason: 'one more policy window should be capped',
    files: PLAN,
    minutes: 5,
  }, { now: T0 });
  assert.equal(capped.status, 'pending');
});

test('ambiguous overlapping policy windows denied', async t => {
  const root = await tempRepo(t);
  const a = windowRequest(root);
  const b = windowRequest(root);
  assert.equal(a.status, 'approved');
  assert.equal(b.status, 'approved');
  const check = handbuildPolicyGuardCheck(root, {
    approvals: [a, b],
    files: [PLAN],
    now: T0(),
  });
  assert.equal(check?.ok, false);
});

test('standing swarm merge alone skips policy guard; git combo does not', async t => {
  const root = await tempRepo(t);
  const policyPath = policyJsonPath();
  fsSync.writeFileSync(policyPath, `${JSON.stringify({ rules: [{ id: 'merge-swarm-pr', enabled: true }] })}\n`);
  t.after(() => fsSync.rmSync(policyPath, { force: true }));
  windowRequest(root);
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
  windowRequest(root);
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
