// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairTicketBatch } from '../tools/split-repair.mjs';
import { validateTicket } from '../tools/tickets.mjs';
import { validateTicketPaths } from '../tools/ticket-paths.mjs';

const SCOPE = [
  '# Scope: Auto repair',
  'Version: 1',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 Feature',
  'Acceptance:',
  '- Works end to end.',
  '- Handles errors.',
  '',
].join('\n');

const base = (over = {}) => ({
  id: 'T-0001',
  title: 'Work',
  type: 'build',
  stage: 'S1',
  epic: 'E-00',
  scopeRefs: ['R-001'],
  files: [],
  context: [],
  contracts: [],
  tests: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'todo',
  ...over,
});

const exists = new Set(['src/existing.mjs']);
const pathExists = (p) => exists.has(p);

test('missing contract owned by another ticket becomes a dependency', () => {
  const owner = base({
    id: 'T-0001',
    files: ['contracts/cluster.json'],
    acceptance: ['ok'],
  });
  const reader = base({
    id: 'T-0002',
    contracts: ['contracts/cluster.json'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [owner, reader],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  const fixed = result.tickets.find(t => t.id === 'T-0002');
  assert.deepEqual(fixed.dependsOn, ['T-0001']);
  assert.ok(result.notes.some(n => n.includes('path-dependency')));
});

test('a missing owned file is treated as a new output (not parked)', () => {
  const ticket = base({
    files: ['supabase/migrations/0021_parts.sql'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [ticket],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  assert.deepEqual(result.tickets[0].files, ['supabase/migrations/0021_parts.sql']);
  const paths = validateTicketPaths(result.tickets[0], { exists: pathExists, allTickets: result.tickets });
  assert.equal(paths.errors.length, 0);
});

test('a context file created by another ticket becomes a dependency', () => {
  const owner = base({
    id: 'T-0001',
    files: ['src/parts/availability.mjs'],
    acceptance: ['ok'],
  });
  const reader = base({
    id: 'T-0002',
    context: ['src/parts/availability.mjs'],
    files: ['src/use-parts.mjs'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [owner, reader],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  assert.deepEqual(result.tickets.find(t => t.id === 'T-0002').dependsOn, ['T-0001']);
});

test('missing acceptance is filled from scopeRefs', () => {
  const ticket = base({ acceptance: [] });
  const result = repairTicketBatch({
    tickets: [ticket],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  assert.deepEqual(result.tickets[0].acceptance, ['Works end to end.', 'Handles errors.']);
  assert.ok(result.notes.some(n => n.includes('acceptance-copy')));
});

test('screens over 5 and non-kebab ids are normalized', () => {
  const ticket = base({
    acceptance: ['ok'],
    screens: ['Foo Bar', 'foo-bar', 'A__B', 'c', 'd', 'e', 'f'],
  });
  const result = repairTicketBatch({
    tickets: [ticket],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  assert.deepEqual(result.tickets[0].screens, ['foo-bar', 'a-b', 'cx', 'dx', 'ex']);
  assert.equal(validateTicket(result.tickets[0]).ok, true);
});

test('a child is kept after its rejected parent is repaired in the same batch', () => {
  const parent = base({
    id: 'T-0001',
    acceptance: [],
    files: ['src/parent.mjs'],
  });
  const child = base({
    id: 'T-0002',
    dependsOn: ['T-0001'],
    files: ['src/child.mjs'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [parent, child],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  assert.equal(result.tickets.length, 2);
  assert.equal(validateTicket(result.tickets.find(t => t.id === 'T-0001')).ok, true);
});

test('a genuinely unrepairable ticket is parked once with a precise reason', () => {
  const ticket = base({ size: 'L', acceptance: ['ok'], files: ['src/x.mjs'] });
  const result = repairTicketBatch({
    tickets: [ticket],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.tickets.length, 0);
  assert.equal(result.parked.length, 1);
  assert.match(result.parked[0].issues[0].reason, /size L/);
});
