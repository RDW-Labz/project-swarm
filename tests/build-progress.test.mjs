// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProgress, progressSummary } from '../tools/build-progress.mjs';
import { approveLedger, createLedger, writeLedger } from '../tools/tickets.mjs';
import { scopeHash } from '../tools/scope.mjs';

const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const DAY = 86400000;
const iso = at => new Date(at).toISOString();
const scopeText = `# Scope: Build progress fixture
Version: 1

## Stages
- S1: Foundation
- S2: Polish

## S1 Foundation
### R-001 Users can build
Acceptance:
- A build completes

## S2 Polish
### R-002 Users can test
Acceptance:
- A test passes
`;
const ticket = (id, status, extra = {}) => ({ id, title: `Ticket ${id}`, type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, steps: ['step'], status, stage: 'S1', ...extra });

async function fixture(t, { tickets, approved = true, history = [], journal = [], log = [] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-')));
  const historyFile = path.join(root, 'history.ndjson');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), scopeText);
  const scope = { file: 'docs/scope/scope.md', hash: scopeHash(scopeText) };
  let ledger = createLedger({ scope, tickets });
  if (approved) ledger = approveLedger(ledger, { now: NOW - DAY });
  await writeLedger(root, ledger);
  await fs.writeFile(path.join(root, '.swarm/project/journal.ndjson'), journal.map(event => JSON.stringify(event)).join('\n') + (journal.length ? '\n' : ''));
  await fs.writeFile(path.join(root, '.swarm/project/tickets.log'), log.map(event => JSON.stringify(event)).join('\n') + (log.length ? '\n' : ''));
  await fs.writeFile(historyFile, history.map(event => JSON.stringify(event)).join('\n') + (history.length ? '\n' : ''));
  return { root, historyFile, projectId: 'project-fixture' };
}

test('percent, requirements, stages and left buckets exclude cancelled and proposed tickets', async t => {
  const data = await fixture(t, {
    approved: false,
    tickets: [
      ticket('T-0001', 'done'),
      ticket('T-0002', 'running', { type: 'test', stage: 'S2', acceptanceBlocked: { reason: 'needs a real device' } }),
      ticket('T-0003', 'blocked', { type: 'human', stage: 'S2', scopeRefs: ['R-002'], blockReason: 'waiting on owner' }),
      ticket('T-0004', 'todo', { type: 'docs', stage: 'S3', scopeRefs: ['R-002'] }),
      ticket('T-0005', 'proposed', { title: 'Proposed work' }),
      ticket('T-0006', 'cancelled', { title: 'Cancelled work' }),
    ],
    journal: [{ kind: 'decision', id: 'D-1', confirm: true, text: 'Choose a launch date' }],
  });
  const p = await buildProgress({ ...data, now: NOW });
  assert.deepEqual(p.percent.tickets, { done: 1, total: 4, pct: 25 });
  assert.deepEqual(p.percent.requirements, { covered: 0, total: 2, pct: 0 });
  assert.equal(p.percent.overall, 0);
  assert.deepEqual(p.stages.map(stage => [stage.id, stage.total, stage.done, stage.open, stage.blocked]), [
    ['S1', 1, 1, 0, 0], ['S2', 2, 0, 2, 1], ['S3', 1, 0, 1, 0],
  ]);
  assert.deepEqual(p.left.openByType, { docs: 1, human: 1, test: 1 });
  assert.deepEqual(p.left.human, [{ id: 'T-0003', title: 'Ticket T-0003', stage: 'S2' }]);
  assert.ok(p.left.blockers.some(item => item.id === 'T-0003' && item.reason === 'waiting on owner'));
  assert.ok(p.left.blockers.some(item => item.id === 'T-0002' && item.reason === 'needs a real device'));
  assert.deepEqual(p.left.approvals.map(item => item.kind), ['scope', 'proposal', 'decision']);
});

test('milestones have one current item and an older merge does not satisfy merged', async t => {
  const data = await fixture(t, {
    tickets: [ticket('T-0001', 'done')],
    history: [
      { kind: 'merge', projectId: 'project-fixture', at: iso(NOW - 2 * DAY), ref: '#8', title: 'Merged' },
      { kind: 'pr', projectId: 'project-fixture', at: iso(NOW - DAY), ref: '#8', title: 'PR opened' },
    ],
  });
  const p = await buildProgress({ ...data, now: NOW });
  assert.equal(p.milestones.find(item => item.key === 'pr').state, 'done');
  assert.equal(p.milestones.find(item => item.key === 'merged').state, 'current');
  assert.equal(p.milestones.filter(item => item.state === 'current').length, 1);
  assert.equal(p.milestones.find(item => item.state === 'current').key, 'merged');
  assert.equal(p.milestones.find(item => item.key === 'deployed').state, 'unknown');
  assert.equal(progressSummary(p).current, 'Merged');
});

test('eta needs two recent done times and calculates days from a fourteen-day rate', async t => {
  const data = await fixture(t, {
    tickets: [ticket('T-0001', 'done'), ticket('T-0002', 'done'), ticket('T-0003', 'todo')],
    log: [
      { event: 'transition', id: 'T-0001', to: 'done', at: iso(NOW - DAY) },
      { event: 'transition', id: 'T-0002', to: 'done', at: iso(NOW - 2 * DAY) },
    ],
  });
  const p = await buildProgress({ ...data, now: NOW });
  assert.deepEqual(p.eta, { remaining: 1, perDay: 0.14, days: 8, basis: '2 done in the last 14 days' });
  const onlyOne = await fixture(t, { tickets: [ticket('T-0001', 'done'), ticket('T-0002', 'todo')], log: [{ event: 'transition', id: 'T-0001', to: 'done', at: iso(NOW - DAY) }] });
  assert.equal((await buildProgress({ ...onlyOne, now: NOW })).eta, null);
});

test('finished requires covered requirements, e2e green and a current merge', async t => {
  const data = await fixture(t, {
    tickets: [ticket('T-0001', 'done', { scopeRefs: ['R-001'] }), ticket('T-0002', 'done', { scopeRefs: ['R-002'], stage: 'S2' })],
    history: [{ kind: 'pr', projectId: 'project-fixture', at: iso(NOW - DAY), ref: '#9', title: 'PR' }, { kind: 'merge', projectId: 'project-fixture', at: iso(NOW), ref: '#9', title: 'Merge' }],
  });
  const p = await buildProgress({ ...data, now: NOW });
  assert.equal(p.finished, true);
  assert.equal(progressSummary(p).current, 'Finished');
  const blocked = await fixture(t, { tickets: [ticket('T-0001', 'done', { acceptanceResults: [{ n: 1, by: 'test', verdict: 'fail' }] })], history: [{ kind: 'pr', projectId: 'project-fixture', at: iso(NOW), ref: '#1', title: 'PR' }, { kind: 'merge', projectId: 'project-fixture', at: iso(NOW), ref: '#1', title: 'Merge' }] });
  assert.equal((await buildProgress({ ...blocked, now: NOW })).finished, false);
});

test('missing ledger, scope, journal and history never throws and records notes', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-missing-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = await buildProgress({ root, projectId: 'missing', now: NOW, historyFile: path.join(root, 'missing-history.ndjson') });
  assert.equal(p.percent.requirements, null);
  assert.equal(p.eta, null);
  assert.equal(p.spend, null);
  assert.equal(p.finished, false);
  assert.ok(p.notes.some(note => /ledger/i.test(note)));
  assert.ok(p.notes.some(note => /scope/i.test(note)));
  assert.ok(p.notes.some(note => /journal/i.test(note)));
  assert.ok(p.notes.some(note => /history/i.test(note)));
});
