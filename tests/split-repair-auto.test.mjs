// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairTicketBatch, refreshRejectedDependents, detectSharedFileIssues } from '../tools/split-repair.mjs';
import { promotePathPendingTickets } from '../tools/scope-commands.mjs';
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

test('repair does not chain two tickets that write the same file', () => {
  const writerA = base({
    id: 'T-0001',
    files: ['src/pages/list.tsx'],
    acceptance: ['ok'],
  });
  const writerB = base({
    id: 'T-0002',
    files: ['src/pages/list.tsx'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [writerA, writerB],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.parked.length, 0);
  const a = result.tickets.find(t => t.id === 'T-0001');
  const b = result.tickets.find(t => t.id === 'T-0002');
  assert.deepEqual(a.dependsOn, []);
  assert.deepEqual(b.dependsOn, []);
  assert.ok(!result.notes.some(n => /path-dependency.*list\.tsx/i.test(n)));
  const conflicts = detectSharedFileIssues(result.tickets);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'src/pages/list.tsx');
  assert.match(conflicts[0].reason, /T-0001.*T-0002|T-0002.*T-0001/);
});

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

test('path-new-file recomputes sensitive for auth outputs (never clears an existing true)', () => {
  const tagged = base({
    id: 'T-0001',
    contracts: ['src/lib/auth/login.mjs'],
    acceptance: ['ok'],
    sensitive: false,
  });
  const already = base({
    id: 'T-0002',
    files: ['src/plain.mjs'],
    acceptance: ['ok'],
    sensitive: true,
  });
  const taggedResult = repairTicketBatch({
    tickets: [tagged],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(taggedResult.tickets[0].sensitive, true);
  assert.ok(taggedResult.notes.some(n => n.includes('sensitive-refresh')));
  const kept = repairTicketBatch({
    tickets: [already],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(kept.tickets[0].sensitive, true);
});

test('refreshRejectedDependents restores a validated ticket into the accepted list', () => {
  const child = base({
    id: 'T-0002',
    dependsOn: ['T-0001'],
    files: ['src/child.mjs'],
    acceptance: ['ok'],
  });
  const rejected = [{ id: 'T-0002', title: child.title, reason: 'depends on rejected T-0001' }];
  const refreshed = refreshRejectedDependents({
    tickets: [],
    rejected,
    repairedIds: new Set(['T-0001']),
    candidateTickets: [child],
    exists: pathExists,
  });
  assert.equal(refreshed.rejected.length, 0);
  assert.equal(refreshed.tickets.length, 1);
  assert.equal(refreshed.tickets[0].id, 'T-0002');
  assert.ok(refreshed.notes.some(n => n.includes('ticket restored')));
});

test('missing repo paths stay parked with a pending path-gate reason', () => {
  const ticket = base({
    context: ['docs/not-in-repo-yet.md'],
    files: ['src/use.mjs'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [ticket],
    ledgerTickets: [],
    scopeText: SCOPE,
    pathExists,
  });
  assert.equal(result.tickets.length, 0);
  assert.equal(result.parked.length, 1);
  assert.equal(result.parked[0].parkedReason, 'path-not-in-repo-pending');
  assert.equal(result.parked[0].ticket.pathPending, true);
  assert.ok(result.parked[0].issues.some(i => /pending path gate/i.test(i.reason)));
});

test('refreshRejectedDependents restores child when repaired parent is still listed in rejected', () => {
  const parent = base({
    id: 'T-0001',
    files: ['src/parent.mjs'],
    acceptance: ['ok'],
  });
  const child = base({
    id: 'T-0002',
    dependsOn: ['T-0001'],
    files: ['src/child.mjs'],
    acceptance: ['ok'],
  });
  const rejected = [
    { id: 'T-0001', title: parent.title, reason: 'bad shape' },
    { id: 'T-0002', title: child.title, reason: 'depends on rejected T-0001' },
  ];
  const refreshed = refreshRejectedDependents({
    tickets: [parent],
    rejected,
    repairedIds: new Set(['T-0001']),
    candidateTickets: [child],
    exists: pathExists,
  });
  assert.equal(refreshed.rejected.map(r => r.id).sort().join(','), 'T-0001');
  assert.equal(refreshed.tickets.length, 2);
  assert.ok(refreshed.tickets.some(t => t.id === 'T-0002'));
});

test('refreshRejectedDependents waits until every dependsOn parent is accepted', () => {
  const p1 = base({ id: 'T-0001', files: ['src/a.mjs'], acceptance: ['ok'] });
  const p2 = base({ id: 'T-0002', files: ['src/b.mjs'], acceptance: ['ok'] });
  const child = base({
    id: 'T-0003',
    dependsOn: ['T-0001', 'T-0002'],
    files: ['src/c.mjs'],
    acceptance: ['ok'],
  });
  const rejected = [
    { id: 'T-0003', title: child.title, reason: 'depends on rejected T-0001' },
  ];
  const onlyOneParent = refreshRejectedDependents({
    tickets: [p1],
    rejected,
    repairedIds: new Set(['T-0001']),
    candidateTickets: [p2, child],
    exists: pathExists,
  });
  assert.equal(onlyOneParent.rejected.length, 1);
  assert.equal(onlyOneParent.tickets.length, 1);
  const bothParents = refreshRejectedDependents({
    tickets: [p1, p2],
    rejected: onlyOneParent.rejected,
    repairedIds: new Set(['T-0001', 'T-0002']),
    candidateTickets: [child],
    exists: pathExists,
  });
  assert.equal(bothParents.rejected.length, 0);
  assert.ok(bothParents.tickets.some(t => t.id === 'T-0003'));
});

test('path dependency skips cancelled or done owner tickets', () => {
  const cancelledOwner = base({
    id: 'T-0001',
    status: 'cancelled',
    files: ['src/shared.mjs'],
    acceptance: ['ok'],
  });
  const activeOwner = base({
    id: 'T-0002',
    files: ['src/shared.mjs'],
    acceptance: ['ok'],
  });
  const reader = base({
    id: 'T-0003',
    context: ['src/shared.mjs'],
    files: ['src/reader.mjs'],
    acceptance: ['ok'],
  });
  const result = repairTicketBatch({
    tickets: [reader],
    ledgerTickets: [cancelledOwner, activeOwner],
    scopeText: SCOPE,
    pathExists,
  });
  const fixed = result.tickets.find(t => t.id === 'T-0003');
  assert.deepEqual(fixed.dependsOn, ['T-0002']);
});

test('promoted path-pending tickets drop pathPending before ledger ingest', () => {
  const ticket = base({
    context: ['docs/now-in-repo.md'],
    files: ['src/use.mjs'],
    acceptance: ['ok'],
    pathPending: true,
  });
  const pathPendingParked = [{
    parkedReason: 'path-not-in-repo-pending',
    ticket,
    issues: [{ reason: 'pending path gate' }],
  }];
  const repoFiles = ['docs/now-in-repo.md', 'src/existing.mjs'];
  const localExists = (p) => exists.has(p) || repoFiles.includes(p);
  const result = promotePathPendingTickets(pathPendingParked, [], {
    repoFiles,
    acceptNewPaths: new Set(),
    pathExists: localExists,
  });
  assert.equal(result.pathPendingParked.length, 0);
  assert.equal(result.tickets.length, 1);
  assert.equal('pathPending' in result.tickets[0], false);
});

test('repairTicketBatch is deterministic for the same input', () => {
  const tickets = [
    base({ id: 'T-0001', files: ['src/a.mjs'], acceptance: ['ok'] }),
    base({
      id: 'T-0002',
      context: ['src/a.mjs'],
      files: ['src/b.mjs'],
      acceptance: ['ok'],
    }),
  ];
  const opts = { tickets, ledgerTickets: [], scopeText: SCOPE, pathExists };
  const a = repairTicketBatch(opts);
  const b = repairTicketBatch(opts);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
