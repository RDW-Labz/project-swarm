// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  decide,
  effectiveRulesFromOverrides,
  loadPolicy,
  DEFAULT_POLICY_FILE,
  autoDecisionEvent,
  effectiveCommitWindowMinutes,
} from '../tools/policy.mjs';
import { runPolicyPass } from '../tools/policy-run.mjs';
import {
  createRequest,
  applyHandbuildPolicyApproval,
  readState,
  LOG_FILE,
} from '../tools/handbuild.mjs';
import { cleanupTestProject } from './_isolate-config.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');
const rules = () => effectiveRulesFromOverrides([]);

const WINDOW_FILES = [
  'docs/scope/build-plan.md',
  'coordination/manifests/x.json',
  '.swarm/project/tickets.json',
];

function windowFacts(overrides = {}) {
  return {
    commitWindow: true,
    minutes: 45,
    files: WINDOW_FILES,
    git: ['commit', 'push'],
    branch: 'feat/x',
    ...overrides,
  };
}

async function tempProject(t) {
  const base = process.env.SWARM_TEST_TMP || '/tmp';
  const root = await fsPromises.mkdtemp(path.join(base, 'policy-cw-'));
  t.after(async () => {
    await cleanupTestProject(root);
    await fsPromises.rm(root, { recursive: true, force: true });
  });
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fsPromises.mkdir(path.join(root, 'docs', 'scope'), { recursive: true });
  await fsPromises.mkdir(path.join(root, 'coordination', 'manifests'), { recursive: true });
  await fsPromises.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fsPromises.mkdir(path.join(root, 'tools'), { recursive: true });
  await fsPromises.writeFile(path.join(root, 'docs/scope/build-plan.md'), '# plan\n');
  await fsPromises.writeFile(path.join(root, 'coordination/manifests/x.json'), '{}\n');
  await fsPromises.writeFile(path.join(root, '.swarm/project/tickets.json'), '[]\n');
  return root;
}

test('commit window: generated paths on feat/x auto-approve with rule id and expiry', async t => {
  const root = await tempProject(t);
  const facts = { ...windowFacts(), root };
  const result = decide({ kind: 'hand-build-request', id: 'hb-cw', facts }, { rules: rules() });
  assert.equal(result.decision, 'auto-approve');
  assert.equal(result.rule, 'commit-window-generated');
  const now = () => 1_700_000_000_000;
  const event = autoDecisionEvent({ kind: 'hand-build-request', id: 'hb-cw', facts }, result, { now });
  assert.equal(event.rule, 'commit-window-generated');
  assert.equal(event.effectiveMinutes, 45);
  assert.equal(event.expiresAt, new Date(now() + 45 * 60000).toISOString());
  assert.deepEqual(event.files, WINDOW_FILES);
  assert.equal(event.branch, 'feat/x');
});

test('commit window: mixed or non-generated paths need owner', () => {
  const cases = [
    { files: [...WINDOW_FILES, 'src/app.mjs'] },
    { files: [...WINDOW_FILES, 'tests/foo.test.mjs'] },
    { files: [...WINDOW_FILES, '.github/workflows/ci.yml'] },
    { files: [...WINDOW_FILES, 'package.json'] },
  ];
  for (const patch of cases) {
    const result = decide(
      { kind: 'hand-build-request', id: 'hb', facts: windowFacts(patch) },
      { rules: rules() },
    );
    assert.equal(result.decision, 'needs-owner');
  }
});

