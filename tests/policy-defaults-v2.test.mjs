// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { NEVER_AUTO, decide, effectiveRulesFromOverrides } from '../tools/policy.mjs';

const rules = () => effectiveRulesFromOverrides([]);

const EXPECTED_NEVER_AUTO = [
  'merge-other-repo',
  'new-paid-service',
  'new-key',
  'new-account',
  'new-secret',
  'spend-past-daily-limit',
  'irreversible-action',
  'deploy',
  'publish',
  'hand-edit-app-code',
  'auth-change',
  'payments-change',
  'override',
  'accept-unmet-acceptance',
];

test('NEVER_AUTO list matches owner standing defaults', () => {
  assert.deepEqual([...NEVER_AUTO], EXPECTED_NEVER_AUTO);
});

const mergeLiveOk = {
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

test('merge-live-site standing approval cases', () => {
  const cases = [
    { label: 'all conditions', facts: mergeLiveOk, expect: 'auto-approve' },
    { label: 'not deploying', facts: { ...mergeLiveOk, deploysLiveSite: false }, expect: 'needs-owner' },
    { label: 'wrong repo', facts: { ...mergeLiveOk, repoClass: 'app' }, expect: 'needs-owner' },
    { label: 'ci red', facts: { ...mergeLiveOk, ciGreen: false }, expect: 'needs-owner' },
    { label: 'e2e red', facts: { ...mergeLiveOk, fullE2eGreen: false }, expect: 'needs-owner' },
    { label: 'reviews fail', facts: { ...mergeLiveOk, reviewsPass: false }, expect: 'needs-owner' },
    { label: 'no post-deploy watch', facts: { ...mergeLiveOk, postDeployWatch: false }, expect: 'needs-owner' },
    { label: 'missing post-deploy watch', facts: { ...mergeLiveOk, postDeployWatch: undefined }, expect: 'needs-owner' },
    { label: 'no auto rollback', facts: { ...mergeLiveOk, autoRollback: false }, expect: 'needs-owner' },
    { label: 'missing auto rollback', facts: { ...mergeLiveOk, autoRollback: undefined }, expect: 'needs-owner' },
    { label: 'out of order', facts: { ...mergeLiveOk, inMergeOrder: false }, expect: 'needs-owner' },
    { label: 'irreversible', facts: { ...mergeLiveOk, irreversible: true }, expect: 'needs-owner' },
    { label: 'past daily limit', facts: { ...mergeLiveOk, pastDailyAutoLimit: true }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'merge-pr', id: 'm', facts }, { rules: rules() }).decision, expect);
  }
});

const migrationOk = {
  backwardCompatible: true,
  backupTaken: true,
  dryRunPassed: true,
  mainE2eProof: true,
  destructive: false,
  irreversible: false,
};

test('hosted-migration standing approval cases', () => {
  const cases = [
    { facts: migrationOk, expect: 'auto-approve' },
    { facts: { ...migrationOk, backwardCompatible: false }, expect: 'needs-owner' },
    { facts: { ...migrationOk, backupTaken: false }, expect: 'needs-owner' },
    { facts: { ...migrationOk, dryRunPassed: false }, expect: 'needs-owner' },
    { facts: { ...migrationOk, mainE2eProof: false }, expect: 'needs-owner' },
    { facts: { ...migrationOk, destructive: true }, expect: 'needs-owner' },
    { facts: { ...migrationOk, irreversible: true }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'hosted-db-migration', id: 'h', facts }, { rules: rules() }).decision, expect);
  }
});

test('branch-switch standing approval cases', () => {
  const ok = { branch: 'feat/my-branch_1.2' };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { ...ok, force: true }, expect: 'needs-owner' },
    { facts: { branch: 'feat:broken' }, expect: 'needs-owner' },
    { facts: { branch: '' }, expect: 'needs-owner' },
    { facts: { branch: 'bad name' }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'branch-switch', id: 'b', facts }, { rules: rules() }).decision, expect);
  }
});

test('journal-restore standing approval cases', () => {
  const ok = {
    files: ['TASK.md', 'docs/state/foo.json', 'coordination/manifests/wave.json', '.swarm/journal-1.json'],
  };
  const cases = [
    { facts: ok, expect: 'auto-approve' },
    { facts: { files: ['coordination/HANDOFF.md'] }, expect: 'auto-approve' },
    { facts: { files: ['tools/swarm.mjs'] }, expect: 'needs-owner' },
    { facts: { files: ['TASK.md', 'tools/swarm.mjs'] }, expect: 'needs-owner' },
    { facts: { files: [] }, expect: 'needs-owner' },
  ];
  for (const { facts, expect } of cases) {
    assert.equal(decide({ kind: 'journal-restore', id: 'j', facts }, { rules: rules() }).decision, expect);
  }
});

test('deploying merge without postDeployWatch or autoRollback is needs-owner', () => {
  const base = {
    repoClass: 'swarm',
    deploysLiveSite: true,
    ciGreen: true,
    fullE2eGreen: true,
    reviewsPass: true,
    inMergeOrder: true,
  };
  assert.equal(
    decide({ kind: 'merge-pr', id: 'm', facts: { ...base, postDeployWatch: true, autoRollback: false } }, { rules: rules() })
      .decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'merge-pr', id: 'm', facts: { ...base, postDeployWatch: false, autoRollback: true } }, { rules: rules() })
      .decision,
    'needs-owner',
  );
});
