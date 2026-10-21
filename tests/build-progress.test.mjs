// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProgress, progressSummary } from '../tools/build-progress.mjs';
import { projectDetail, projectOverview } from '../tools/board-data.mjs';
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

test('deployment status lights the deployed milestone without changing finished', async t => {
  const plain = await fixture(t, { tickets: [ticket('T-0001', 'done')] });
  assert.deepEqual((await buildProgress({ ...plain, now: NOW })).milestones.find(item => item.key === 'deployed'), {
    key: 'deployed', label: 'Deployed', state: 'unknown', at: null, evidence: 'not tracked',
  });

  const merged = await fixture(t, {
    tickets: [ticket('T-0001', 'done')],
    history: [
      { kind: 'pr', projectId: 'project-fixture', at: iso(NOW - 2 * DAY), ref: '#1' },
      { kind: 'merge', projectId: 'project-fixture', at: iso(NOW - DAY), ref: '#1' },
    ],
  });
  const deployed = await buildProgress({ ...merged, now: NOW, deploy: { latest: { state: 'success' }, lastSuccess: { state: 'success', environment: 'production', at: iso(NOW), url: null } } });
  const deployedMilestone = deployed.milestones.find(item => item.key === 'deployed');
  assert.equal(deployedMilestone.state, 'done');
  assert.match(deployedMilestone.evidence, /production/);

  const old = await buildProgress({ ...merged, now: NOW, deploy: { latest: { state: 'success', at: iso(NOW - 2 * DAY) }, lastSuccess: { state: 'success', environment: 'stale', at: iso(NOW - 2 * DAY), url: null } } });
  assert.notEqual(old.milestones.find(item => item.key === 'deployed').state, 'done');

  const failed = await buildProgress({ ...plain, now: NOW, deploy: { latest: { state: 'failure', at: iso(NOW - 1000) }, lastSuccess: null } });
  assert.match(failed.milestones.find(item => item.key === 'deployed').evidence, /^last deploy failed/);
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

test('project detail keeps full progress and uses injected family spend while overview stays summarized', async t => {
  const data = await fixture(t, { tickets: [ticket('T-0001', 'done')] });
  const project = { id: data.projectId, name: 'Fixture', root: data.root };
  const summary = async () => ({ spendUsd: 3, capUsd: 10, reached: false, why: null });
  const detail = await projectDetail(project, { now: NOW, historyFile: data.historyFile, summary });
  assert.ok(detail.progress);
  assert.ok(detail.progress.percent);
  assert.ok(Array.isArray(detail.progress.milestones));
  assert.ok(Array.isArray(detail.progress.stages));
  assert.equal(detail.progress.spend.usd, 3);
  assert.equal(detail.progress.spend.capUsd, 10);
  assert.equal(detail.progress.spend.reached, false);
  assert.equal(detail.progress.spend.why, null);

  const overview = await projectOverview(project, [], { now: NOW, historyFile: data.historyFile, summary });
  assert.deepEqual(Object.keys(overview.progress).sort(), ['current', 'eta', 'finished', 'overall', 'ticketsPct'].sort());
  assert.deepEqual(overview.progress, { overall: 50, ticketsPct: 100, current: 'PR open', eta: null, finished: false });
});

test('shared history cache filters projects and refreshes after an append', async t => {
  const aData = await fixture(t, { tickets: [ticket('T-1001', 'todo')] });
  const bData = await fixture(t, { tickets: [ticket('T-1002', 'todo')] });
  const historyFile = path.join(aData.root, 'shared-history.ndjson');
  await fs.writeFile(historyFile, [
    { kind: 'pr', projectId: 'project-a', at: iso(NOW - DAY), ref: '#A1', title: 'A PR' },
    { kind: 'pr', projectId: 'project-b', at: iso(NOW - DAY), ref: '#B1', title: 'B PR' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const a = await buildProgress({ ...aData, projectId: 'project-a', now: NOW, historyFile });
  const b = await buildProgress({ ...bData, projectId: 'project-b', now: NOW, historyFile });
  assert.equal(a.milestones.find(item => item.key === 'pr').evidence, '#A1');
  assert.equal(b.milestones.find(item => item.key === 'pr').evidence, '#B1');

  await fs.appendFile(historyFile, `${JSON.stringify({ kind: 'pr', projectId: 'project-a', at: iso(NOW + 1000), ref: '#A2', title: 'A PR 2' })}\n`);
  const refreshed = await buildProgress({ ...aData, projectId: 'project-a', now: NOW, historyFile });
  assert.equal(refreshed.milestones.find(item => item.key === 'pr').evidence, '#A2');
});
