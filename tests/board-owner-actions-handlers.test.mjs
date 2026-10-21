// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerActions } from '../tools/board-owner-actions.mjs';

const identity = 'owner@example.test';
const req = (overrides = {}) => ({
  tokenOk: true,
  headers: { 'Tailscale-User-Login': identity },
  local: false,
  agentSession: false,
  tokenInQuery: false,
  ...overrides,
});

function fixture({ item = { id: 'item-1', kind: 'scope', title: 'Review scope' }, policy = { humanApprovals: ['scope'] }, guardResult = { allowed: true }, clock = 1000 } = {}) {
  let time = clock;
  const audit = [];
  let sequence = 0;
  const actions = createOwnerActions({
    listItems: () => [{ ...item, policy }],
    appendAudit: entry => audit.push(entry),
    readAudit: () => audit,
    guard: args => {
      assert.equal(args.source, 'board');
      return guardResult;
    },
    now: () => time,
    randomId: () => `confirm-${++sequence}`,
    ownerIdentities: [identity, 'other@example.test'],
    confirmTtlMs: 100,
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

test('invalid and non-owner-decidable items are refused', async () => {
  const { actions } = fixture();
  assert.equal((await actions.prepare('../item', req())).status, 404);
  assert.equal((await actions.prepare('missing', req())).status, 404);
  const notHuman = fixture({ policy: { humanApprovals: [] } });
  assert.equal((await notHuman.actions.prepare('item-1', req())).status, 422);
  const guarded = fixture({ guardResult: { allowed: false, reason: 'refused-kind' } });
  assert.equal((await guarded.actions.prepare('item-1', req())).status, 403);
});

test('decision consumes confirmation, records approve and deny, and rejects replay', async () => {
  const { actions, audit } = fixture();
  const prepared = await actions.prepare('item-1', req());
  const approved = await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req());
  assert.equal(approved.status, 200);
  assert.equal(approved.body.result, 'approved');
  assert.deepEqual(audit[0], { at: new Date(1000).toISOString(), itemId: 'item-1', decision: 'approve', identity, outcome: 'approved' });
  assert.equal((await actions.decide('item-1', { decision: 'approve', confirm: prepared.body.confirmToken }, req())).status, 409);
  const next = await actions.prepare('item-1', req());
  const denied = await actions.decide('item-1', { decision: 'deny', confirm: next.body.confirmToken }, req());
  assert.equal(denied.status, 200);
  assert.equal(denied.body.result, 'denied');
  assert.equal(audit.length, 3);
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

