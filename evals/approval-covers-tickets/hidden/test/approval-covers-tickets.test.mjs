import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { approve, isApproved } from '../src/approval-covers-tickets.mjs';

function hashOf(tickets) {
  const sorted = [...tickets]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((t) => ({ acceptance: t.acceptance, dependsOn: t.dependsOn, files: t.files, id: t.id, title: t.title }));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

const T1 = { id: 'T-1', title: 'Parse', acceptance: ['a works'], files: ['src/a.mjs'], dependsOn: [], status: 'open' };
const T2 = { id: 'T-2', title: 'Render', acceptance: ['b works'], files: ['src/b.mjs'], dependsOn: ['T-1'], status: 'open' };

function ledger(overrides = {}) {
  return { scopeHash: 'scope-1', tickets: [T1, T2], ...overrides };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

test('approve records at, scopeHash and the tickets hash', () => {
  const l = ledger();
  const out = approve(l, '2026-01-01T00:00:00Z');
  assert.deepEqual(out.approved, {
    at: '2026-01-01T00:00:00Z',
    scopeHash: 'scope-1',
    ticketsHash: hashOf(l.tickets),
  });
});

test('approve returns a new object and does not mutate the input', () => {
  const l = ledger();
  const before = clone(l);
  const out = approve(l, 'now');
  assert.notEqual(out, l);
  assert.deepEqual(l, before);
});

test('a fresh approval is valid', () => {
  assert.equal(isApproved(approve(ledger(), 'now')), true);
});

test('an unapproved ledger is not approved', () => {
  assert.equal(isApproved(ledger()), false);
});

test('changing only a status keeps the approval', () => {
  const a = approve(ledger(), 'now');
  const b = { ...a, tickets: [{ ...T1, status: 'done' }, T2] };
  assert.equal(isApproved(b), true);
});

test('changing an acceptance line removes the approval', () => {
  const a = approve(ledger(), 'now');
  const b = { ...a, tickets: [{ ...T1, acceptance: ['a works better'] }, T2] };
  assert.equal(isApproved(b), false);
});

test('changing dependsOn removes the approval', () => {
  const a = approve(ledger(), 'now');
  const b = { ...a, tickets: [T1, { ...T2, dependsOn: [] }] };
  assert.equal(isApproved(b), false);
});

test('adding a new ticket removes the approval (merged worker tickets)', () => {
  const a = approve(ledger(), 'now');
  const extra = { id: 'T-3', title: 'New', acceptance: ['c works'], files: ['src/c.mjs'], dependsOn: [], status: 'open' };
  const b = { ...a, tickets: [T1, T2, extra] };
  assert.equal(isApproved(b), false);
});

test('changing the scope hash removes the approval', () => {
  const a = approve(ledger(), 'now');
  assert.equal(isApproved({ ...a, scopeHash: 'scope-2' }), false);
});

test('input ticket order does not change the hash', () => {
  const a = approve(ledger({ tickets: [T2, T1] }), 'now');
  assert.equal(isApproved({ ...a, tickets: [T1, T2] }), true);
  assert.equal(a.approved.ticketsHash, hashOf([T1, T2]));
});
