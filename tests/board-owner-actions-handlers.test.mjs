// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerActions } from '../tools/board-owner-actions.mjs';
import { guardBoardAction } from '../tools/board-action-guard.mjs';

const identity = 'owner@example.test';
const req = (overrides = {}) => ({
  tokenOk: true,
  headers: { 'Tailscale-User-Login': identity },
  tailnetVerified: true,
  local: false,
  agentSession: false,
  tokenInQuery: false,
  ...overrides,
});

function fixture({
  item = { id: 'item-1', kind: 'scope', title: 'Review scope', projectRoot: '/tmp/project' },
  policy = { humanApprovals: ['scope'] },
  guardResult = { allowed: true },
  guardImpl,
  clock = 1000,
  verifyIdentity = () => true,
  apply = async () => ({ ok: true }),
} = {}) {
  let time = clock;
  const audit = [];
  let sequence = 0;
  const actions = createOwnerActions({
    listItems: () => [{ ...item, policy }],
    appendAudit: entry => audit.push(entry),
    readAudit: () => audit,
    guard: args => {
      assert.equal(args.source, 'board');
      return guardImpl ? guardImpl(args) : guardResult;
    },
    apply,
    now: () => time,
    randomId: () => `confirm-${++sequence}`,
    ownerIdentities: [identity, 'other@example.test'],
    confirmTtlMs: 100,
    verifyIdentity,
  });
  return { actions, audit, setTime: value => { time = value; } };
}

test('prepare returns an expiring confirmation bound to the owner and item', async () => {
  const { actions } = fixture();
  const out = await actions.prepare('item-1', req());
  assert.equal(out.status, 200);
  assert.equal(out.body.confirmToken, 'confirm-1');
  assert.equal(out.body.expiresAt, new Date(1100).toISOString());
  assert.equal(out.body.summary, 'Review scope');
});

test('all owner-route authentication refusals use the contract status classes', async () => {
  const { actions } = fixture();
  assert.equal((await actions.prepare('item-1', req({ tokenOk: false }))).status, 403);
  assert.equal((await actions.prepare('item-1', req({ tokenInQuery: true }))).status, 401);
  assert.equal((await actions.prepare('item-1', req({ headers: {} }))).status, 401);
  assert.equal((await actions.prepare('item-1', req({ headers: { 'Tailscale-User-Login': 'stranger@example.test' } }))).status, 403);
  assert.equal((await actions.prepare('item-1', req({ agentSession: true }))).status, 403);
  assert.equal((await actions.prepare('item-1', req({ local: true }))).status, 403);
});

test('requires strict boolean request markers', async () => {
  const expectedStatus = { tokenOk: 403, tokenInQuery: 401, agentSession: 403, local: 403 };
  for (const [field, status] of Object.entries(expectedStatus)) {
    for (const value of [undefined, 'false', 0, 1]) {
      const overrides = { [field]: value };
      if (value === undefined) delete overrides[field];
      const request = req(overrides);
      if (value === undefined) delete request[field];
      assert.equal((await fixture().actions.prepare('item-1', request)).status, status, `${field}=${String(value)}`);
    }
  }
});

test('requires a verified tailnet identity and an injected verifier', async () => {
  assert.equal((await fixture().actions.prepare('item-1', req({ tailnetVerified: false }))).status, 401);
  assert.equal((await fixture({ verifyIdentity: () => false }).actions.prepare('item-1', req())).status, 401);
});

test('invalid and non-owner-decidable items are refused', async () => {
  const { actions } = fixture();
  assert.equal((await actions.prepare('../item', req())).status, 404);
  assert.equal((await actions.prepare('missing', req())).status, 404);
  const notHuman = fixture({ policy: { humanApprovals: [] } });
  assert.equal((await notHuman.actions.prepare('item-1', req())).status, 422);
  const guarded = fixture({ guardResult: { allowed: false, reason: 'refused-kind' } });
  assert.equal((await guarded.actions.prepare('item-1', req())).status, 403);
});

test('refuses mismatched action-kind aliases before approval or guard checks', async () => {
  for (const field of ['actionKind', 'action', 'itemKind']) {
    const { actions, audit } = fixture({ item: { id: 'item-1', kind: 'scope', [field]: ' DEPLOY ', title: 'Review scope' } });
    assert.equal((await actions.prepare('item-1', req())).status, 409);
    const refused = await actions.decide('item-1', { decision: 'approve', confirm: '' }, req());
    assert.equal(refused.status, 409);
    assert.equal(audit.at(-1).outcome, 'refused-kind-mismatch');
  }
});

