// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScopes, impactAnalysis, nextChangeOrderId, applyChangeOrder } from '../tools/change-orders.mjs';
import { parseScope } from '../tools/scope.mjs';

const SCOPE_TEXT = `# Scope: Parts Request App
Version: 1

## Overview
Parts requests for workshops.

## Stages
- S1: Foundations
- S2: Requests

## S1 Foundations
### R-001 A signed-in user can create a parts request.
Acceptance:
- The form needs a part name and a quantity of at least 1.
- A saved request appears in the list within one second.

### R-002 A user can pay for a request with Stripe payments.
Acceptance:
- A test card payment marks the request as paid.

## S2 Requests
### R-003 An owner gets an email from the email provider when a request is paid.
Acceptance:
- The email arrives within 60 seconds.

### R-004 An owner can export requests as CSV.
Acceptance:
- The CSV has one row per request.
`;

const base = parseScope(SCOPE_TEXT);
const clone = (v) => JSON.parse(JSON.stringify(v));
const edit = (fn) => { const s = clone(base); fn(s); return s; };
const reqOf = (s, id) => s.requirements.find((r) => r.id === id);
const dropReq = (s, id) => { s.requirements = s.requirements.filter((r) => r.id !== id); };

test('diffScopes reports an added requirement', () => {
  const next = edit((s) => { s.requirements.push({ id: 'R-005', stage: 'S2', text: 'An owner can see totals.', acceptance: ['Totals match the sum of rows.'], line: 99 }); });
  assert.deepEqual(diffScopes(base, next).added, ['R-005']);
});

test('diffScopes reports a removed requirement', () => {
  const next = edit((s) => dropReq(s, 'R-004'));
  assert.deepEqual(diffScopes(base, next).removed, ['R-004']);
});

