// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ALLOWED_BOARD_ACTIONS,
  ELEVATED_NEVER_FROM_BOARD,
  PAIRING_VALID_MS,
  PAIRING_LOCK_MS,
  isAllowedFromBoard,
  isItemElevated,
  createPairing,
  redeemPairing,
  deviceFromToken,
  issueDecisionIds,
  prepareDecision,
  commitDecision,
  listAudit,
} from '../tools/board-approve.mjs';

function fakeRandom(seq = [0, 1, 2, 3, 4, 5]) {
  let i = 0;
  return n => {
    const v = seq[i % seq.length];
    i += 1;
    return typeof n === 'number' ? v % n : v;
  };
}

async function makeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'board-approve-'));
  return {
    machineId: 'machine-a',
    projectId: 'proj-a',
    auditPath: path.join(dir, 'audit.ndjson'),
    data: {},
  };
}

async function registerDevice(store, { now = () => 1_000_000, random = fakeRandom() } = {}) {
  const { word } = createPairing({ store, now, random });
  const redeemed = redeemPairing({ store, word, deviceName: 'ipad', now, random });
  assert.equal(redeemed.ok, true);
  return redeemed;
}

test('ALLOWED_BOARD_ACTIONS and ELEVATED_NEVER_FROM_BOARD are frozen allow/deny lists', () => {
  assert.deepEqual(ALLOWED_BOARD_ACTIONS, ['choose', 'approve-ticket', 'decline', 'stop-all']);
  assert.ok(ELEVATED_NEVER_FROM_BOARD.includes('merge'));
  assert.ok(ELEVATED_NEVER_FROM_BOARD.includes('branch-D'));
});

test('isAllowedFromBoard rejects elevated git/kind and unknown actions', () => {
  const plain = { id: 'hb-abc', kind: 'handbuild', git: ['commit'] };
  assert.equal(isAllowedFromBoard(plain, 'choose', 'approve'), true);
  assert.equal(isAllowedFromBoard(plain, 'merge'), false);
  assert.equal(isAllowedFromBoard({ id: 'x', kind: 'decision', git: ['force-push'] }, 'decline'), false);
  assert.equal(isAllowedFromBoard({ id: 'x', kind: 'deploy' }, 'decline'), false);
  assert.equal(isAllowedFromBoard({ id: 'x', kind: 'ticket' }, 'approve-ticket'), true);
  assert.equal(isItemElevated({ git: ['cap raise'] }), true);
});

test('pairing word works once, expires, and three wrong tries lock', () => {
  let t = 1_000_000;
  const now = () => t;
  const random = fakeRandom();
  const store = { data: {} };

  const p1 = createPairing({ store, now, random });
  assert.equal(p1.ok, true);
  assert.match(p1.word, /^[a-z]+-[a-z]+-[a-z]+$/);

  const ok = redeemPairing({ store, word: p1.word, deviceName: 'phone', now, random });
  assert.equal(ok.ok, true);
  assert.ok(ok.token);
  const again = redeemPairing({ store, word: p1.word, deviceName: 'other', now, random });
  assert.equal(again.ok, false);

  const p2 = createPairing({ store, now, random });
  t += PAIRING_VALID_MS + 1;
  const expired = redeemPairing({ store, word: p2.word, deviceName: 'late', now, random });
  assert.equal(expired.error, 'pairing-expired');

  const store2 = { data: {} };
  createPairing({ store: store2, now, random });
  for (let i = 0; i < 3; i += 1) {
    const bad = redeemPairing({ store: store2, word: 'wrong-word', deviceName: 'x', now, random });
    assert.equal(bad.ok, false);
  }
  const locked = redeemPairing({ store: store2, word: 'anything', deviceName: 'x', now, random });
  assert.equal(locked.error, 'pairing-locked');
  t += PAIRING_LOCK_MS + 1;
  createPairing({ store: store2, now, random });
  const after = redeemPairing({ store: store2, word: 'wrong-word', deviceName: 'x', now, random });
  assert.notEqual(after.error, 'pairing-locked');
});

test('device token is stored only as a hash', async () => {
  const store = await makeStore();
  const { token } = await registerDevice(store);
  const raw = JSON.stringify(store.data);
  assert.ok(!raw.includes(token));
  assert.ok(Object.values(store.data.devices).every(d => d.tokenHash && !d.token));
  assert.ok(deviceFromToken(store, token)?.name === 'ipad');
  assert.equal(deviceFromToken(store, 'bogus'), null);
});

