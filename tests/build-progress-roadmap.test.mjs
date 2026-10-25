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
import { buildProgress, progressSummary } from '../tools/build-progress.mjs';
import { approveLedger, createLedger, writeLedger } from '../tools/tickets.mjs';
import { parseScope, scopeHash } from '../tools/scope.mjs';

const execFileP = promisify(execFile);
const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const DAY = 86400000;
const iso = at => new Date(at).toISOString();
const roadmapFile = fileURLToPath(new URL('../docs/scope/roadmap.md', import.meta.url));
const pctFloor = (done, total) => (total > 0 ? Math.max(0, Math.min(100, Math.floor(done * 100 / total))) : null);

function countRoadmapRequirements(markdown) {
  let count = 0;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('### R-')) count += 1;
  }
  return count;
}

function countRoadmapStages(markdown) {
  const start = markdown.indexOf('## Stages');
  if (start < 0) return 0;
  let count = 0;
  for (const line of markdown.slice(start).split('\n')) {
    if (line.startsWith('## ') && !line.startsWith('## Stages')) break;
    if (/^- S\d+:/.test(line)) count += 1;
  }
  return count;
}

function etaFrom14DayWindow({ countedTickets, ticketDone, completionsIn14Days }) {
  const perDay = Math.round((completionsIn14Days / 14) * 100) / 100;
  const remaining = Math.max(0, countedTickets - ticketDone);
  const days = remaining === 0 ? 0 : perDay > 0 ? Math.min(3650, Math.ceil(remaining / perDay)) : 3650;
  return { remaining, perDay, days };
}

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
  const fullRequirementTotal = countRoadmapRequirements(fullText);
  const oldRequirementTotal = countRoadmapRequirements(oldText);
  const stageTotal = countRoadmapStages(fullText);
  assert.equal(fullScope.requirements.length, fullRequirementTotal);
  assert.equal(oldScope.requirements.length, oldRequirementTotal);
  assert.ok(stageTotal >= 1, 'roadmap lists at least one stage');
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
  const mainRoot = await fs.realpath(main);
  const linkedRoot = await fs.realpath(linked);
  const family = async () => [mainRoot, linkedRoot];
  const project = { id: 'roadmap-fixture', name: 'Roadmap fixture', root: mainRoot };
  const progressOpts = (extra = {}) => ({ root: mainRoot, projectId: project.id, now: NOW, historyFile, family, ...extra });
  return {
    main: mainRoot, linked: linkedRoot, historyFile, oldLedger, worktreeLedger, project, family, progressOpts,
    fullRequirementTotal, oldRequirementTotal, stageTotal,
  };
}

async function writeRun(root, runId, state) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id: runId, ...state }));
}

test('build progress follows the newest approved roadmap ledger across linked worktrees and excludes human tickets', async t => {
  const fixture = await roadmapFixture(t);
  const { fullRequirementTotal: total } = fixture;
  const done = 12;
  const ticketsPct = pctFloor(done, total);
  const progress = await buildProgress(fixture.progressOpts());
  assert.equal(progress.source.root, fixture.linked);
  assert.equal(progress.source.differs, true);
  assert.equal(progress.source.candidates, 2);
  assert.equal(progress.percent.requirements.total, total);
  assert.equal(progress.percent.requirements.covered, done);
  assert.deepEqual(progress.percent.tickets, { done, total, pct: ticketsPct });
  assert.match(progress.eta.basis, /14 days/);
  assert.equal(progress.eta.remaining, total - done);
  assert.equal(progress.left.human.length, 2);
  assert.ok(progress.notes.includes(`ledger read from ${path.basename(fixture.linked)} (newest approved of 2 checkouts)`));

  const summary = progressSummary(progress);
  assert.deepEqual([progress.percent.tickets.total, progress.percent.tickets.total - progress.percent.tickets.done], [total, total - done]);
  assert.deepEqual(summary, { overall: ticketsPct, ticketsPct, current: 'Building', eta: progress.eta.days, finished: false, offLedger: 0, headline: `build ${done}/${total} · human 0/2`, untracked: { runs: 0, jobs: 0 } });
  assert.equal(progress.percent.tickets.total, total);
  assert.equal(progress.percent.tickets.done + (progress.percent.tickets.total - progress.percent.tickets.done) + progress.left.human.length, total + 2);
});