test('decision consumes confirmation, records approve and deny, and rejects replay', async () => {
  const { actions, audit } = fixture();
  const prepared = await actions.prepare('item-1', req());
  const approved = await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req());
  assert.equal(approved.status, 200);
  assert.equal(approved.body.result, 'approved');
  assert.deepEqual(audit[0], { at: new Date(1000).toISOString(), itemId: 'item-1', decision: 'approve', identity, outcome: 'approved', kind: 'scope' });
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req())).status, 409);
  const next = await actions.prepare('item-1', req());
  const denied = await actions.decide('item-1', { decision: 'deny', confirm: next.body.confirmToken }, req());
  assert.equal(denied.status, 200);
  assert.equal(denied.body.result, 'denied');
  assert.equal(audit.length, 3);
});

test('real action guard allows approve and deny, but refuses deploy items end to end', async () => {
  const allowed = fixture({ guardImpl: guardBoardAction });
  const preparedApprove = await allowed.actions.prepare('item-1', req());
  assert.equal(preparedApprove.status, 200);
  assert.equal((await allowed.actions.decide('item-1', { decision: 'approve', confirm: preparedApprove.body.confirmToken }, req())).status, 200);

  const preparedDeny = await allowed.actions.prepare('item-1', req());
  assert.equal(preparedDeny.status, 200);
  assert.equal((await allowed.actions.decide('item-1', { decision: 'deny', confirm: preparedDeny.body.confirmToken }, req())).status, 200);

  const refused = fixture({
    item: { id: 'item-1', kind: 'deploy', title: 'Deploy release' },
    guardImpl: guardBoardAction,
  });
  const refusedPrepare = await refused.actions.prepare('item-1', req());
  assert.equal(refusedPrepare.status, 403);
  assert.equal(refusedPrepare.body.error, 'owner-forbidden');
});

test('expired and wrong-identity confirmations are refused without consuming a wrong-owner confirmation', async () => {
  const { actions, setTime, audit } = fixture();
  const prepared = await actions.prepare('item-1', req());
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req({ headers: { 'Tailscale-User-Login': 'other@example.test' } }))).status, 409);
  assert.equal(audit.at(-1).outcome, 'refused-confirmation');
  setTime(1100);
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req())).status, 409);
  assert.equal(audit.at(-1).outcome, 'refused-confirmation-expired');
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req())).status, 409);
});

test('every refused decision is audited and audit output is newest first without secret fields', async () => {
  const { actions, audit, setTime } = fixture();
  const prepared = await actions.prepare('item-1', req());
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: 'confirm-other' }, req())).status, 409);
  setTime(1100);
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req({ tokenOk: false }))).status, 403);
  audit[0].confirm = 'tok-test';
  audit[0].headers = { 'x-watch-token': 'tok-test' };
  const out = await actions.audit(req());
  assert.equal(out.status, 200);
  assert.equal(out.body.length, 2);
  assert.equal(out.body[0].outcome, 'refused-authentication');
  assert.equal(JSON.stringify(out.body).includes('tok-test'), false);
  assert.equal((await actions.audit(req({ tokenInQuery: true }))).status, 401);
});

test('sweeps expired confirmations on prepare and decide', async () => {
  const items = [
    { id: 'item-1', kind: 'scope', title: 'One' },
    { id: 'item-2', kind: 'scope', title: 'Two' },
  ];
  let time = 1000;
  const actions = createOwnerActions({
    listItems: () => items,
    appendAudit: () => {},
    readAudit: () => [],
    guard: () => ({ allowed: true }),
    now: () => time,
    randomId: () => 'confirm-1',
    ownerIdentities: [identity],
    confirmTtlMs: 100,
    verifyIdentity: () => true,
  });
  const prepared = await actions.prepare('item-1', req());
  time = 1200;
  assert.equal((await actions.prepare('item-2', req())).status, 200);
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req())).status, 409);
});

