// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildProgress } from '../tools/build-progress.mjs';
import { projectDetail, projectOverview } from '../tools/board-data.mjs';
import { approveLedger, createLedger, writeLedger } from '../tools/tickets.mjs';
import { parseScope, scopeHash } from '../tools/scope.mjs';

const execFileP = promisify(execFile);
const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const DAY = 86400000;
const iso = at => new Date(at).toISOString();
const roadmapFile = fileURLToPath(new URL('../docs/scope/roadmap.md', import.meta.url));

async function git(root, args) {
  return execFileP('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
}

function buildTicket(id, requirementId, stage, status) {
  return {
    id, title: `Build ${id}`, type: 'build', stage, status, scopeRefs: [requirementId], acceptance: ['the requirement is implemented'], files: [`src/${id}.txt`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, steps: ['implement the requirement'],
  };
}

function humanTicket(id) {
  return {
    id, title: `Owner step ${id}`, type: 'human', stage: 'S1', status: 'todo', scopeRefs: [], acceptance: ['the owner completes the step'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, steps: ['make the owner decision'],
  };
}

async function roadmapFixture(t, { doneCount = 12, doneAgeDays = 1 } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-roadmap-'));
  const main = path.join(temp, 'main');
  const linked = path.join(temp, 'linked');
  await fs.mkdir(path.join(main, 'docs/scope'), { recursive: true });
  const fullText = await fs.readFile(roadmapFile, 'utf8');
  const oldText = fullText.slice(0, fullText.indexOf('\n### R-040'));
  const fullScope = parseScope(fullText);
  const oldScope = parseScope(oldText);
  // S9 Cluster adds R-052–R-065 (51 original scope requirements plus 14 cluster = 65 total).
  assert.equal(fullScope.requirements.length, 65);
  assert.equal(oldScope.requirements.length, 39);
  await fs.writeFile(path.join(main, 'docs/scope/roadmap.md'), oldText);
  await git(main, ['init', '-q']);
  await git(main, ['config', 'user.name', 'Roadmap Fixture']);
  await git(main, ['config', 'user.email', 'roadmap@example.invalid']);
  await git(main, ['add', 'docs/scope/roadmap.md']);
  await git(main, ['commit', '-qm', 'old roadmap']);
  await git(main, ['worktree', 'add', '-q', '-b', 'roadmap-full', linked]);
  await fs.writeFile(path.join(linked, 'docs/scope/roadmap.md'), fullText);

  const oldTickets = oldScope.requirements.map((requirement, index) => buildTicket(`T-${String(index + 1).padStart(4, '0')}`, requirement.id, requirement.stage, 'todo'));
  const oldLedger = approveLedger(createLedger({ scope: { file: 'docs/scope/roadmap.md', hash: scopeHash(oldText) }, tickets: oldTickets, now: NOW - 3 * DAY }), { now: NOW - 3 * DAY });
  await writeLedger(main, oldLedger);

  const tickets = fullScope.requirements.map((requirement, index) => buildTicket(`T-${String(index + 1).padStart(4, '0')}`, requirement.id, requirement.stage, index < doneCount ? 'done' : 'todo'));
  tickets.push(humanTicket('T-9001'), humanTicket('T-9002'));
  const worktreeLedger = approveLedger(createLedger({ scope: { file: 'docs/scope/roadmap.md', hash: scopeHash(fullText) }, tickets, now: NOW }), { now: NOW });
  await writeLedger(linked, worktreeLedger);
  const log = tickets.slice(0, doneCount).map((ticket, index) => JSON.stringify({ event: 'transition', id: ticket.id, to: 'done', at: iso(NOW - (doneAgeDays + index / 10) * DAY) })).join('\n');
  await fs.writeFile(path.join(linked, '.swarm/project/tickets.log'), log ? `${log}\n` : '');
  const historyFile = path.join(temp, 'history.ndjson');
  await fs.writeFile(historyFile, '');
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { main, linked: await fs.realpath(linked), historyFile, oldLedger, worktreeLedger, project: { id: 'roadmap-fixture', name: 'Roadmap fixture', root: await fs.realpath(main) } };
}

async function writeRun(root, runId, state) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: runId, ...state }));
}

