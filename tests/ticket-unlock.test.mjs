import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnlockable, unlockReady } from '../tools/ticket-unlock.mjs';

function done(id) {
  return { id, status: 'done', dependsOn: [] };
}

function blocked(id, dependsOn, extra) {
  return Object.assign({ id, status: 'blocked', dependsOn }, extra || {});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function byId(tickets, id) {
  return tickets.find((t) => t.id === id);
}

test('findUnlockable: empty input returns empty list', () => {
  assert.deepStrictEqual(findUnlockable([]), []);
});

test('findUnlockable: blocked ticket with all deps done and no blockReason is unlockable', () => {
  const tickets = [done('a'), blocked('t1', ['a'])];
  assert.deepStrictEqual(findUnlockable(tickets), ['t1']);
});

test('findUnlockable: blockReason deps is unlockable', () => {
  const tickets = [done('a'), blocked('t1', ['a'], { blockReason: 'deps' })];
  assert.deepStrictEqual(findUnlockable(tickets), ['t1']);
});

test('findUnlockable: blockReason failure is never returned', () => {
  const tickets = [done('a'), blocked('t1', ['a'], { blockReason: 'failure' })];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: blockReason manual is never returned', () => {
  const tickets = [done('a'), blocked('t1', ['a'], { blockReason: 'manual' })];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: a ticket with attempts is not returned', () => {
  const tickets = [done('a'), blocked('t1', ['a'], { attempts: 1 })];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: a ticket with a retryNote is not returned', () => {
  const tickets = [done('a'), blocked('t1', ['a'], { retryNote: 'try again' })];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: empty dependsOn is not returned', () => {
  const tickets = [blocked('t1', [])];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: non-array dependsOn is not returned', () => {
  const tickets = [done('a'), blocked('t1', 'a')];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: a missing dependency blocks the unlock', () => {
  const tickets = [blocked('t1', ['ghost'])];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: a cancelled dependency blocks the unlock', () => {
  const tickets = [{ id: 'a', status: 'cancelled', dependsOn: [] }, blocked('t1', ['a'])];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: a dependency that is not done blocks the unlock', () => {
  const tickets = [{ id: 'a', status: 'ready', dependsOn: [] }, blocked('t1', ['a'])];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: one unfinished dependency out of several blocks the unlock', () => {
  const tickets = [done('a'), { id: 'b', status: 'ready', dependsOn: [] }, blocked('t1', ['a', 'b'])];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: only blocked tickets are considered', () => {
  const tickets = [done('a'), { id: 'r', status: 'ready', dependsOn: ['a'] }, { id: 'd', status: 'done', dependsOn: ['a'] }];
  assert.deepStrictEqual(findUnlockable(tickets), []);
});

test('findUnlockable: returned ids are sorted', () => {
  const tickets = [done('a'), blocked('b', ['a']), blocked('c', ['a'])];
  assert.deepStrictEqual(findUnlockable(tickets), ['b', 'c']);
  const reversed = [done('a'), blocked('c', ['a']), blocked('b', ['a'])];
  assert.deepStrictEqual(findUnlockable(reversed), ['b', 'c']);
});

test('unlockReady: returns ledger copy with unlockable tickets set to ready and their ids', () => {
  const ledger = { approved: true, tickets: [done('a'), blocked('t1', ['a'])] };
  const result = unlockReady(ledger);
  assert.deepStrictEqual(result.unlocked, ['t1']);
  assert.equal(byId(result.ledger.tickets, 't1').status, 'ready');
  assert.equal(byId(result.ledger.tickets, 'a').status, 'done');
});

test('unlockReady: does not mutate its input', () => {
  const ledger = { approved: true, tickets: [done('a'), blocked('t1', ['a'])] };
  const snapshot = clone(ledger);
  unlockReady(ledger);
  assert.deepStrictEqual(ledger, snapshot);
});

test('unlockReady: returns a new ledger object, not the input', () => {
  const ledger = { approved: true, tickets: [done('a'), blocked('t1', ['a'])] };
  const result = unlockReady(ledger);
  assert.notEqual(result.ledger, ledger);
});

test('unlockReady: never changes approved (true stays true)', () => {
  const ledger = { approved: true, tickets: [done('a'), blocked('t1', ['a'])] };
  assert.equal(unlockReady(ledger).ledger.approved, true);
});

test('unlockReady: never changes approved (false stays false)', () => {
  const ledger = { approved: false, tickets: [done('a'), blocked('t1', ['a'])] };
  assert.equal(unlockReady(ledger).ledger.approved, false);
});

test('unlockReady: nothing unlockable returns empty list and unchanged statuses', () => {
  const ledger = { approved: true, tickets: [blocked('t1', ['ghost']), blocked('t2', ['a'], { blockReason: 'manual' })] };
  const result = unlockReady(ledger);
  assert.deepStrictEqual(result.unlocked, []);
  assert.equal(byId(result.ledger.tickets, 't1').status, 'blocked');
  assert.equal(byId(result.ledger.tickets, 't2').status, 'blocked');
});

test('unlockReady: empty ticket list returns empty unlocked list', () => {
  const result = unlockReady({ approved: true, tickets: [] });
  assert.deepStrictEqual(result.unlocked, []);
  assert.deepStrictEqual(result.ledger.tickets, []);
});

test('unlockReady: failure and manual tickets keep blocked status while deps ones unlock', () => {
  const ledger = {
    approved: true,
    tickets: [
      done('a'),
      blocked('ok', ['a']),
      blocked('fail', ['a'], { blockReason: 'failure' }),
      blocked('man', ['a'], { blockReason: 'manual' })
    ]
  };
  const result = unlockReady(ledger);
  assert.deepStrictEqual(result.unlocked, ['ok']);
  assert.equal(byId(result.ledger.tickets, 'ok').status, 'ready');
  assert.equal(byId(result.ledger.tickets, 'fail').status, 'blocked');
  assert.equal(byId(result.ledger.tickets, 'man').status, 'blocked');
});
