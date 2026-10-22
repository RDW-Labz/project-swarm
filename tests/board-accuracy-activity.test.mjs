// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { boardSnapshot, startOfLocalDay } from '../tools/board-data.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { projectId } from '../tools/projects.mjs';
import { approveLedger } from '../tools/tickets.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });
const cardOf = (snapshot, fixture) => snapshot.projects.find(project => project.id === fixture.projects[0].id);
const iso = at => new Date(at).toISOString();

async function snapshotFor(fixture, options = {}) {
  return boardSnapshot({
    projects: [fixture.projects[0]],
    liveRuns: [],
    now: Date.now() + 1000,
    env: fixture.env,
    summary,
    ...options,
  });
}

test('lastRunAt is the newest startedAt across main, linked worktree, and scratch runs', async t => {
  const now = Date.now();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-run', status: 'complete', startedAt: iso(now - 1000), jobs: [] }] }],
    runs: [{ id: 'main-run', status: 'complete', startedAt: iso(now - 3000), jobs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', startedAt: iso(now - 100), jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).lastRunAt, iso(now - 100));
});

test('lastActivityAt includes finished activity from every family member', async t => {
  const now = Date.now();
  const finished = iso(now - 50);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-run', status: 'complete', startedAt: iso(now - 4000), finishedAt: finished, jobs: [] }] }],
    runs: [{ id: 'main-run', status: 'complete', startedAt: iso(now - 5000), jobs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', startedAt: iso(now - 3000), jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.ok(Date.parse(card.lastActivityAt) >= Date.parse(finished));
});

test('a project with a live run is building and not idle', async t => {
  const now = Date.now();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-live', status: 'running', startedAt: iso(now), jobs: [{ id: 'T-live', status: 'running' }] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture, { liveRuns: [{ runId: 'linked-live', root: fixture.worktreeRoots[0] }], now });
  const card = cardOf(snapshot, fixture);
  assert.equal(card.activity, 'building');
  assert.equal(card.idle, false);
  assert.equal(card.liveCount, 1);
});

test('a project that completed a run earlier today in a linked worktree is active-today, not idle', async t => {
  const now = Date.now();
  const finished = iso(now - 60_000);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'today-done', status: 'complete', startedAt: iso(now - 120_000), finishedAt: finished, jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture, { now });
  const card = cardOf(snapshot, fixture);
  assert.equal(card.activity, 'active-today');
  assert.equal(card.idle, false);
});

test('a project whose last activity was yesterday is idle', async t => {
  const now = Date.now();
  const yesterday = iso(startOfLocalDay(now) - 60_000);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [{ id: 'old-run', status: 'complete', startedAt: yesterday, finishedAt: yesterday, jobs: [] }],
  });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  ledger.updatedAt = yesterday;
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const snapshot = await snapshotFor(fixture, { now });
  const card = cardOf(snapshot, fixture);
  assert.equal(card.activity, 'idle');
  assert.equal(card.idle, true);
});

test('liveCount includes a running linked-worktree run', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-live', status: 'running', startedAt: new Date().toISOString(), jobs: [{ id: 'T-live', status: 'running' }] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture, { liveRuns: [{ runId: 'linked-live', root: fixture.worktreeRoots[0] }] });
  assert.equal(cardOf(snapshot, fixture).liveCount, 1);
});

test('lastTicketFinishedAt falls back to the newest finished job for a done ledger ticket', async t => {
  const now = Date.now();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [] }],
    scratch: [{ runs: [] }],
  });
  t.after(fixture.cleanup);
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const done = ledger.tickets.find(ticket => ticket.status === 'done');
  assert.ok(done?.id);
  const finishedAt = iso(now - 25);
  const runDir = path.join(fixture.worktreeRoots[0], '.swarm', 'runs', 'ticket-finished');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ id: 'ticket-finished', status: 'complete', startedAt: iso(now - 1000), jobs: [{ id: done.id, status: 'complete', finishedAt }] }));
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).lastTicketFinishedAt, finishedAt);
});

test('checkouts is the family size', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).checkouts, 3);
});

test('board version is read from the installed current package', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const install = await fs.mkdtemp(path.join(fixture.env.SWARM_TEST_TMP, 'install-'));
  fixture.env.SWARM_INSTALL_DIR = install;
  await fs.mkdir(path.join(install, 'current'), { recursive: true });
  await fs.writeFile(path.join(install, 'current', 'package.json'), JSON.stringify({ version: '99.8011.0' }));
  const api = createBoardApi({ env: fixture.env, cacheMs: 0, listPeers: async () => [] });
  t.after(() => api.close());
  const snapshot = await api.snapshot({ local: true });
  assert.equal(snapshot.machine.version, '99.8011.0');
  assert.equal(typeof snapshot.machine.runningVersion, 'string');
});

test('a nameless project with no family runs is hidden while one with a run is shown', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const emptyRoot = path.join(path.dirname(fixture.root), 'empty');
  const activeRoot = path.join(path.dirname(fixture.root), 'active');
  await fs.mkdir(emptyRoot, { recursive: true });
  await fs.mkdir(path.join(activeRoot, '.swarm', 'runs', 'active'), { recursive: true });
  await fs.writeFile(path.join(activeRoot, '.swarm', 'runs', 'active', 'state.json'), JSON.stringify({ id: 'active', status: 'complete', startedAt: new Date().toISOString(), jobs: [] }));
  const projects = [
    { id: projectId(emptyRoot), root: emptyRoot, name: '' },
    { id: projectId(activeRoot), root: activeRoot, name: projectId(activeRoot) },
  ];
  const snapshot = await boardSnapshot({ projects, liveRuns: [], now: Date.now(), env: fixture.env, summary });
  assert.equal(snapshot.projects.some(project => project.root === emptyRoot), false);
  assert.equal(snapshot.projects.some(project => project.root === activeRoot), true);
});

test('finished and deployed projects have no live warnings and retain history warnings', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [{ id: 'wave-1', status: 'complete', startedAt: new Date(Date.now() - 4000).toISOString(), jobs: [{ id: 'T-1', status: 'complete' }] }, { id: 'wave-2', status: 'complete', startedAt: new Date(Date.now() - 3000).toISOString(), jobs: [{ id: 'T-2', status: 'complete' }] }, { id: 'wave-3', status: 'complete', startedAt: new Date(Date.now() - 2000).toISOString(), jobs: [{ id: 'T-3', status: 'complete' }] }],
  });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const ticket of ledger.tickets) if (ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status)) { ticket.status = 'done'; ticket.pr = '#1'; }
  await fs.writeFile(ledgerFile, JSON.stringify(approveLedger(ledger, { now: new Date().toISOString() })));
  await fs.writeFile(fixture.historyFile, `${JSON.stringify({ projectId: fixture.projects[0].id, kind: 'pr', ref: '#1', at: new Date(Date.now() + 100).toISOString() })}\n${JSON.stringify({ projectId: fixture.projects[0].id, kind: 'merge', ref: '#1', at: new Date(Date.now() + 200).toISOString() })}\n`);
  const snapshot = await snapshotFor(fixture, { workers: { max: 4 }, historyFile: fixture.historyFile, deployStatus: () => ({ lastSuccess: { at: new Date().toISOString(), environment: 'fixture' } }) });
  const card = cardOf(snapshot, fixture);
  assert.equal(card.progress.finished, true);
  assert.deepEqual(card.warnings, []);
  assert.ok(Array.isArray(card.history));
});