test('diffScopes reports a requirement changed by text', () => {
  const next = edit((s) => { reqOf(s, 'R-001').text = 'A signed-in user can create a parts request quickly.'; });
  const d = diffScopes(base, next);
  assert.deepEqual(d.changed, ['R-001']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test('diffScopes reports a requirement changed by acceptance', () => {
  const next = edit((s) => { reqOf(s, 'R-004').acceptance = ['The CSV has one row per request and a header row.']; });
  assert.deepEqual(diffScopes(base, next).changed, ['R-004']);
});

test('diffScopes finds no changes between identical scopes', () => {
  const d = diffScopes(base, clone(base));
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.changed, []);
});

test('diffScopes reports stages added and removed', () => {
  const next = edit((s) => { s.stages.push({ id: 'S3', title: 'Extra', order: 3 }); s.stages = s.stages.filter((x) => x.id !== 'S2'); });
  const d = diffScopes(base, next);
  assert.deepEqual(d.stagesAdded, ['S3']);
  assert.deepEqual(d.stagesRemoved, ['S2']);
});

test('impactAnalysis cancels a ticket whose only refs were removed and retags a mixed one', () => {
  const diff = diffScopes(base, edit((s) => dropReq(s, 'R-004')));
  const tickets = [
    { id: 'T-0001', status: 'todo', scopeRefs: ['R-004'] },
    { id: 'T-0002', status: 'ready', scopeRefs: ['R-001', 'R-004'] },
    { id: 'T-0003', status: 'todo', scopeRefs: ['R-001'] },
  ];
  const impact = impactAnalysis({ diff, tickets });
  assert.deepEqual(impact.cancel, ['T-0001']);
  assert.deepEqual(impact.retag, [{ ticket: 'T-0002', remove: ['R-004'] }]);
  assert.ok(impact.affected.includes('T-0001'));
  assert.ok(impact.affected.includes('T-0002'));
  assert.ok(!impact.affected.includes('T-0003'));
});

test('impactAnalysis reopens done and review tickets on changed requirements only', () => {
  const diff = diffScopes(base, edit((s) => { reqOf(s, 'R-001').text = 'A signed-in user can create a parts request quickly.'; }));
  const tickets = [
    { id: 'T-0010', status: 'done', scopeRefs: ['R-001'] },
    { id: 'T-0011', status: 'todo', scopeRefs: ['R-001'] },
    { id: 'T-0012', status: 'review', scopeRefs: ['R-001'] },
  ];
  assert.deepEqual(impactAnalysis({ diff, tickets }).reopen, ['T-0010', 'T-0012']);
});

test('impactAnalysis asks for tickets for added and uncovered changed requirements', () => {
  const next = edit((s) => {
    s.requirements.push({ id: 'R-005', stage: 'S2', text: 'An owner can see totals.', acceptance: ['Totals match the sum of rows.'], line: 99 });
    reqOf(s, 'R-001').text = 'A signed-in user can create a parts request quickly.';
    reqOf(s, 'R-003').acceptance = ['The email arrives within 30 seconds.'];
  });
  const diff = diffScopes(base, next);
  const impact = impactAnalysis({ diff, tickets: [{ id: 'T-1', status: 'todo', scopeRefs: ['R-001'] }] });
  assert.deepEqual(impact.needTickets, ['R-005', 'R-003']);
  // Two requirements are not two tickets: with no finished stage to learn from, four tickets per requirement are assumed, and no dollar figure is invented.
  assert.equal(impact.estimate.requirements, 2);
  assert.equal(impact.estimate.newTickets, 8);
  assert.equal(impact.estimate.usd, null);
  assert.equal(impact.estimate.learned, false);
});

test('impactAnalysis resets transitive dependents of a reopened chain of three tickets', () => {
  const diff = diffScopes(base, edit((s) => { reqOf(s, 'R-001').text = 'A signed-in user can create a parts request quickly.'; }));
  const tickets = [
    { id: 'T-A', status: 'done', scopeRefs: ['R-001'] },
    { id: 'T-B', status: 'ready', scopeRefs: ['R-002'], deps: ['T-A'] },
    { id: 'T-C', status: 'running', scopeRefs: ['R-003'], deps: ['T-B'] },
    { id: 'T-D', status: 'todo', scopeRefs: ['R-004'], deps: ['T-A'] },
    { id: 'T-E', status: 'cancelled', scopeRefs: ['R-004'], deps: ['T-A'] },
  ];
  const impact = impactAnalysis({ diff, tickets });
  assert.deepEqual(impact.reopen, ['T-A']);
  assert.deepEqual(impact.dependentsReset, ['T-B', 'T-C']);
  assert.equal(impact.estimate.dependentsReset, 2);
});

test('applyChangeOrder moves a reopened chain and its dependents back to todo and records them', () => {
  const diff = diffScopes(base, edit((s) => { reqOf(s, 'R-001').text = 'A signed-in user can create a parts request quickly.'; }));
  const tickets = [
    { id: 'T-A', status: 'done', scopeRefs: ['R-001'] },
    { id: 'T-B', status: 'ready', scopeRefs: ['R-002'], deps: ['T-A'] },
    { id: 'T-C', status: 'running', scopeRefs: ['R-003'], deps: ['T-B'] },
    { id: 'T-D', status: 'todo', scopeRefs: ['R-004'], deps: ['T-A'] },
    { id: 'T-E', status: 'cancelled', scopeRefs: ['R-004'], deps: ['T-A'] },
  ];
  const impact = impactAnalysis({ diff, tickets });
  const l = { version: 1, scope: null, tickets, changeOrders: [], approved: null, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' };
  const next = applyChangeOrder(l, { impact, diff, reason: 'Reword R-001', by: 'owner', now: '2025-01-03T00:00:00.000Z' });
  const status = (id) => next.tickets.find((t) => t.id === id).status;
  assert.equal(status('T-A'), 'todo');
  assert.equal(status('T-B'), 'todo');
  assert.equal(status('T-C'), 'todo');
  assert.equal(status('T-D'), 'todo');
  assert.equal(status('T-E'), 'cancelled');
  assert.deepEqual(next.changeOrders[0].dependentsReset, ['T-B', 'T-C']);
  assert.equal(next.changeOrders[0].impact.dependentsReset, 2);
  assert.equal(next.tickets.length, tickets.length);
});

test('applyChangeOrder records retagged refs as ticket and removed', () => {
  const diff = diffScopes(base, edit((s) => dropReq(s, 'R-004')));
  const tickets = [
    { id: 'T-0002', status: 'ready', scopeRefs: ['R-001', 'R-004'] },
    { id: 'T-0004', status: 'todo', scopeRefs: ['R-004', 'R-002'] },
  ];
  const impact = impactAnalysis({ diff, tickets });
  const l = { version: 1, scope: null, tickets, changeOrders: [], approved: null, createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' };
  const next = applyChangeOrder(l, { impact, diff, reason: 'Drop CSV', by: 'owner', now: '2025-01-04T00:00:00.000Z' });
  assert.deepEqual(next.changeOrders[0].retagged, [{ ticket: 'T-0002', removed: ['R-004'] }, { ticket: 'T-0004', removed: ['R-004'] }]);
  assert.deepEqual(next.changeOrders[0].dependentsReset, []);
});

test('nextChangeOrderId starts at CO-001 and increments', () => {
  assert.equal(nextChangeOrderId({ changeOrders: [] }), 'CO-001');
  assert.equal(nextChangeOrderId({ changeOrders: [{ id: 'CO-001' }] }), 'CO-002');
});

const ledger = {
  version: 1,
  scope: { name: 'Parts Request App', version: 1, hash: 'h1' },
  tickets: [
    { id: 'T-0001', status: 'todo', scopeRefs: ['R-004'] },
    { id: 'T-0002', status: 'ready', scopeRefs: ['R-001', 'R-004'] },
    { id: 'T-0003', status: 'done', scopeRefs: ['R-001'] },
  ],
  changeOrders: [],
  approved: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
};
const nextScope = edit((s) => { dropReq(s, 'R-004'); reqOf(s, 'R-001').text = 'A signed-in user can create a parts request quickly.'; });
const diff = diffScopes(base, nextScope);
const impact = impactAnalysis({ diff, tickets: ledger.tickets });
const scopeMeta = { name: 'Parts Request App', version: 2, hash: 'h2' };
const applyIt = (l = ledger) => applyChangeOrder(l, { impact, diff, reason: 'Drop CSV export', by: 'owner', now: '2025-01-02T00:00:00.000Z', scope: scopeMeta });

test('applyChangeOrder cancels and reopens the right tickets', () => {
  const next = applyIt();
  assert.equal(next.tickets.find((t) => t.id === 'T-0001').status, 'cancelled');
  assert.equal(next.tickets.find((t) => t.id === 'T-0003').status, 'todo');
});

test('applyChangeOrder removes retagged refs and keeps status', () => {
  const t = applyIt().tickets.find((x) => x.id === 'T-0002');
  assert.deepEqual(t.scopeRefs, ['R-001']);
  assert.equal(t.status, 'ready');
});

test('applyChangeOrder replaces scope meta and records the change order', () => {
  const next = applyIt();
  assert.deepEqual(next.scope, scopeMeta);
  assert.equal(next.changeOrders.length, 1);
  const co = next.changeOrders[0];
  assert.equal(co.id, 'CO-001');
  assert.deepEqual(co.cancelled, ['T-0001']);
  assert.deepEqual(co.reopened, ['T-0003']);
  assert.equal(co.diff.removed, 1);
  assert.equal(co.diff.changed, 1);
});

test('applyChangeOrder keeps history: cancelled tickets stay in the ledger', () => {
  const next = applyIt();
  assert.equal(next.tickets.length, ledger.tickets.length);
  assert.ok(next.tickets.some((t) => t.id === 'T-0001' && t.status === 'cancelled'));
});

test('applyChangeOrder does not mutate its input', () => {
  const before = JSON.stringify(ledger);
  const impactBefore = JSON.stringify(impact);
  applyIt();
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(JSON.stringify(impact), impactBefore);
});