test('an approved main ledger wins over a newer but unapproved linked ledger', async t => {
  const fixture = await roadmapFixture(t);
  await writeLedger(fixture.linked, { ...fixture.worktreeLedger, approved: null, updatedAt: iso(NOW + DAY) });
  const progress = await buildProgress(fixture.progressOpts());
  assert.equal(progress.source.root, fixture.project.root);
  assert.equal(progress.source.differs, false);
  assert.equal(progress.percent.requirements.total, fixture.oldRequirementTotal);
  assert.equal(progress.percent.tickets.total, fixture.oldRequirementTotal);
});

test('ETA widens from fourteen to thirty days, then to all recorded completions', async t => {
  const thirty = await roadmapFixture(t, { doneCount: 2, doneAgeDays: 20 });
  const thirtyProgress = await buildProgress(thirty.progressOpts());
  assert.match(thirtyProgress.eta.basis, /^2 done in the last 30 days$/);
  assert.equal(thirtyProgress.eta.remaining, thirty.fullRequirementTotal - 2);

  const since = await roadmapFixture(t, { doneCount: 2, doneAgeDays: 60 });
  const sinceProgress = await buildProgress(since.progressOpts());
  assert.match(sinceProgress.eta.basis, /^2 done since /);

  const missing = await roadmapFixture(t, { doneCount: 1, doneAgeDays: 1 });
  const missingProgress = await buildProgress(missing.progressOpts());
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
  const progress = await buildProgress(fixture.progressOpts());
  const reqTotal = fixture.fullRequirementTotal;
  assert.deepEqual(progress.percent.tickets, { done: 4, total: 4, pct: 100 });
  assert.deepEqual(progress.percent.requirements, { covered: 2, total: reqTotal, pct: pctFloor(2, reqTotal) });
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
  const before = await buildProgress(fixture.progressOpts());
  assert.equal(before.milestones.find(item => item.key === 'pr').state, 'todo');

  await writeLedger(fixture.linked, approveLedger({ ...fixture.worktreeLedger, tickets }, { now: NOW - 2 * DAY }));
  await fs.appendFile(fixture.historyFile, `${JSON.stringify({ kind: 'pr', projectId: fixture.project.id, at: iso(NOW - DAY), ref: '#42', title: 'Linked PR after approval' })}\n`);
  const after = await buildProgress(fixture.progressOpts());
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
  const fallback = await buildProgress(fixture.progressOpts());
  const etaExpected = etaFrom14DayWindow({
    countedTickets: fixture.fullRequirementTotal,
    ticketDone: 2,
    completionsIn14Days: 2,
  });
  assert.deepEqual(fallback.eta, {
    ...etaExpected,
    basis: '2 done in the last 14 days (from run finish times)',
  });

  const old = 4000 * DAY;
  await writeRun(fixture.linked, 'ledger-done', {
    status: 'complete', startedAt: iso(NOW - old),
    jobs: [
      { id: 'T-0001', status: 'complete', finishedAt: iso(NOW - old), costUsd: 1 },
      { id: 'T-0002', status: 'complete', finishedAt: iso(NOW - old + DAY), costUsd: 2 },
    ],
  });
  const widened = await buildProgress(fixture.progressOpts());
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
  const withOffLedger = await buildProgress(fixture.progressOpts());
  assert.equal(withOffLedger.offLedger.count, 2);
  assert.deepEqual(withOffLedger.offLedger.runs.map(run => run.runId), ['card-off-ledger', 'chosen-off-ledger']);
  assert.deepEqual(withOffLedger.offLedger.runs[1].prs, ['#77']);
});