test('caps pending confirmations at five per identity and drops the oldest', async () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `item-${i + 1}`, kind: 'scope', title: `Item ${i + 1}` }));
  let time = 1000;
  const actions = createOwnerActions({
    listItems: () => items,
    appendAudit: () => {},
    readAudit: () => [],
    guard: () => ({ allowed: true }),
    now: () => time,
    randomId: (() => { let n = 0; return () => `confirm-${++n}`; })(),
    ownerIdentities: [identity],
    confirmTtlMs: 60_000,
    verifyIdentity: () => true,
  });
  const tokens = [];
  for (const item of items) {
    const out = await actions.prepare(item.id, req());
    assert.equal(out.status, 200);
    tokens.push(out.body.confirmToken);
  }
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: tokens[0] }, req())).status, 409);
  assert.equal((await actions.decide('item-6', { decision: 'approve', confirm: tokens[5] }, req())).status, 200);
});

test('sanitizes crafted identities on refusal audit paths', async () => {
  const { actions, audit } = fixture();
  const crafted = 'owner@example.test/<script>';
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: '' }, req({ tokenOk: false, headers: { 'Tailscale-User-Login': crafted } }))).status, 403);
  assert.equal(audit.at(-1).identity, 'invalid');
  assert.equal((await actions.audit(req())).body.at(-1).identity, 'invalid');
});

test('multi-option decision prepares and answers with the exact choice', async () => {
  const themeItem = {
    id: 'theme-pick',
    kind: 'decision',
    title: 'pick a theme',
    boardSafe: true,
    protectedTopic: false,
    defaultChoice: 'dark',
    choiceOptions: ['dark', 'light', 'system'],
    projectRoot: '/tmp/project',
  };
  let applied = null;
  const { actions, audit } = fixture({
    item: themeItem,
    policy: { humanApprovals: [] },
    apply: async (item, answer) => {
      applied = { itemId: item.id, choice: answer.choice };
      return { ok: true };
    },
  });
  const prepared = await actions.prepare('theme-pick', req(), { choice: 'light' });
  assert.equal(prepared.status, 200);
  const answered = await actions.decide('theme-pick', { choice: 'light', confirm: prepared.body.confirmToken }, req());
  assert.equal(answered.status, 200);
  assert.deepEqual(applied, { itemId: 'theme-pick', choice: 'light' });
  assert.equal(audit.at(-1).choice, 'light');
  assert.equal(audit.at(-1).outcome, 'answered');
});

test('unknown decision choice is refused with unknown-choice', async () => {
  const { actions } = fixture({
    item: {
      id: 'theme-pick',
      kind: 'decision',
      boardSafe: true,
      protectedTopic: false,
      defaultChoice: 'dark',
      choiceOptions: ['dark', 'light', 'system'],
      projectRoot: '/tmp/project',
    },
    policy: { humanApprovals: [] },
  });
  assert.equal((await actions.prepare('theme-pick', req(), { choice: 'neon' })).status, 422);
  assert.equal((await actions.prepare('theme-pick', req(), { choice: 'neon' })).body.error, 'unknown-choice');
});

test('decision choice must match the prepared confirmation binding', async () => {
  const { actions } = fixture({
    item: {
      id: 'theme-pick',
      kind: 'decision',
      boardSafe: true,
      protectedTopic: false,
      defaultChoice: 'dark',
      choiceOptions: ['dark', 'light', 'system'],
      projectRoot: '/tmp/project',
    },
    policy: { humanApprovals: [] },
  });
  const prepared = await actions.prepare('theme-pick', req(), { choice: 'light' });
  const conflict = await actions.decide('theme-pick', { choice: 'system', confirm: prepared.body.confirmToken }, req());
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'confirm-conflict');
});

test('audit is written only after apply succeeds and apply failure returns apply-failed', async () => {
  const themeItem = {
    id: 'theme-pick',
    kind: 'decision',
    boardSafe: true,
    protectedTopic: false,
    defaultChoice: 'dark',
    choiceOptions: ['dark', 'light', 'system'],
    projectRoot: '/tmp/project',
  };
  let applyCalls = 0;
  const failing = fixture({
    item: themeItem,
    policy: { humanApprovals: [] },
    apply: async () => {
      applyCalls += 1;
      return { ok: false, message: 'nope' };
    },
  });
  const prepared = await failing.actions.prepare('theme-pick', req(), { choice: 'light' });
  const out = await failing.actions.decide('theme-pick', { choice: 'light', confirm: prepared.body.confirmToken }, req());
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'apply-failed');
  assert.equal(applyCalls, 1);
  assert.equal(failing.audit.some(entry => entry.outcome === 'answered'), false);
  assert.equal(failing.audit.at(-1).outcome, 'apply-failed');
});

