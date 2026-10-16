// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPROVAL, validateApprovalPolicy, needsHuman } from '../tools/approval-policy.mjs';

test('DEFAULT_APPROVAL is frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_APPROVAL), true);
  assert.equal(Object.isFrozen(DEFAULT_APPROVAL.humanApprovals), true);
});

test('an empty approval block yields the defaults with no errors', () => {
  const { policy, errors } = validateApprovalPolicy({});
  assert.deepEqual(errors, []);
  assert.equal(policy.changeOrderOverUsd, 20);
  assert.equal(policy.budgetUsd, null);
  assert.equal(policy.autoMergeToStageBranch, true);
});

test('an unknown key is an error', () => {
  const { errors } = validateApprovalPolicy({ bogus: 1 });
  assert.ok(errors.some((e) => e.includes('bogus')));
});

test('humanApprovals with an unknown name is an error', () => {
  const { errors } = validateApprovalPolicy({ humanApprovals: ['scope', 'nope'] });
  assert.ok(errors.some((e) => e.includes('nope')));
});

test('humanApprovals must be an array', () => {
  const { errors } = validateApprovalPolicy({ humanApprovals: 'scope' });
  assert.equal(errors.length, 1);
});

test('a negative changeOrderOverUsd is an error', () => {
  const { errors } = validateApprovalPolicy({ changeOrderOverUsd: -1 });
  assert.equal(errors.length, 1);
});

test('a budgetUsd of zero is an error', () => {
  const { errors } = validateApprovalPolicy({ budgetUsd: 0 });
  assert.equal(errors.length, 1);
});

test('budgetUsd null and a positive budget are accepted', () => {
  assert.deepEqual(validateApprovalPolicy({ budgetUsd: null }).errors, []);
  const { policy, errors } = validateApprovalPolicy({ budgetUsd: 50 });
  assert.deepEqual(errors, []);
  assert.equal(policy.budgetUsd, 50);
});

test('a listed human-approval kind needs the owner', () => {
  const { policy } = validateApprovalPolicy({});
  assert.equal(needsHuman(policy, { kind: 'scope' }), true);
});

test('a kind not in humanApprovals does not need the owner', () => {
  const { policy } = validateApprovalPolicy({ humanApprovals: [] });
  assert.equal(needsHuman(policy, { kind: 'scope' }), false);
});

test('an unknown event kind fails closed', () => {
  const { policy } = validateApprovalPolicy({});
  assert.equal(needsHuman(policy, { kind: 'mystery' }), true);
});

test('a change order over the limit needs the owner', () => {
  const { policy } = validateApprovalPolicy({});
  assert.equal(needsHuman(policy, { kind: 'change-order', usd: 25 }), true);
});

test('a change order under the limit does not need the owner', () => {
  const { policy } = validateApprovalPolicy({});
  assert.equal(needsHuman(policy, { kind: 'change-order', usd: 5 }), false);
});

test('a non-numeric change order amount fails closed', () => {
  const { policy } = validateApprovalPolicy({});
  assert.equal(needsHuman(policy, { kind: 'change-order', usd: NaN }), true);
});

test('spend over the budget needs the owner', () => {
  const { policy } = validateApprovalPolicy({ budgetUsd: 100 });
  assert.equal(needsHuman(policy, { kind: 'spend', usd: 150 }), true);
});

test('spend under the budget does not need the owner', () => {
  const { policy } = validateApprovalPolicy({ budgetUsd: 100 });
  assert.equal(needsHuman(policy, { kind: 'spend', usd: 50 }), false);
});

test('spend with no budget set never needs the owner', () => {
  const { policy } = validateApprovalPolicy({ budgetUsd: null });
  assert.equal(needsHuman(policy, { kind: 'spend', usd: 1000000 }), false);
});

test('a merge to the stage branch needs both tests and review to pass', () => {
  const { policy } = validateApprovalPolicy({});
  assert.equal(needsHuman(policy, { kind: 'merge-to-stage-branch', testsPassed: true, reviewPassed: false }), true);
  assert.equal(needsHuman(policy, { kind: 'merge-to-stage-branch', testsPassed: false, reviewPassed: true }), true);
  assert.equal(needsHuman(policy, { kind: 'merge-to-stage-branch', testsPassed: true, reviewPassed: true }), false);
});

test('a merge needs the owner when auto-merge is switched off', () => {
  const { policy } = validateApprovalPolicy({ autoMergeToStageBranch: false });
  assert.equal(needsHuman(policy, { kind: 'merge-to-stage-branch', testsPassed: true, reviewPassed: true }), true);
});
