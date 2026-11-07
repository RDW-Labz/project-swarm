// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerActions } from '../tools/board-owner-actions.mjs';
import {
  guardBoardAction,
  isProtectedTopic,
  REFUSED_KINDS,
  ALLOWED_KINDS,
} from '../tools/board-action-guard.mjs';
import { decisionBoardSafeForOwner } from '../tools/board-owner-actions.mjs';

const SOURCES = ['board', 'phone'];
const OWNER = 'owner@tail.test';

const ownerReq = (overrides = {}) => ({
  tokenOk: true,
  tokenInQuery: false,
  tailnetVerified: true,
  local: false,
  agentSession: false,
  headers: { 'Tailscale-User-Login': OWNER },
  ...overrides,
});

function ownerActionsFixture(items, { guard = guardBoardAction } = {}) {
  const audit = [];
  let seq = 0;
  return createOwnerActions({
    listItems: () => items,
    appendAudit: entry => audit.push(entry),
    readAudit: () => audit,
    guard,
    now: () => 1_000_000,
    randomId: () => `cfm-${++seq}`,
    ownerIdentities: [OWNER],
    confirmTtlMs: 120_000,
    verifyIdentity: () => true,
  });
}

test('acceptance: merge, deploy, and cap-raise are refused from board and phone guard paths', () => {
  const sensitive = ['merge', 'deploy', 'cap-raise', 'cap', 'cap_raise', 'limit-raise', 'MERGE', ' Deploy '];
  for (const source of SOURCES) {
    for (const kind of REFUSED_KINDS) {
      assert.equal(guardBoardAction({ source, kind, itemKind: 'scope' }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'approve', itemKind: kind }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'deny', itemKind: kind }).allowed, false);
    }
    for (const itemKind of sensitive) {
      assert.equal(guardBoardAction({ source, kind: 'approve', itemKind }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'deny', itemKind }).allowed, false);
    }
  }
});

test('acceptance: allowed item kinds still pass approve and deny on both sources', () => {
  for (const source of SOURCES) {
    for (const itemKind of ALLOWED_KINDS) {
      assert.deepEqual(guardBoardAction({ source, kind: 'approve', itemKind }), {
        allowed: true,
        reason: 'allowed',
      });
      assert.deepEqual(guardBoardAction({ source, kind: 'deny', itemKind }), {
        allowed: true,
        reason: 'allowed',
      });
    }
  }
});

test('createOwnerActions with the real guard refuses merge, deploy, and cap items server-side', async () => {
  for (const kind of ['merge', 'deploy', 'cap-raise', 'cap', 'migration']) {
    const actions = ownerActionsFixture([{
      id: `${kind}-item`,
      kind,
      title: `Sensitive ${kind}`,
      approvalPolicy: { humanApprovals: [kind] },
    }]);
    const prepared = await actions.prepare(`${kind}-item`, ownerReq());
    assert.equal(prepared.status, 403);
    assert.equal(prepared.body.error, 'owner-forbidden');
  }
});

test('decisionBoardSafeForOwner aligns with isProtectedTopic and boardSafe flags', () => {
  assert.equal(decisionBoardSafeForOwner({ kind: 'scope' }), true);
  assert.equal(decisionBoardSafeForOwner({ kind: 'decision', boardSafe: true, protectedTopic: false }), true);
  assert.equal(decisionBoardSafeForOwner({ kind: 'decision', boardSafe: false, protectedTopic: false }), false);
  assert.equal(decisionBoardSafeForOwner({ kind: 'decision', boardSafe: true, protectedTopic: true }), false);
  for (const text of ['merge this PR', 'deploy to prod', 'raise the cap', 'rotate keys']) {
    assert.equal(isProtectedTopic(text), true);
    assert.equal(decisionBoardSafeForOwner({
      kind: 'decision',
      boardSafe: true,
      protectedTopic: true,
    }), false);
  }
});

test('owner prepare refuses non-board-safe decisions before guard is bypassed', async () => {
  const actions = ownerActionsFixture([{
    id: 'theme-merge',
    kind: 'decision',
    boardSafe: true,
    protectedTopic: true,
    title: 'merge colors',
    choiceOptions: ['yes', 'no'],
    approvalPolicy: { humanApprovals: [] },
  }]);
  const out = await actions.prepare('theme-merge', ownerReq(), { choice: 'yes' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'decision-not-board-safe');
});

test('fail-closed: unknown sources and decision kinds never reach apply', async () => {
  const calls = [];
  const actions = createOwnerActions({
    listItems: () => [{ id: 'scope-1', kind: 'scope', title: 'Scope', approvalPolicy: { humanApprovals: ['scope'] } }],
    appendAudit: () => {},
    readAudit: () => [],
    guard: args => {
      calls.push(args);
      return guardBoardAction(args);
    },
    now: () => 1_000_000,
    randomId: () => 'cfm-1',
    ownerIdentities: [OWNER],
    verifyIdentity: () => true,
  });
  assert.equal((await actions.prepare('scope-1', ownerReq())).status, 200);
  assert.equal(calls.every(c => c.source === 'board'), true);
  assert.equal(guardBoardAction({ source: 'api', kind: 'approve', itemKind: 'scope' }).allowed, false);
});