test('decision flow: prepare, commit, replay, expiry, device, elevated, csrf', async () => {
  let t = 5_000_000;
  const now = () => t;
  const random = fakeRandom([1, 2, 3, 4, 5, 6, 7, 8]);
  const store = await makeStore();
  const { token, deviceId } = await registerDevice(store, { now, random });

  const item = {
    id: 'handbuild-hb-xyz',
    kind: 'handbuild',
    projectId: 'my-proj',
    machineId: 'machine-a',
    git: ['commit'],
  };
  const { ids } = issueDecisionIds({ store, items: [item], deviceId, now, random });
  const decisionId = ids[0].decisionId;

  const noDev = await prepareDecision({
    store: { ...store, data: { devices: {} } },
    decisionId,
    action: 'choose',
    choice: 'approve',
    deviceToken: token,
    who: 'owner@tail',
    now,
  });
  assert.equal(noDev.error, 'no-device');

  const prep = await prepareDecision({
    store,
    decisionId,
    action: 'choose',
    choice: 'approve',
    deviceToken: token,
    who: 'owner@tail',
    now,
  });
  assert.equal(prep.ok, true);
  assert.match(prep.confirmText, /Approve hand-build hb-xyz on my-proj\?/);
  assert.ok(prep.csrf);

  let applyCalls = 0;
  const apply = async payload => {
    applyCalls += 1;
    assert.deepEqual(payload, {
      itemId: 'handbuild-hb-xyz',
      action: 'choose',
      channel: 'board',
      choice: 'approve',
      projectId: 'my-proj',
      machineId: 'machine-a',
    });
  };
  const committed = await commitDecision({
    store,
    decisionId,
    csrf: prep.csrf,
    deviceToken: token,
    who: 'owner@tail',
    now,
    apply,
  });
  assert.equal(committed.ok, true);
  assert.equal(applyCalls, 1);

  const replay = await commitDecision({
    store,
    decisionId,
    csrf: prep.csrf,
    deviceToken: token,
    who: 'owner@tail',
    now,
    apply,
  });
  assert.equal(replay.error, 'replayed');
  assert.equal(applyCalls, 1);

  const item2 = { id: 'd1', kind: 'decision', choices: ['a', 'b'], projectId: 'p', machineId: 'machine-a' };
  const issued2 = issueDecisionIds({ store, items: [item2], deviceId, now, random });
  const id2 = issued2.ids[0].decisionId;
  t += 25 * 60 * 60 * 1000;
  const expiredPrep = await prepareDecision({
    store,
    decisionId: id2,
    action: 'choose',
    choice: 'a',
    deviceToken: token,
    who: 'owner@tail',
    now,
  });
  assert.equal(expiredPrep.error, 'expired');

  const { token: otherToken } = await registerDevice(store, { now, random });
  const item3 = { id: 't1', kind: 'ticket', projectId: 'p', machineId: 'machine-a' };
  const issued3 = issueDecisionIds({ store, items: [item3], deviceId, now, random });
  const id3 = issued3.ids[0].decisionId;
  const wrongDev = await prepareDecision({
    store,
    decisionId: id3,
    action: 'approve-ticket',
    deviceToken: otherToken,
    who: 'owner@tail',
    now,
  });
  assert.equal(wrongDev.error, 'wrong-device');

  for (const git of ['merge', 'deploy', 'cap raise', 'force-push', 'branch-D']) {
    const elevated = { id: `e-${git}`, kind: 'handbuild', git: [git], projectId: 'p', machineId: 'machine-a' };
    const issued = issueDecisionIds({ store, items: [elevated], deviceId, now, random });
    const eid = issued.ids[0].decisionId;
    const prepE = await prepareDecision({
      store,
      decisionId: eid,
      action: 'decline',
      deviceToken: token,
      who: 'owner@tail',
      now,
    });
    assert.equal(prepE.error, 'disallowed-action');
  }

  const item4 = { id: 't2', kind: 'ticket', projectId: 'p', machineId: 'machine-a' };
  const issued4 = issueDecisionIds({ store, items: [item4], deviceId, now, random });
  const id4 = issued4.ids[0].decisionId;
  const badAction = await prepareDecision({
    store,
    decisionId: id4,
    action: 'merge',
    deviceToken: token,
    who: 'owner@tail',
    now,
  });
  assert.equal(badAction.error, 'disallowed-action');

  const prepA = await prepareDecision({
    store,
    decisionId: id4,
    action: 'approve-ticket',
    deviceToken: token,
    who: 'owner@tail',
    now,
  });
  const item5 = { id: 't3', kind: 'ticket', projectId: 'p', machineId: 'machine-a' };
  const issued5 = issueDecisionIds({ store, items: [item5], deviceId, now, random });
  const id5 = issued5.ids[0].decisionId;
  const prepB = await prepareDecision({
    store,
    decisionId: id5,
    action: 'approve-ticket',
    deviceToken: token,
    who: 'owner@tail',
    now,
  });
  const badCsrf = await commitDecision({
    store,
    decisionId: id5,
    csrf: prepA.csrf,
    deviceToken: token,
    who: 'owner@tail',
    now,
    apply: async () => {},
  });
  assert.equal(badCsrf.error, 'invalid-csrf');
});

test('audit log records every attempt without secrets', async () => {
  let t = 9_000_000;
  const now = () => t;
  const random = fakeRandom();
  const store = await makeStore();
  const { token, deviceId } = await registerDevice(store, { now, random });
  const { word } = createPairing({ store, now, random });

  const item = {
    id: 'handbuild-hb-audit',
    kind: 'handbuild',
    projectId: 'proj',
    machineId: 'machine-a',
    reason: 'secret reason must not leak',
  };
  const { ids } = issueDecisionIds({ store, items: [item], deviceId, now, random });
  const decisionId = ids[0].decisionId;

  const prep = await prepareDecision({
    store,
    decisionId,
    action: 'choose',
    choice: 'approve',
    deviceToken: token,
    who: 'braden@tailnet',
    now,
  });
  await commitDecision({
    store,
    decisionId,
    csrf: prep.csrf,
    deviceToken: token,
    who: 'braden@tailnet',
    now,
    apply: async () => {},
  });
  await prepareDecision({
    store,
    decisionId,
    action: 'decline',
    deviceToken: token,
    who: 'braden@tailnet',
    now,
  });

  const events = await listAudit({ store, limit: 100 });
  assert.ok(events.length >= 3);
  for (const e of events) {
    const line = JSON.stringify(e);
    assert.ok(!line.includes(token));
    assert.ok(!line.includes(word));
    assert.ok(!line.includes('secret reason'));
    assert.ok(e.who);
    assert.ok(e.machineId);
    assert.ok(e.result);
  }
  const file = await readFile(store.auditPath, 'utf8');
  assert.ok(!file.includes(token));
});
