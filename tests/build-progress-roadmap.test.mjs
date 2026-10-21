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
  assert.equal(fullScope.requirements.length, 51);
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

test('build progress follows the newest approved roadmap ledger across linked worktrees and excludes human tickets', async t => {
  const fixture = await roadmapFixture(t);
  const progress = await buildProgress({ root: fixture.main, projectId: fixture.project.id, now: NOW, historyFile: fixture.historyFile });
  assert.equal(progress.source.root, fixture.linked);
  assert.equal(progress.source.differs, true);
  assert.equal(progress.source.candidates, 2);
  assert.equal(progress.percent.requirements.total, 51);
  assert.equal(progress.percent.requirements.covered, 12);
  assert.deepEqual(progress.percent.tickets, { done: 12, total: 51, pct: 23 });
  assert.match(progress.eta.basis, /14 days/);
  assert.equal(progress.eta.remaining, 39);
  assert.equal(progress.left.human.length, 2);
  assert.ok(progress.notes.includes(`ledger read from ${path.basename(fixture.linked)} (newest approved of 2 checkouts)`));

  const overview = await projectOverview(fixture.project, [], { now: NOW, historyFile: fixture.historyFile, summary: async () => ({}) });
  assert.deepEqual([overview.tickets.total, overview.tickets.open, overview.tickets.stage], [51, 39, 'S2']);
  assert.deepEqual(overview.progress, { overall: 23, ticketsPct: 23, current: 'E2E green', eta: progress.eta.days, finished: false });

  const detail = await projectDetail(fixture.project, { now: NOW, historyFile: fixture.historyFile, summary: async () => ({}) });
  assert.equal(detail.ticketCounts.total, 51);
  assert.equal(detail.tickets.length, 53);
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
  assert.equal(thirtyProgress.eta.remaining, 49);

  const since = await roadmapFixture(t, { doneCount: 2, doneAgeDays: 60 });
  const sinceProgress = await buildProgress({ root: since.main, projectId: since.project.id, now: NOW, historyFile: since.historyFile });
  assert.match(sinceProgress.eta.basis, /^2 done since /);

  const missing = await roadmapFixture(t, { doneCount: 1, doneAgeDays: 1 });
  const missingProgress = await buildProgress({ root: missing.main, projectId: missing.project.id, now: NOW, historyFile: missing.historyFile });
  assert.equal(missingProgress.eta, null);
  assert.ok(missingProgress.notes.includes('no completion times recorded in tickets.log'));
});