test('build progress follows the newest approved roadmap ledger across linked worktrees and excludes human tickets', async t => {
  const fixture = await roadmapFixture(t);
  const progress = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(progress.source.root, fixture.linked);
  assert.equal(progress.source.differs, true);
  assert.equal(progress.source.candidates, 2);
  assert.equal(progress.percent.requirements.total, 65);
  assert.equal(progress.percent.requirements.covered, 12);
  assert.deepEqual(progress.percent.tickets, { done: 12, total: 65, pct: 18 });
  assert.match(progress.eta.basis, /14 days/);
  assert.equal(progress.eta.remaining, 53);
  assert.equal(progress.left.human.length, 2);
  assert.ok(progress.notes.includes(`ledger read from ${path.basename(fixture.linked)} (newest approved of 2 checkouts)`));

  const overview = await projectOverview(fixture.project, [], { now: NOW, historyFile: fixture.historyFile, summary: async () => ({}) });
  assert.deepEqual([overview.tickets.total, overview.tickets.open, overview.tickets.stage], [65, 53, 'Ticket Manager v2']);
  assert.deepEqual(overview.progress, { overall: 18, ticketsPct: 18, current: 'Building', eta: progress.eta.days, finished: false, offLedger: 0, headline: 'build 12/65 · human 0/2', untracked: { runs: 0, jobs: 0 } });

  const detail = await projectDetail(fixture.project, { now: NOW, historyFile: fixture.historyFile, summary: async () => ({}) });
  assert.equal(detail.ticketCounts.total, 65);
  assert.equal(detail.tickets.length, 67);
});

test('an approved main ledger wins over a newer but unapproved linked ledger', async t => {
  const fixture = await roadmapFixture(t);
  await writeLedger(fixture.linked, { ...fixture.worktreeLedger, approved: null, updatedAt: iso(NOW + DAY) });
  const progress = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(progress.source.root, fixture.project.root);
  assert.equal(progress.source.differs, false);
  assert.equal(progress.percent.requirements.total, 39);
  assert.equal(progress.percent.tickets.total, 39);
});

test('ETA widens from fourteen to thirty days, then to all recorded completions', async t => {
  const thirty = await roadmapFixture(t, { doneCount: 2, doneAgeDays: 20 });
  const thirtyProgress = await buildProgress({ root: thirty.main, projectId: thirty.project.id, now: NOW, historyFile: thirty.historyFile });
  assert.match(thirtyProgress.eta.basis, /^2 done in the last 30 days$/);
  assert.equal(thirtyProgress.eta.remaining, 63);

  const since = await roadmapFixture(t, { doneCount: 2, doneAgeDays: 60 });
  const sinceProgress = await buildProgress({ root: since.main, projectId: since.project.id, now: NOW, historyFile: since.historyFile });
  assert.match(sinceProgress.eta.basis, /^2 done since /);

  const missing = await roadmapFixture(t, { doneCount: 1, doneAgeDays: 1 });
  const missingProgress = await buildProgress({ root: missing.main, projectId: missing.project.id, now: NOW, historyFile: missing.historyFile });
  assert.equal(missingProgress.eta, null);
  assert.ok(missingProgress.notes.includes('no completion times recorded in tickets.log'));
});

test('roadmap progress excludes cancelled, proposed and human tickets, normalizes messy refs, and maps wrong stages to requirements', async t => {
  const fixture = await roadmapFixture(t, { doneCount: 0 });
  const tickets = fixture.worktreeLedger.tickets.map(ticket => ({ ...ticket, status: 'cancelled' }));
  const byId = id => tickets.find(ticket => ticket.id === id);
  Object.assign(byId('T-0001'), { status: 'done', stage: 'S6', scopeRefs: ['R-001'] });
  Object.assign(byId('T-0007'), { status: 'done', stage: 'S6', scopeRefs: ['r-007 tickets sized'] });
  Object.assign(byId('T-0008'), { status: 'done', stage: 'S0', scopeRefs: [] });
  Object.assign(byId('T-0009'), { status: 'done', stage: null, scopeRefs: [] });
  tickets.push(humanTicket('T-9001'), { ...byId('T-0008'), id: 'T-9010', status: 'proposed', title: 'Proposed work' });
  await writeLedger(fixture.linked, approveLedger({ ...fixture.worktreeLedger, tickets }, { now: NOW }));
  const progress = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.deepEqual(progress.percent.tickets, { done: 4, total: 4, pct: 100 });
  assert.deepEqual(progress.percent.requirements, { covered: 2, total: 65, pct: 3 });
  assert.equal(progress.percent.overall, 100);
  assert.deepEqual(progress.stages.filter(stage => stage.total > 0).map(stage => [stage.stageId, stage.title, stage.total]), [
    ['S0', 'Stage 0', 1], ['S1', 'Unblock autonomy', 1], ['S2', 'Ticket Manager v2', 1], ['none', 'No stage', 1],
  ]);
  assert.deepEqual(progress.left.human.map(item => [item.stageId, item.stage]), [['S1', 'Unblock autonomy']]);
});

