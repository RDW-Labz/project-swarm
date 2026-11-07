// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTicketPaths,
  applyTicketPathWiring,
  addingDepCreatesCycle,
} from '../tools/ticket-paths.mjs';
import {
  filterProvableAcceptance,
  provabilityOfAcceptanceLine,
  wireAcceptancePathDependencies,
} from '../tools/acceptance-provable.mjs';

const REPO = [
  'package.json',
  'tools/watch-assets/robot-alpha.js',
  'src/lib/existing.ts',
];

test('test ticket: new file in tests is not a missing-file error', () => {
  const ticket = {
    id: 'T-0100',
    type: 'test',
    files: [],
    tests: ['tests/unit/typed-part.test.ts'],
    context: [],
    contracts: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
});

test('build ticket: multiple new e2e specs in tests are allowed', () => {
  const ticket = {
    id: 'T-0101',
    type: 'build',
    files: ['src/lib/existing.ts'],
    tests: ['e2e/checkout.spec.ts', 'e2e/cart.spec.ts'],
    context: [],
    contracts: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, true);
});

test('test ticket: supabase rls sql in tests is allowed when new', () => {
  const ticket = {
    id: 'T-0102',
    type: 'test',
    files: [],
    tests: ['supabase/tests/rls.sql'],
    context: [],
    contracts: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, true);
});

test('build ticket: new module and component files are allowed', () => {
  const ticket = {
    id: 'T-0103',
    type: 'build',
    files: ['src/lib/new-module.ts', 'src/components/NewPart.tsx'],
    tests: [],
    context: [],
    contracts: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, true);
});

test('contract ticket: contracts/api.json in files and contracts is allowed when new', () => {
  const ticket = {
    id: 'T-0104',
    type: 'contract',
    files: ['contracts/api.json'],
    contracts: ['contracts/api.json'],
    tests: [],
    context: [],
  };
  const r = validateTicketPaths(ticket, { repoFiles: REPO });
  assert.equal(r.ok, true);
});

test('build ticket: contracts read owned by contract ticket auto-adds dependsOn', () => {
  const t1 = {
    id: 'T-0001',
    type: 'contract',
    files: ['contracts/api.json'],
    tests: [],
    context: [],
    contracts: [],
    dependsOn: [],
  };
  const t2 = {
    id: 'T-0002',
    type: 'build',
    files: ['src/lib/existing.ts'],
    contracts: ['contracts/api.json'],
    tests: [],
    context: [],
    dependsOn: [],
  };
  const all = [t1, t2];
  const wired = applyTicketPathWiring(t2, all, { repoFiles: REPO });
  assert.equal(wired.ok, true);
  assert.ok(t2.dependsOn.includes('T-0001'));
  assert.match(wired.notes.join('\n'), /T-0002: added dependency on T-0001 \(owns contracts\/api\.json\)/);
});

test('acceptance glob with repo match is provable', () => {
  const ticket = {
    id: 'T-0200',
    type: 'build',
    files: ['src/lib/existing.ts'],
    acceptance: ['UI mounts tools/watch-assets/robot-*.js for every agent'],
    dependsOn: [],
  };
  const verdict = provabilityOfAcceptanceLine({
    line: ticket.acceptance[0],
    ticket,
    allowed: new Set(['src/lib/existing.ts']),
    allTickets: [ticket],
    repoFiles: REPO,
  });
  assert.equal(verdict.provable, true);
});

test('acceptance glob with owning ticket adds dependency', () => {
  const owner = {
    id: 'T-0001',
    type: 'build',
    files: ['tools/watch-assets/robot-beta.js'],
    tests: [],
    dependsOn: [],
  };
  const ticket = {
    id: 'T-0002',
    type: 'build',
    files: ['src/lib/existing.ts'],
    acceptance: ['UI mounts tools/watch-assets/robot-*.js for every agent'],
    dependsOn: [],
  };
  const notes = [];
  wireAcceptancePathDependencies(ticket, [owner, ticket], [], { notes });
  assert.ok(ticket.dependsOn.includes('T-0001'));
  const filtered = filterProvableAcceptance({
    ticket,
    allowed: new Set(['src/lib/existing.ts']),
    allTickets: [owner, ticket],
    repoFiles: [],
  });
  assert.equal(filtered.dropped.length, 0);
});

test('unowned missing context path stays an error with suggestion', () => {
  const ticket = {
    id: 'T-0300',
    type: 'build',
    files: ['src/lib/existing.ts'],
    context: ['docs/plan.mdd'],
    tests: [],
    contracts: [],
  };
  const repo = [...REPO, 'docs/plan.md'];
  const r = validateTicketPaths(ticket, { repoFiles: repo });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].field, 'context');
  assert.equal(r.errors[0].suggestion, 'docs/plan.md');
});

test('cycle: context path owned by dependent is dropped with warning, ticket kept', () => {
  const owner = {
    id: 'T-0001',
    type: 'build',
    files: ['src/other/new.ts'],
    dependsOn: ['T-0002'],
    context: [],
    tests: [],
  };
  const ticket = {
    id: 'T-0002',
    type: 'build',
    files: ['src/lib/existing.ts'],
    context: ['src/other/new.ts'],
    dependsOn: [],
    tests: [],
  };
  assert.equal(addingDepCreatesCycle('T-0002', 'T-0001', [owner, ticket]), true);
  const wired = applyTicketPathWiring(ticket, [owner, ticket], { repoFiles: REPO });
  assert.equal(wired.ok, true);
  assert.ok(!ticket.context.includes('src/other/new.ts'));
  assert.ok(wired.warnings.some((w) => w.code === 'context-dropped' || /cycle/i.test(w.message ?? '')));
});
