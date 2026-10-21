// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_POLICY_FILE,
  decide,
  effectiveRulesFromOverrides,
  loadPolicy,
  normalizeBranchName,
  policyInitializedMarkerPath,
  protectedBranchState,
  validatePolicy,
} from '../tools/policy.mjs';
import { policyCommand } from '../tools/policy-commands.mjs';
import { runPolicyPass } from '../tools/policy-run.mjs';

const rules = () => effectiveRulesFromOverrides([]);

test('finding 1: deploysLiveSite must be true or false (not missing)', () => {
  const base = {
    repoClass: 'swarm',
    ciGreen: true,
    reviewsPass: true,
    fullSuiteGreen: true,
    inMergeOrder: true,
  };
  assert.equal(decide({ kind: 'merge-pr', id: 'm', facts: { ...base } }, { rules: rules() }).decision, 'needs-owner');
  assert.equal(
    decide({ kind: 'merge-pr', id: 'm', facts: { ...base, deploysLiveSite: false } }, { rules: rules() }).decision,
    'auto-approve',
  );
});

test('finding 1: must-be-false facts reject string and null', () => {
  const live = {
    repoClass: 'swarm',
    deploysLiveSite: true,
    ciGreen: true,
    fullE2eGreen: true,
    reviewsPass: true,
    postDeployWatch: true,
    autoRollback: true,
    inMergeOrder: true,
    irreversible: false,
    pastDailyAutoLimit: false,
  };
  assert.equal(
    decide({ kind: 'merge-pr', id: 'm', facts: { ...live, irreversible: 'no' } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'workflow-change', id: 'w', facts: { opusReviewPassed: true, isNewWorkflow: false, addsSecrets: null, addsDeploy: false, addsPublish: false } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('finding 2: workflow-change requires isNewWorkflow false and blocks new workflow', () => {
  const ok = {
    opusReviewPassed: true,
    isNewWorkflow: false,
    addsSecrets: false,
    addsDeploy: false,
    addsPublish: false,
  };
  assert.equal(decide({ kind: 'workflow-change', id: 'w', facts: ok }, { rules: rules() }).decision, 'auto-approve');
  assert.equal(
    decide({ kind: 'workflow-change', id: 'w', facts: { ...ok, isNewWorkflow: true } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('finding 3: runPolicyPass logs auto-decision after successful apply via journal callbacks', async () => {
  const order = [];
  const item = { id: 'r-log', kind: 'ticket-retry', project: 'p' };
  await runPolicyPass({
    root: '/tmp/policy-hardening',
    items: [item],
    rules: rules(),
    factsOf: () => ({}),
    apply: async () => { order.push('apply'); },
    journal: () => { order.push('journal'); },
    events: () => { order.push('events'); },
    readHandled: () => [],
  });
  assert.deepEqual(order, ['apply', 'journal', 'events']);
});

test('finding 3: missing journal leaves item for owner without apply', async () => {
  let applied = false;
  const item = { id: 'r-noj', kind: 'ticket-retry', project: 'p' };
  const r = await runPolicyPass({
    root: '/tmp/policy-hardening',
    items: [item],
    rules: rules(),
    factsOf: () => ({}),
    apply: async () => { applied = true; },
    events: () => {},
    readHandled: () => [],
  });
  assert.equal(applied, false);
  assert.equal(r.left.length, 1);
});

test('finding 4: protectedBranch normalizes refs and treats release as protected', () => {
  assert.equal(normalizeBranchName('  origin/main  '), 'main');
  assert.equal(protectedBranchState('refs/heads/master'), 'protected');
  assert.equal(protectedBranchState('release/1.0'), 'protected');
  assert.equal(protectedBranchState('feat/x'), 'unprotected');
  assert.equal(protectedBranchState(undefined), 'unknown');
  assert.equal(
    decide({ kind: 'commit-push-swarm-branch', id: 'c', facts: { branch: 'origin/main', allSwarmProduced: true } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('finding 5: mark-done review gate uses trimmed case-insensitive status', () => {
  const facts = { status: '  DONE  ', requiresReview: true, reviewPassed: false };
  assert.equal(decide({ kind: 'ticket-set-status', id: 't', facts }, { rules: rules() }).decision, 'needs-owner');
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { ...facts, requiresReview: false } }, { rules: rules() }).decision,
    'auto-approve',
  );
});

test('finding 6: runPolicyPass ignores caller raisedTodayUsd for cap-raise', async () => {
  const today = new Date().toISOString();
  const item = { id: 'cap-1', kind: 'cap-raise', project: 'app' };
  const applied = [];
  const r = await runPolicyPass({
    root: '/tmp/policy-hardening',
    items: [item],
    rules: rules(),
    factsOf: () => ({ amountUsd: 2, raisedTodayUsd: 0 }),
    apply: async ({ item: it }) => { applied.push(it.id); },
    journal: () => {},
    events: () => {},
    readHandled: () => [
      { kind: 'auto-decision', requestKind: 'cap-raise', project: 'app', amountUsd: 4, at: today },
    ],
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(r.decided.length, 0);
  assert.equal(applied.length, 0);
});

test('finding 6: missing pastDailyAutoLimit dep blocks cap-raise in runPolicyPass', async () => {
  const item = { id: 'cap-2', kind: 'cap-raise', project: 'app' };
  const r = await runPolicyPass({
    root: '/tmp/policy-hardening',
    items: [item],
    rules: rules(),
    factsOf: () => ({ amountUsd: 1 }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [],
    limits: { pastDailyAutoLimit: 'invalid' },
  });
  assert.equal(r.decided.length, 0);
});

test('finding 7: journal-restore rejects dot-dot and .swarm journal paths', () => {
  assert.equal(
    decide({ kind: 'journal-restore', id: 'j', facts: { files: ['docs/state/../secrets.json'] } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'journal-restore', id: 'j', facts: { files: ['.swarm/journal'] } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('finding 8: DEFAULT_POLICY_FILE validates and init then validate passes', () => {
  assert.equal(validatePolicy(DEFAULT_POLICY_FILE).length, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-init-val-'));
  const env = { HOME: dir };
  const out = () => {};
  assert.equal(policyCommand(['init'], { out, env, home: dir, fs }), 0);
  assert.equal(policyCommand(['validate'], { out, env, home: dir, fs }), 0);
});

test('finding 9: missing policy.json after init marker fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-marker-'));
  const policyFile = path.join(dir, 'policy.json');
  fs.writeFileSync(policyInitializedMarkerPath(policyFile), 'ok\n');
  const loaded = loadPolicy(policyFile, { fs });
  assert.ok(loaded.error);
  assert.equal(loaded.rules.length, 0);
});

test('finding 10: only auto-decision records count as handled', async () => {
  const item = { id: 'handled-1', kind: 'ticket-retry', project: 'p' };
  const r = await runPolicyPass({
    root: '/tmp/policy-hardening',
    items: [item],
    rules: rules(),
    factsOf: () => ({}),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [{ kind: 'note', requestId: 'handled-1' }, 'handled-1'],
  });
  assert.equal(r.decided.length, 1);
});

test('finding 10: hand-build-request with elevated git is never auto-applied', async () => {
  const item = { id: 'hb-1', kind: 'hand-build-request', project: 'p' };
  const r = await runPolicyPass({
    root: '/tmp/policy-hardening',
    items: [item],
    rules: rules(),
    factsOf: () => ({ files: ['.gitignore'], git: ['merge'], branch: 'feat' }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [],
  });
  assert.equal(r.decided.length, 0);
});

test('finding 10: change-order project must match request project', () => {
  assert.equal(
    decide(
      { kind: 'change-order-split', id: 'x', project: 'alpha', facts: { project: 'beta' } },
      { rules: rules() },
    ).decision,
    'needs-owner',
  );
});
