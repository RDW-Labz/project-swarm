// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY0_CATALOG, day0Checklist, checklistToTickets } from '../tools/day0.mjs';
import { parseScope, checkScope } from '../tools/scope.mjs';
import { validateTicket } from '../tools/tickets.mjs';

const SCOPE_MD = `# Scope: Parts Request App
Version: 1

## Overview
Parts requests for a small workshop. Out of scope: shipping.

## Stages
- S1: Foundations
- S2: Requests

## S1 Foundations
### R-001 A signed-in user can pay for a parts request through Stripe payments.
Acceptance:
- The checkout total equals the sum of the line items.
- A failed payment leaves the request in draft.

### R-002 A requester can attach a note to a parts request.
Acceptance:
- The note accepts up to 500 characters.

### R-003 The app sends the requester an email through our email provider when a request is approved.
Acceptance:
- The email arrives within 60 seconds of approval.

## S2 Requests
### R-004 The header shows stripes in the brand colour.
Acceptance:
- The stripes render 4 pixels high.

## External
- Stripe: payments
- Domain: parts.example.com
- Ledgerwise: internal accounting

## Sensitive
- payments

## Protected
- .env
`;

const scope = parseScope(SCOPE_MD);
const items = day0Checklist(scope);
const byService = (name) => items.find((i) => i.service === name);

test('the fixture scope is valid', () => {
  assert.equal(checkScope(scope).ok, true);
  assert.deepEqual(scope.requirements.map((r) => r.id), ['R-001', 'R-002', 'R-003', 'R-004']);
});

test('catalog entries have unique ids, keywords and steps', () => {
  const ids = DAY0_CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of DAY0_CATALOG) {
    assert.ok(c.keywords.length > 0, c.id);
    assert.ok(c.steps.length > 0, c.id);
  }
});

test('stripe is found by keyword with the requirement that names it', () => {
  const stripe = byService('Stripe');
  assert.ok(stripe);
  assert.equal(stripe.kind, 'payments');
  assert.deepEqual(stripe.why, ['R-001']);
});

test('email is found from the provider wording in R-003', () => {
  assert.deepEqual(byService('Transactional email').why, ['R-003']);
});

test('an external entry matching the catalog is listed once as external', () => {
  const domains = items.filter((i) => i.service === 'Domain and DNS');
  assert.equal(domains.length, 1);
  assert.deepEqual(domains[0].why, ['external']);
});

test('ids are stable H-001 onward in catalog order', () => {
  assert.deepEqual(items.map((i) => i.id), ['H-001', 'H-002', 'H-003', 'H-004']);
  assert.deepEqual(items.map((i) => i.service), ['Stripe', 'Domain and DNS', 'Transactional email', 'Ledgerwise']);
});

test('unmatched external gets the generic item', () => {
  assert.deepEqual(byService('Ledgerwise'), {
    id: 'H-004',
    service: 'Ledgerwise',
    kind: 'external',
    why: ['external'],
    steps: ['Decide who owns the account', 'Create it and record where the keys go'],
  });
});

test('stripes does not match stripe', () => {
  const s = { name: 'x', overview: '', requirements: [{ id: 'R-004', text: 'The header shows stripes.', acceptance: ['The stripes are 4 pixels high.'] }], external: [] };
  assert.deepEqual(day0Checklist(s), []);
});

test('a keyword phrase in an acceptance line matches', () => {
  const s = { name: 'x', overview: '', requirements: [{ id: 'R-009', text: 'Users sign in.', acceptance: ['Sign in with Apple works on iOS.'] }], external: [] };
  const got = day0Checklist(s);
  assert.equal(got.length, 1);
  assert.equal(got[0].service, 'Sign in with Apple');
  assert.deepEqual(got[0].why, ['R-009']);
});

test('extra entries are appended after the catalog and generic items', () => {
  const got = day0Checklist(scope, { extra: [{ service: 'Print vendor', kind: 'manual', why: ['external'], steps: ['Pick a print shop'] }] });
  assert.equal(got.at(-1).id, 'H-005');
  assert.equal(got.at(-1).service, 'Print vendor');
  assert.deepEqual(got.at(-1).steps, ['Pick a print shop']);
});

test('empty scope gives an empty checklist', () => {
  assert.deepEqual(day0Checklist({ requirements: [], external: [] }), []);
});

test('checklist steps are copies, not the catalog arrays', () => {
  const copy = day0Checklist(scope);
  copy[0].steps.push('changed');
  assert.equal(DAY0_CATALOG[0].steps.includes('changed'), false);
});

test('checklistToTickets numbers tickets from T-9001', () => {
  const tickets = checklistToTickets(items);
  assert.deepEqual(tickets.map((t) => t.id), ['T-9001', 'T-9002', 'T-9003', 'T-9004']);
});

test('human ticket has the expected shape', () => {
  const [t] = checklistToTickets(items);
  assert.equal(t.type, 'human');
  assert.equal(t.title, 'Day 0: Stripe');
  assert.equal(t.stage, 'S0');
  assert.deepEqual(t.scopeRefs, []);
  assert.equal(t.status, 'todo');
  assert.equal(t.sensitive, false);
});

test('steps carry over to the tickets', () => {
  const tickets = checklistToTickets(items);
  assert.deepEqual(tickets[0].steps, items[0].steps);
  assert.ok(tickets[0].steps[0].startsWith('Create a Stripe account'));
});

test('every generated ticket passes validateTicket', () => {
  for (const t of checklistToTickets(items)) {
    assert.deepEqual(validateTicket(t), { ok: true, errors: [] });
  }
});

test('startAt moves the first id', () => {
  assert.equal(checklistToTickets(items, { startAt: 9100 })[0].id, 'T-9100');
});