test('scope milestones ignore unrelated PRs and accept linked PRs only after approval; current is the latest reached milestone', async t => {
  const fixture = await roadmapFixture(t, { doneCount: 0 });
  const ticket = { ...fixture.worktreeLedger.tickets[0], pr: '#42' };
  const tickets = fixture.worktreeLedger.tickets.map(item => item.id === ticket.id ? ticket : item);
  await writeLedger(fixture.linked, approveLedger({ ...fixture.worktreeLedger, tickets }, { now: NOW }));
  await fs.writeFile(fixture.historyFile, [
    { kind: 'pr', projectId: fixture.project.id, at: iso(NOW), ref: '#999', title: 'Unrelated repository PR' },
    { kind: 'pr', projectId: fixture.project.id, at: iso(NOW - 3600000), ref: '#42', title: 'Before approval' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const before = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(before.milestones.find(item => item.key === 'pr').state, 'todo');

  await writeLedger(fixture.linked, approveLedger({ ...fixture.worktreeLedger, tickets }, { now: NOW - 2 * DAY }));
  await fs.appendFile(fixture.historyFile, `${JSON.stringify({ kind: 'pr', projectId: fixture.project.id, at: iso(NOW - DAY), ref: '#42', title: 'Linked PR after approval' })}\n`);
  const after = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(after.milestones.find(item => item.key === 'pr').state, 'current');
  assert.equal(after.milestones.find(item => item.key === 'pr').currentDone, true);
  assert.equal(after.milestones.find(item => item.key === 'merged').state, 'todo');
});

test('ETA falls back to run finish times, caps a zero rounded rate, and reports off-ledger runs from both roots with PR refs', async t => {
  const fixture = await roadmapFixture(t, { doneCount: 2 });
  await fs.writeFile(path.join(fixture.linked, '.swarm/project/tickets.log'), '');
  await writeRun(fixture.linked, 'ledger-done', {
    status: 'complete', startedAt: iso(NOW - DAY),
    jobs: [
      { id: 'T-0001', status: 'complete', finishedAt: iso(NOW - DAY), costUsd: 1 },
      { id: 'T-0002', status: 'complete', finishedAt: iso(NOW - 2 * DAY), costUsd: 2 },
    ],
  });
  const fallback = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.deepEqual(fallback.eta, { remaining: 63, perDay: 0.14, days: 450, basis: '2 done in the last 14 days (from run finish times)' });

  const old = 4000 * DAY;
  await writeRun(fixture.linked, 'ledger-done', {
    status: 'complete', startedAt: iso(NOW - old),
    jobs: [
      { id: 'T-0001', status: 'complete', finishedAt: iso(NOW - old), costUsd: 1 },
      { id: 'T-0002', status: 'complete', finishedAt: iso(NOW - old + DAY), costUsd: 2 },
    ],
  });
  const widened = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(widened.eta.perDay, 0);
  assert.equal(widened.eta.days, 3650);
  assert.ok(Number.isFinite(widened.eta.days));

  await writeRun(fixture.main, 'card-off-ledger', {
    status: 'complete', startedAt: iso(NOW - DAY),
    jobs: [{ id: 'off-job', status: 'complete', finishedAt: iso(NOW - 3600000), costUsd: 1.25 }],
  });
  await writeRun(fixture.linked, 'chosen-off-ledger', {
    status: 'failed', startedAt: iso(NOW - 2 * DAY),
    jobs: [{ id: 'off-job-2', status: 'failed', finishedAt: iso(NOW - DAY), costUsd: 0.5 }],
  });
  await fs.writeFile(fixture.historyFile, `${JSON.stringify({ kind: 'pr', projectId: fixture.project.id, at: iso(NOW - DAY), run: 'chosen-off-ledger', ref: '#77', title: 'Off-ledger PR' })}\n`);
  const withOffLedger = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(withOffLedger.offLedger.count, 2);
  assert.deepEqual(withOffLedger.offLedger.runs.map(run => run.runId), ['card-off-ledger', 'chosen-off-ledger']);
  assert.deepEqual(withOffLedger.offLedger.runs[1].prs, ['#77']);
});