test('commit window: protected or unknown branches need owner', () => {
  for (const branch of ['main', 'master', 'release/1.2', 'HEAD', 'origin/main', '']) {
    const result = decide(
      { kind: 'hand-build-request', id: 'hb', facts: windowFacts({ branch }) },
      { rules: rules() },
    );
    assert.equal(result.decision, 'needs-owner');
  }
  assert.equal(
    decide({ kind: 'hand-build-request', id: 'hb', facts: windowFacts({ branch: undefined }) }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('commit window: elevated git ops need owner', () => {
  for (const git of [['force-push'], ['merge'], ['branch-D'], ['commit', 'merge']]) {
    const result = decide(
      { kind: 'hand-build-request', id: 'hb', facts: windowFacts({ git, commitWindow: true }) },
      { rules: rules() },
    );
    assert.equal(result.decision, 'needs-owner');
  }
});

test('commit window: path tricks need owner', async t => {
  const root = await tempProject(t);
  const escape = windowFacts({
    root,
    files: ['docs/scope/../../tools/x.mjs', ...WINDOW_FILES.slice(1)],
  });
  assert.equal(decide({ kind: 'hand-build-request', id: 'hb', facts: escape }, { rules: rules() }).decision, 'needs-owner');

  const absolute = windowFacts({ root, files: [path.join(root, 'docs/scope/build-plan.md')] });
  assert.equal(decide({ kind: 'hand-build-request', id: 'hb', facts: absolute }, { rules: rules() }).decision, 'needs-owner');

  const scopeDir = path.join(root, 'docs/scope');
  const linkDir = path.join(scopeDir, 'linked');
  await fsPromises.symlink('../../tools', linkDir);
  const viaSymlink = windowFacts({
    root,
    files: ['docs/scope/linked/secret.mjs'],
  });
  assert.equal(decide({ kind: 'hand-build-request', id: 'hb', facts: viaSymlink }, { rules: rules() }).decision, 'needs-owner');
});

test('commit window: minutes above 120 cap to 120', () => {
  const facts = windowFacts({ minutes: 200 });
  assert.equal(effectiveCommitWindowMinutes(facts), 120);
  const result = decide({ kind: 'hand-build-request', id: 'hb', facts }, { rules: rules() });
  assert.equal(result.decision, 'auto-approve');
  const event = autoDecisionEvent({ kind: 'hand-build-request', id: 'hb', facts }, result, { now: () => 0 });
  assert.equal(event.effectiveMinutes, 120);
});

test('commit window: missing or non-boolean commitWindow needs owner', () => {
  const missing = { ...windowFacts() };
  delete missing.commitWindow;
  assert.equal(decide({ kind: 'hand-build-request', id: 'hb', facts: missing }, { rules: rules() }).decision, 'needs-owner');
  assert.equal(
    decide({ kind: 'hand-build-request', id: 'hb', facts: windowFacts({ commitWindow: 'true' }) }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('commit window: policy pass logs before apply and log failure leaves owner', async t => {
  const root = await tempProject(t);
  const nowMs = 1_700_100_000_000;
  const now = () => nowMs;
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'swarm generated commit window wiring test case',
    files: WINDOW_FILES.join(','),
    git: 'commit,push',
    minutes: 30,
  }, { now });
  const item = {
    id: `handbuild-${req.id}`,
    kind: 'hand-build-request',
    project: path.basename(root),
    raw: req,
    facts: { files: req.files, git: req.git, branch: 'feat/x' },
  };
  const journal = [];
  let applied = false;
  let persistedBeforeApply = false;
  const pass = await runPolicyPass({
    root,
    items: [item],
    rules: rules(),
    factsOf: it => it.facts ?? {},
    persistAutoDecision: async (_r, entry) => {
      journal.push(entry);
      return true;
    },
    apply: async () => {
      persistedBeforeApply = journal.length === 1;
      applied = true;
      await applyHandbuildPolicyApproval(root, item, {
        now,
        policyRule: 'commit-window-generated',
        approvalMinutes: 30,
      });
    },
    journal: async entry => { journal.push(entry); },
    events: async () => {},
    readHandled: () => [],
    now,
  });
  assert.equal(pass.decided.length, 1);
  assert.equal(applied, true);
  assert.equal(persistedBeforeApply, true);
  assert.equal(journal[0].rule, 'commit-window-generated');
  assert.equal(journal[0].expiresAt, new Date(nowMs + 30 * 60000).toISOString());
  const state = readState(root);
  assert.equal(state.requests[req.id].status, 'approved');

  const req2 = createRequest(root, {
    kind: 'tiny',
    reason: 'second handbuild for journal failure test',
    files: WINDOW_FILES.join(','),
    git: 'commit,push',
    minutes: 15,
  }, { now });
  const item2 = {
    id: `handbuild-${req2.id}`,
    kind: 'hand-build-request',
    project: path.basename(root),
    raw: req2,
    facts: { files: req2.files, git: req2.git, branch: 'feat/x' },
  };
  const failPass = await runPolicyPass({
    root,
    items: [item2],
    rules: rules(),
    factsOf: it => it.facts ?? {},
    persistAutoDecision: async () => false,
    apply: async () => { throw new Error('should not run'); },
    journal: async () => {},
    events: async () => {},
    readHandled: () => [],
    now,
  });
  assert.equal(failPass.decided.length, 0);
  assert.equal(failPass.left.length, 1);
  assert.equal(readState(root).requests[req2.id].status, 'pending');
});

test('commit window: empty rules list does not auto-approve', async t => {
  const root = await tempProject(t);
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'no policy rules loaded for this request',
    files: WINDOW_FILES.join(','),
    git: 'commit,push',
    minutes: 20,
  });
  const item = {
    id: `handbuild-${req.id}`,
    kind: 'hand-build-request',
    facts: windowFacts({ root }),
    raw: req,
  };
  const pass = await runPolicyPass({
    root,
    items: [item],
    rules: [],
    factsOf: it => it.facts ?? {},
    apply: async () => {},
    journal: async () => {},
    events: async () => {},
    readHandled: () => [],
  });
  assert.equal(pass.decided.length, 0);
  assert.equal(readState(root).requests[req.id].status, 'pending');
});

test('commit window: loadPolicy without policy file uses defaults when not initialized', () => {
  const dir = fs.mkdtempSync(path.join(process.env.SWARM_TEST_TMP || '/tmp', 'policy-cw-load-'));
  const file = path.join(dir, 'policy.json');
  const loaded = loadPolicy(file, { fs });
  assert.equal(loaded.error, null);
  assert.ok(loaded.rules.some(r => r.id === 'commit-window-generated'));
});

test('swarm policy show lists commit-window-generated', async t => {
  const root = await tempProject(t);
  const home = await fsPromises.mkdtemp(path.join(process.env.SWARM_TEST_TMP || '/tmp', 'policy-cw-home-'));
  t.after(() => fsPromises.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, 'cfg');
  await fsPromises.mkdir(configDir, { recursive: true });
  const configFile = path.join(configDir, 'config.json');
  const env = { ...process.env, HOME: home, SWARM_CONFIG: configFile };
  await fsPromises.writeFile(path.join(configDir, 'policy.json'), `${JSON.stringify(DEFAULT_POLICY_FILE, null, 2)}\n`);
  const { stdout } = await exec(process.execPath, [swarm, '--root', root, 'policy', 'show'], { env });
  assert.match(stdout, /commit-window-generated/);
});

test('commit window: handbuild log records policy rule on approve', async t => {
  const root = await tempProject(t);
  const now = () => 1_700_200_000_000;
  const req = createRequest(root, {
    kind: 'tiny',
    reason: 'handbuild action log policy rule test',
    files: WINDOW_FILES.join(','),
    git: 'commit,push',
    minutes: 25,
  }, { now });
  applyHandbuildPolicyApproval(root, { id: `handbuild-${req.id}` }, {
    now,
    policyRule: 'commit-window-generated',
    approvalMinutes: 25,
  });
  const lines = fs.readFileSync(path.join(root, LOG_FILE), 'utf8').trim().split('\n');
  const approve = JSON.parse(lines.find(l => l.includes('"approve"')));
  assert.match(approve.reason, /commit-window-generated/);
});
