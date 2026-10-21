// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NEVER_AUTO, decide, effectiveRulesFromOverrides } from '../tools/policy.mjs';
import { policyCommand } from '../tools/policy-commands.mjs';

const rules = () => effectiveRulesFromOverrides([]);

const mergeOk = {
  repoClass: 'swarm',
  ciGreen: true,
  reviewsPass: true,
  fullSuiteGreen: true,
  inMergeOrder: true,
  deploysLiveSite: false,
};

test('merge-swarm-pr standing approval cases', () => {
  const cases = [
    { label: 'all conditions', facts: mergeOk, expect: 'auto-approve' },
    { label: 'wrong repo', facts: { ...mergeOk, repoClass: 'app' }, expect: 'needs-owner' },
    { label: 'ci red', facts: { ...mergeOk, ciGreen: false }, expect: 'needs-owner' },
    { label: 'reviews fail', facts: { ...mergeOk, reviewsPass: false }, expect: 'needs-owner' },
    { label: 'suite red', facts: { ...mergeOk, fullSuiteGreen: false }, expect: 'needs-owner' },
    { label: 'out of order', facts: { ...mergeOk, inMergeOrder: false }, expect: 'needs-owner' },
    { label: 'deploys live', facts: { ...mergeOk, deploysLiveSite: true }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'merge-pr', id: 'm', facts }, { rules: rules() }).decision, expect);
  }
});

test('swarm-update-idle standing approval cases', () => {
  const ok = { machineIdle: true, afterReleaseMerge: true };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { ...ok, machineIdle: false }, expect: 'needs-owner' },
    { facts: { ...ok, afterReleaseMerge: false }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'swarm-update', id: 'u', facts }, { rules: rules() }).decision, expect);
  }
});

test('commit-push-swarm-branch standing approval cases', () => {
  const ok = { branch: 'feat', allSwarmProduced: true };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { ...ok, branch: 'main' }, expect: 'needs-owner' },
    { facts: { ...ok, allSwarmProduced: false }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'commit-push-swarm-branch', id: 'c', facts }, { rules: rules() }).decision, expect);
  }
});

test('setup-and-routing-hand-build standing approval cases', () => {
  const ok = { files: ['coordination/task.md', 'CLAUDE.md'], git: [], branch: 'feat' };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { ...ok, files: ['src/app.ts'] }, expect: 'needs-owner' },
    { facts: { ...ok, git: ['reset'] }, expect: 'needs-owner' },
    { facts: { ...ok, branch: 'main' }, expect: 'needs-owner' },
    { facts: { files: ['docs/policy.md'], git: [] }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'hand-build-request', id: 'h', facts }, { rules: rules() }).decision, expect);
  }
});

test('ticket-routine standing approval cases', () => {
  const cases = [
    { kind: 'ticket-park', facts: {}, expect: 'auto-approve' },
    { kind: 'ticket-retry', facts: {}, expect: 'auto-approve' },
    { kind: 'ticket-release', facts: {}, expect: 'auto-approve' },
    { kind: 'ticket-set-status', facts: { status: 'active' }, expect: 'auto-approve' },
    {
      kind: 'ticket-set-status',
      facts: { status: 'done', requiresReview: true, reviewPassed: true },
      expect: 'auto-approve',
    },
    {
      kind: 'ticket-set-status',
      facts: { status: 'done', requiresReview: true, reviewPassed: false },
      expect: 'needs-owner',
    },
    {
      kind: 'ticket-set-status',
      facts: { toStatus: 'done', requiresReview: true },
      expect: 'needs-owner',
    },
  ];
  for (const { kind, facts, expect } of cases) {
    assert.equal(decide({ kind, id: 't', facts }, { rules: rules() }).decision, expect);
  }
});

test('change-order rules require project', () => {
  for (const kind of ['change-order-path-fix', 'change-order-split']) {
    assert.equal(decide({ kind, id: 'x', facts: { project: 'p' } }, { rules: rules() }).decision, 'auto-approve');
    assert.equal(decide({ kind, id: 'x', facts: {} }, { rules: rules() }).decision, 'needs-owner');
  }
});

test('workflow-change standing approval cases', () => {
  const ok = { opusReviewPassed: true, addsSecrets: false, addsDeploy: false, addsPublish: false };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { ...ok, opusReviewPassed: false }, expect: 'needs-owner' },
    { facts: { ...ok, addsSecrets: true }, expect: 'needs-owner' },
    { facts: { ...ok, addsDeploy: true }, expect: 'needs-owner' },
    { facts: { ...ok, addsPublish: true }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'workflow-change', id: 'w', facts }, { rules: rules() }).decision, expect);
  }
});

test('cap-raise-small at five dollars passes and five oh one fails', () => {
  const r = rules();
  assert.equal(
    decide({ kind: 'cap-raise', id: 'c', facts: { amountUsd: 2, raisedTodayUsd: 3 } }, { rules: r }).decision,
    'auto-approve',
  );
  assert.equal(
    decide({ kind: 'cap-raise', id: 'c', facts: { amountUsd: 0.01, raisedTodayUsd: 5 } }, { rules: r }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'cap-raise', id: 'c', facts: { amountUsd: 1, pastDailyAutoLimit: true } }, { rules: r }).decision,
    'needs-owner',
  );
});

test('accept-failed-checks-new-tests-only standing approval cases', () => {
  const ok = { failingChecks: ['new-a'], newTestChecks: ['new-a'], otherChecksPassing: true };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { ...ok, failingChecks: ['old'] }, expect: 'needs-owner' },
    { facts: { ...ok, otherChecksPassing: false }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'accept-failed-checks', id: 'a', facts }, { rules: rules() }).decision, expect);
  }
});

test('NEVER_AUTO kinds stay needs-owner regardless of generous facts', () => {
  const generous = {
    ...mergeOk,
    machineIdle: true,
    afterReleaseMerge: true,
    amountUsd: 1,
    raisedTodayUsd: 0,
    opusReviewPassed: true,
  };
  for (const kind of NEVER_AUTO) {
    assert.equal(decide({ kind, id: 'n', facts: generous }, { rules: rules() }).decision, 'needs-owner');
  }
});

test('policy init writes once and never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-init-'));
  const env = { HOME: dir };
  const configDir = path.join(dir, '.config', 'project-swarm');
  const policyFile = path.join(configDir, 'policy.json');
  const chunks = [];
  const out = text => chunks.push(text);

  assert.equal(policyCommand(['init'], { out, env, home: dir, fs }), 0);
  assert.ok(fs.existsSync(policyFile));
  const first = fs.readFileSync(policyFile, 'utf8');
  fs.writeFileSync(policyFile, `${first.trim()}\n/* marker */\n`);

  chunks.length = 0;
  assert.equal(policyCommand(['init'], { out, env, home: dir, fs }), 0);
  assert.match(chunks.join(''), /not overwritten/);
  assert.match(fs.readFileSync(policyFile, 'utf8'), /marker/);
});
