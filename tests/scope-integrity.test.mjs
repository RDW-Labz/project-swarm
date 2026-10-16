// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope } from '../tools/scope.mjs';
import { checkTicketTree, summarizeTree, formatSummary } from '../tools/scope-integrity.mjs';

const SCOPE = `# Scope: Parts Request App
Version: 1

## Overview
Signed-in users create parts requests.

## Stages
- S1: Foundations
- S2: Requests

## S1 Foundations
### R-001 A signed-in user can create a parts request.
Acceptance:
- The form needs a part name and a quantity of at least 1.
- A saved request appears in the list within one second.

### R-002 A signed-in user can pay for a request with Stripe payments.
Acceptance:
- A Stripe test payment of 10 dollars completes.

## S2 Requests
### R-003 The app sends a confirmation email through an email provider.
Acceptance:
- The email provider accepts the message within 5 seconds.

### R-004 A user can see the status of each request.
Acceptance:
- The status column shows one of 3 values.

## External
- Stripe: payments
- Email provider: confirmation emails

## Sensitive
- payments

## Protected
- .env
`;

const scope = parseScope(SCOPE);

const ticket = (over) => ({ id: 'T-0001', title: 'Build it', type: 'build', stage: 'S1', epic: 'E-01 Requests', scopeRefs: ['R-001'], acceptance: ['It works'], files: ['src/x.mjs'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', ...over });

const clean = () => [
  ticket({ id: 'T-0001', scopeRefs: ['R-001'], stage: 'S1', files: ['src/form.mjs'] }),
  ticket({ id: 'T-0002', scopeRefs: ['R-002'], stage: 'S1', files: ['src/pay.mjs'], dependsOn: ['T-0001'] }),
  ticket({ id: 'T-0003', scopeRefs: ['R-003'], stage: 'S2', files: ['src/mail.mjs'] }),
  ticket({ id: 'T-0004', scopeRefs: ['R-004'], stage: 'S2', files: ['src/status.mjs'] }),
];

const edit = (tickets, id, over) => tickets.map((t) => (t.id === id ? { ...t, ...over } : t));
const codes = (r) => r.errors.map((e) => e.code);

test('parseScope reads name, stages, requirements and lists', () => {
  assert.equal(scope.name, 'Parts Request App');
  assert.equal(scope.version, 1);
  assert.deepEqual(scope.stages.map((s) => s.id), ['S1', 'S2']);
  assert.deepEqual(scope.requirements.map((r) => r.id), ['R-001', 'R-002', 'R-003', 'R-004']);
  assert.equal(scope.requirements[0].acceptance.length, 2);
  assert.deepEqual(scope.external.map((e) => e.name), ['Stripe', 'Email provider']);
  assert.deepEqual(scope.sensitive, ['payments']);
});

test('clean tree passes with 100 percent coverage', () => {
  const r = checkTicketTree({ scope, tickets: clean() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.coveragePct, 100);
  assert.deepEqual(r.uncovered, []);
});

test('uncovered requirement is an error', () => {
  const r = checkTicketTree({ scope, tickets: clean().filter((t) => t.id !== 'T-0004') });
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncovered, ['R-004']);
  assert.equal(r.coveragePct, 75);
  assert.ok(codes(r).includes('uncovered'));
});

test('untraced build ticket is an error', () => {
  const tickets = [...clean(), ticket({ id: 'T-0005', scopeRefs: [], files: ['src/misc.mjs'] })];
  const r = checkTicketTree({ scope, tickets });
  assert.deepEqual(r.untraced, ['T-0005']);
  assert.ok(codes(r).includes('untraced'));
});

test('bad requirement reference is reported', () => {
  const tickets = [...clean(), ticket({ id: 'T-0005', scopeRefs: ['R-999'], files: ['src/misc.mjs'] })];
  const r = checkTicketTree({ scope, tickets });
  assert.deepEqual(r.badRefs, [{ ticket: 'T-0005', ref: 'R-999' }]);
  assert.ok(codes(r).includes('bad-ref'));
});

test('unknown dependency is reported', () => {
  const r = checkTicketTree({ scope, tickets: edit(clean(), 'T-0003', { dependsOn: ['T-9999'] }) });
  assert.deepEqual(r.unknownDeps, [{ ticket: 'T-0003', dep: 'T-9999' }]);
  assert.ok(codes(r).includes('unknown-dep'));
});

test('dependency cycle is reported', () => {
  const r = checkTicketTree({ scope, tickets: edit(clean(), 'T-0001', { dependsOn: ['T-0002'] }) });
  assert.equal(r.cycles.length, 1);
  assert.deepEqual([...r.cycles[0]].sort(), ['T-0001', 'T-0002']);
  assert.ok(codes(r).includes('cycle'));
});

test('two tickets in one wave sharing a file conflict', () => {
  const tickets = edit(edit(clean(), 'T-0001', { files: ['src/shared.mjs'] }), 'T-0003', { files: ['src/shared.mjs'] });
  const r = checkTicketTree({ scope, tickets });
  assert.deepEqual(r.conflicts, [{ wave: 0, file: 'src/shared.mjs', tickets: ['T-0001', 'T-0003'] }]);
  assert.ok(codes(r).includes('conflict'));
});

test('folder owned by one ticket conflicts with a file in the same wave', () => {
  const tickets = edit(edit(clean(), 'T-0001', { files: ['src/api/form.mjs'] }), 'T-0003', { files: ['src/api/'] });
  const r = checkTicketTree({ scope, tickets });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].file, 'src/api/');
  assert.deepEqual(r.conflicts[0].tickets, ['T-0001', 'T-0003']);
});

test('same file in different waves is not a conflict', () => {
  const r = checkTicketTree({ scope, tickets: edit(clean(), 'T-0002', { files: ['src/form.mjs'] }) });
  assert.deepEqual(r.conflicts, []);
});

test('size L ticket is oversize', () => {
  const r = checkTicketTree({ scope, tickets: edit(clean(), 'T-0003', { size: 'L' }) });
  assert.deepEqual(r.oversize, ['T-0003']);
  assert.ok(codes(r).includes('oversize'));
});

test('medium tickets beyond the stage budget are oversize', () => {
  const tickets = edit(edit(clean(), 'T-0001', { size: 'M' }), 'T-0002', { size: 'M' });
  const r = checkTicketTree({ scope, tickets, sizeBudget: { maxMediumPerStage: 1 } });
  assert.deepEqual(r.oversize, ['T-0002']);
});

test('missing acceptance on a build ticket is an error', () => {
  const r = checkTicketTree({ scope, tickets: edit(clean(), 'T-0001', { acceptance: [] }) });
  assert.deepEqual(r.missingAcceptance, ['T-0001']);
  assert.ok(codes(r).includes('missing-acceptance'));
});

test('summarizeTree reports the expected numbers', () => {
  const s = summarizeTree({ scope, tickets: clean() });
  assert.equal(s.tickets, 4);
  assert.equal(s.waves, 2);
  assert.deepEqual(s.byType, { build: 4 });
  assert.deepEqual(s.byRisk, { low: 4 });
  assert.equal(s.coveragePct, 100);
  assert.equal(s.humanTickets, 0);
  assert.equal(s.sensitiveTickets, 0);
  assert.deepEqual(s.estimate, { minutes: 6, usd: 0.012 });
  assert.deepEqual(s.stages, [
    { id: 'S1', title: 'Foundations', tickets: 2, requirements: 2 },
    { id: 'S2', title: 'Requests', tickets: 2, requirements: 2 },
  ]);
  assert.deepEqual(s.risks, []);
});

test('summarizeTree names human blockers and sensitive tickets as risks', () => {
  let tickets = edit(edit(clean(), 'T-0001', { sensitive: true }), 'T-0002', { dependsOn: ['T-0001', 'T-0005'] });
  tickets = [...tickets, ticket({ id: 'T-0005', type: 'human', scopeRefs: [], acceptance: [], files: [], stage: 'S1', steps: ['Create the Stripe account'] })];
  const s = summarizeTree({ scope, tickets });
  assert.ok(s.risks.some((r) => /human ticket/.test(r)));
  assert.ok(s.risks.some((r) => /sensitive/.test(r)));
});

test('summarizeTree names uncovered requirements as risks', () => {
  const s = summarizeTree({ scope, tickets: clean().filter((t) => t.id !== 'T-0004') });
  assert.ok(s.risks.some((r) => r.includes('R-004')));
});

test('formatSummary stays within 40 lines', () => {
  const s = { ...summarizeTree({ scope, tickets: clean() }), risks: Array.from({ length: 60 }, (_, i) => 'risk ' + i) };
  const text = formatSummary(s);
  assert.ok(text.split('\n').length <= 40);
  assert.match(text, /Coverage: 100%/);
});
