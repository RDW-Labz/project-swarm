// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boardSnapshot, startOfLocalDay, projectActivityState, underfilledWaves } from '../tools/board-data.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { projectId } from '../tools/projects.mjs';
import { approveLedger, logPath, readLedger } from '../tools/tickets.mjs';
import { doneTimes } from '../tools/client-report.mjs';
import { buildProgress, progressSummary } from '../tools/build-progress.mjs';
import { splitQuality } from '../tools/split-quality.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const execFileP = promisify(execFile);
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });
const cardOf = (snapshot, fixture) => snapshot.projects.find(project => project.id === fixture.projects[0].id);
const iso = at => new Date(at).toISOString();
const activeRunState = state => state?.status === 'running' || state?.status === 'paused';

const runActivityMs = ({ state, mtimeMs } = {}) => Math.max(
  Number.isFinite(mtimeMs) ? mtimeMs : 0,
  Date.parse(state?.startedAt ?? '') || 0,
  Date.parse(state?.finishedAt ?? '') || 0,
  ...((state?.jobs ?? []).map(job => Date.parse(job?.finishedAt ?? '') || 0)),
);

async function gitWorktreeRoots(mainRoot) {
  const { stdout } = await execFileP('git', ['-C', mainRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  const roots = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length).trim());
  }
  return roots;
}

async function scratchRootsFromEnv(env) {
  const scratch = env?.SWARM_SCRATCH_ROOT || env?.SWARM_SCRATCH_DIR;
  if (!scratch) return [];
  const scratchRoot = await fs.realpath(scratch).catch(() => path.resolve(scratch));
  const out = [];
  try {
    for (const name of await fs.readdir(scratchRoot)) {
      const candidate = path.join(scratchRoot, name);
      try {
        if ((await fs.stat(candidate)).isDirectory()) out.push(await fs.realpath(candidate));
      } catch { /* entry may disappear */ }
    }
  } catch { /* absent scratch root */ }
  return out;
}

async function familyRootsFromDisk(mainRoot, env) {
  const unique = new Set();
  for (const root of [...await gitWorktreeRoots(mainRoot), ...await scratchRootsFromEnv(env)]) {
    unique.add(await fs.realpath(root).catch(() => path.resolve(root)));
  }
  return [...unique];
}

async function readRunsFromDisk(roots) {
  const out = [];
  for (const root of roots) {
    const dir = path.join(root, '.swarm', 'runs');
    let ids = [];
    try { ids = await fs.readdir(dir); } catch { continue; }
    for (const id of ids) {
      const file = path.join(dir, id, 'state.json');
      try {
        const stat = await fs.stat(file);
        const state = JSON.parse(await fs.readFile(file, 'utf8'));
        if (state && typeof state === 'object' && !Array.isArray(state)) {
          out.push({ id, root, state, mtimeMs: stat.mtimeMs });
        }
      } catch { /* unreadable run */ }
    }
  }
  return out;
}

async function readLedgersFromDisk(roots) {
  return Promise.all(roots.map(async root => {
    try {
      return JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', 'tickets.json'), 'utf8'));
    } catch {
      return null;
    }
  }));
}

async function oracleLastRunAt(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  let newest = 0;
  for (const { state } of await readRunsFromDisk(roots)) {
    const at = Date.parse(state?.startedAt ?? '');
    if (Number.isFinite(at)) newest = Math.max(newest, at);
  }
  return newest ? new Date(newest).toISOString() : null;
}

async function oracleLastTicketFinishedAt(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const ledgers = await readLedgersFromDisk(roots);
  const doneIds = new Set();
  for (const ledger of ledgers) {
    for (const ticket of ledger?.tickets ?? []) {
      if (ticket?.status === 'done' && ticket.id) doneIds.add(String(ticket.id));
    }
  }
  let newest = 0;
  const add = (id, value) => {
    const at = Date.parse(value ?? '');
    if (id && Number.isFinite(at)) {
      doneIds.add(String(id));
      newest = Math.max(newest, at);
    }
  };
  for (const root of roots) {
    try {
      for (const [id, at] of await doneTimes(root)) add(id, at);
    } catch { /* missing tickets.log */ }
  }
  for (const ledger of ledgers) {
    const history = Array.isArray(ledger?.history) ? ledger.history : Array.isArray(ledger?.history?.events) ? ledger.history.events : [];
    for (const event of history) {
      const status = event?.status ?? event?.to ?? event?.nextStatus ?? event?.transition?.to;
      const id = event?.ticketId ?? event?.ticket ?? event?.transition?.ticketId;
      if (String(status).toLowerCase() === 'done') add(id, event?.at ?? event?.finishedAt ?? event?.updatedAt ?? event?.timestamp);
    }
  }
  for (const record of runs) {
    for (const job of record.state?.jobs ?? []) {
      const ids = [job?.ticketId, job?.ticket, job?.id].filter(Boolean).map(String);
      if (!ids.some(id => doneIds.has(id))) continue;
      for (const id of ids) add(id, job?.finishedAt);
    }
  }
  return newest ? new Date(newest).toISOString() : null;
}

async function oracleLastActivityAt(fixture, { liveRuns = [] } = {}) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const ledgers = await readLedgersFromDisk(roots);
  const ticketFinishedMs = Date.parse(await oracleLastTicketFinishedAt(fixture) ?? '') || 0;
  const lastActivityMs = Math.max(
    0,
    ...runs.map(runActivityMs),
    ...liveRuns.map(record => Date.parse(record.startedAt ?? '') || 0),
    ...ledgers.map(ledger => Date.parse(ledger?.updatedAt ?? '') || 0),
    ticketFinishedMs,
  );
  return lastActivityMs ? new Date(lastActivityMs).toISOString() : null;
}

function familyActivityMsFromDisk({ runs, liveRunIds, ledgers, liveRuns, ticketFinishedMs, now }) {
  const liveIds = liveRunIds instanceof Set ? liveRunIds : new Set(liveRunIds ?? []);
  const capped = ms => {
    const value = Number(ms);
    return Number.isFinite(value) && value > 0 && value <= now ? value : 0;
  };
  let newest = 0;
  for (const run of runs) {
    if (activeRunState(run.state)) {
      if (liveIds.has(run.id)) newest = Math.max(newest, capped(runActivityMs(run)));
      continue;
    }
    newest = Math.max(newest, capped(runActivityMs(run)));
  }
  for (const record of liveRuns ?? []) newest = Math.max(newest, capped(Date.parse(record.startedAt ?? '')));
  for (const ledger of ledgers ?? []) newest = Math.max(newest, capped(Date.parse(ledger?.updatedAt ?? '')));
  newest = Math.max(newest, capped(ticketFinishedMs));
  return newest;
}

async function oracleLiveActivity(fixture, { liveRuns = [], now = Date.now() } = {}) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const ledgers = await readLedgersFromDisk(roots);
  const liveStateByRecord = new Map();
  for (const record of liveRuns) {
    const root = await fs.realpath(record.root ?? fixture.root).catch(() => record.root ?? fixture.root);
    const stateRun = runs.find(run => run.root === root && run.id === record.runId);
    if (stateRun) liveStateByRecord.set(record, stateRun.state);
  }
  const activeLiveRuns = liveRuns.filter(record => {
    if (activeRunState(record.state)) return true;
    if (record.state !== undefined) return false;
    return activeRunState(liveStateByRecord.get(record));
  });
  const liveIds = new Set(activeLiveRuns.map(r => r.runId));
  const ticketFinishedMs = Date.parse(await oracleLastTicketFinishedAt(fixture) ?? '') || 0;
  const familyActivityAtMs = familyActivityMsFromDisk({
    runs,
    liveRunIds: liveIds,
    ledgers,
    liveRuns,
    ticketFinishedMs,
    now,
  });
  const { activity, idle } = projectActivityState({
    activeLiveCount: activeLiveRuns.length,
    lastActivityMs: familyActivityAtMs,
    now,
  });
  return { liveCount: activeLiveRuns.length, activity, idle };
}

async function oracleCheckouts(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  return roots.length;
}

function finishedCardFromProgress(raw) {
  if (!raw) return { finished: false, current: null };
  const deployed = raw.milestones?.find(item => item.key === 'deployed');
  const deployDone = deployed?.state === 'done' || deployed?.currentDone === true;
  const noDeployConfigured = deployed?.state === 'unknown' || !deployed;
  const finished = Boolean(raw.finished && (deployDone || noDeployConfigured));
  const summary = progressSummary({ ...raw, finished });
  let current = summary?.current ?? null;
  if (!finished && summary) current = raw.milestones?.find(item => item.state === 'current')?.label ?? 'Unknown';
  return { finished, current };
}

async function oracleFinishedCard(fixture, { now, workers, historyFile, deployStatus } = {}) {
  const spend = { usd: 0, capUsd: null, reached: false };
  const raw = await buildProgress({
    root: fixture.root,
    projectId: fixture.projects[0].id,
    now,
    historyFile,
    spend,
    deploy: deployStatus ? deployStatus(fixture.root) : null,
    ownOnly: false,
  });
  const { finished, current } = finishedCardFromProgress(raw);
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const recentJobCounts = runs
    .slice()
    .sort((a, b) => (Date.parse(a.state?.startedAt ?? '') || 0) - (Date.parse(b.state?.startedAt ?? '') || 0))
    .slice(-6)
    .map(r => (Array.isArray(r.state.jobs) ? r.state.jobs.length : 0));
  const split = await splitQuality({ root: fixture.root, now, slots: workers?.max ?? null }).catch(() => null);
  const historyWarningCodes = [];
  if (split?.reds > 0 || split?.grade === 'red') historyWarningCodes.push('split-quality-red');
  if (underfilledWaves(recentJobCounts, workers?.max)) historyWarningCodes.push('waves-underfilled');
  return {
    finished,
    current,
    liveWarnings: finished ? [] : historyWarningCodes,
    historyWarningCodes: finished ? historyWarningCodes : [],
  };
}

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
  const card = cardOf(snapshot, fixture);
  assert.equal(card.lastRunAt, await oracleLastRunAt(fixture));
});

test('lastActivityAt equals the family max when the linked worktree has the newest run finish', async t => {
  const now = Date.now();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-run', status: 'complete', startedAt: iso(now - 4000), finishedAt: iso(now - 50), jobs: [] }] }],
    runs: [{ id: 'main-run', status: 'complete', startedAt: iso(now - 5000), jobs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', startedAt: iso(now - 3000), jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.equal(card.lastActivityAt, await oracleLastActivityAt(fixture));
});

test('lastActivityAt equals the family max when main has the newest job finish', async t => {
  const now = Date.now();
  const jobFinished = iso(now - 40);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-run', status: 'complete', startedAt: iso(now - 4000), finishedAt: iso(now - 200), jobs: [] }] }],
    runs: [{ id: 'main-run', status: 'complete', startedAt: iso(now - 5000), finishedAt: iso(now - 300), jobs: [{ id: 'T-main', status: 'complete', finishedAt: jobFinished }] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', startedAt: iso(now - 3000), finishedAt: iso(now - 100), jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.equal(card.lastActivityAt, await oracleLastActivityAt(fixture));
});

test('lastActivityAt equals the family max when scratch has the newest run finish', async t => {
  const now = Date.now();
  const scratchFinished = iso(now - 30);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-run', status: 'complete', startedAt: iso(now - 4000), finishedAt: iso(now - 200), jobs: [] }] }],
    runs: [{ id: 'main-run', status: 'complete', startedAt: iso(now - 5000), finishedAt: iso(now - 300), jobs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', startedAt: iso(now - 3000), finishedAt: scratchFinished, jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.equal(card.lastActivityAt, await oracleLastActivityAt(fixture));
});

test('lastActivityAt equals the family max when ledger updatedAt and tickets.log are included', async t => {
  const now = Date.now();
  const ledgerAt = iso(now - 20);
  const logAt = iso(now - 10);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-run', status: 'complete', startedAt: iso(now - 4000), finishedAt: iso(now - 500), jobs: [] }] }],
    runs: [{ id: 'main-run', status: 'complete', startedAt: iso(now - 5000), finishedAt: iso(now - 400), jobs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', startedAt: iso(now - 3000), finishedAt: iso(now - 300), jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const done = ledger.tickets.find(ticket => ticket.status === 'done');
  assert.ok(done?.id);
  ledger.updatedAt = ledgerAt;
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  await fs.mkdir(path.dirname(logPath(fixture.root)), { recursive: true });
  await fs.writeFile(logPath(fixture.root), `${JSON.stringify({ event: 'transition', id: done.id, to: 'done', at: logAt })}\n`);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.equal(card.lastActivityAt, await oracleLastActivityAt(fixture));
});

test('a project with a live run is building and not idle', async t => {
  const now = Date.now();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-live', status: 'running', startedAt: iso(now), jobs: [{ id: 'T-live', status: 'running' }] }] }],
  });
  t.after(fixture.cleanup);
  const liveRuns = [{ runId: 'linked-live', root: fixture.worktreeRoots[0] }];
  const snapshot = await snapshotFor(fixture, { liveRuns, now });
  const card = cardOf(snapshot, fixture);
  const expected = await oracleLiveActivity(fixture, { liveRuns, now });
  assert.equal(card.activity, expected.activity);
  assert.equal(card.idle, expected.idle);
  assert.equal(card.liveCount, expected.liveCount);
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
  const expected = await oracleLiveActivity(fixture, { liveRuns: [], now });
  assert.equal(card.activity, expected.activity);
  assert.equal(card.idle, expected.idle);
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
  const expected = await oracleLiveActivity(fixture, { liveRuns: [], now });
  assert.equal(card.activity, expected.activity);
  assert.equal(card.idle, expected.idle);
});

test('liveCount includes a running linked-worktree run', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'linked-live', status: 'running', startedAt: new Date().toISOString(), jobs: [{ id: 'T-live', status: 'running' }] }] }],
  });
  t.after(fixture.cleanup);
  const liveRuns = [{ runId: 'linked-live', root: fixture.worktreeRoots[0] }];
  const snapshot = await snapshotFor(fixture, { liveRuns });
  const expected = await oracleLiveActivity(fixture, { liveRuns });
  assert.equal(cardOf(snapshot, fixture).liveCount, expected.liveCount);
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
  const runDir = path.join(fixture.worktreeRoots[0], '.swarm', 'runs', 'ticket-finished');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ id: 'ticket-finished', status: 'complete', startedAt: iso(now - 1000), jobs: [{ id: done.id, status: 'complete', finishedAt: iso(now - 25) }] }));
  const snapshot = await snapshotFor(fixture);
  const expected = await oracleLastTicketFinishedAt(fixture);
  assert.equal(cardOf(snapshot, fixture).lastTicketFinishedAt, expected);
});

test('lastTicketFinishedAt uses a scratch-dir run when that is the only finish source', async t => {
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
  const runDir = path.join(fixture.scratchRoots[0], '.swarm', 'runs', 'scratch-only-finish');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({
    id: 'scratch-only-finish',
    status: 'complete',
    startedAt: iso(now - 1000),
    jobs: [{ id: done.id, status: 'complete', finishedAt: iso(now - 18) }],
  }));
  const snapshot = await snapshotFor(fixture);
  const expected = await oracleLastTicketFinishedAt(fixture);
  assert.equal(cardOf(snapshot, fixture).lastTicketFinishedAt, expected);
});

test('checkouts is the family size', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [] }],
    scratch: [{ runs: [{ id: 'scratch-run', status: 'complete', jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).checkouts, await oracleCheckouts(fixture));
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
  const now = Date.now();
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [{ id: 'wave-1', status: 'complete', startedAt: new Date(now - 4000).toISOString(), jobs: [{ id: 'T-1', status: 'complete' }] }, { id: 'wave-2', status: 'complete', startedAt: new Date(now - 3000).toISOString(), jobs: [{ id: 'T-2', status: 'complete' }] }, { id: 'wave-3', status: 'complete', startedAt: new Date(now - 2000).toISOString(), jobs: [{ id: 'T-3', status: 'complete' }] }],
  });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const ticket of ledger.tickets) if (ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status)) { ticket.status = 'done'; ticket.pr = '#1'; }
  await fs.writeFile(ledgerFile, JSON.stringify(approveLedger(ledger, { now: new Date().toISOString() })));
  await fs.writeFile(fixture.historyFile, `${JSON.stringify({ projectId: fixture.projects[0].id, kind: 'pr', ref: '#1', at: new Date(now + 100).toISOString() })}\n${JSON.stringify({ projectId: fixture.projects[0].id, kind: 'merge', ref: '#1', at: new Date(now + 200).toISOString() })}\n`);
  const options = {
    workers: { max: 4 },
    historyFile: fixture.historyFile,
    deployStatus: () => ({ lastSuccess: { at: new Date().toISOString(), environment: 'fixture' } }),
    now: now + 1000,
  };
  const snapshot = await snapshotFor(fixture, options);
  const card = cardOf(snapshot, fixture);
  const expected = await oracleFinishedCard(fixture, options);
  assert.equal(card.progress.finished, expected.finished);
  assert.equal(card.progress.current, expected.current);
  assert.deepEqual(card.warnings, expected.liveWarnings);
  assert.ok(Array.isArray(card.history));
  const warningCodes = card.history.filter(item => item?.code).map(item => item.code);
  for (const code of expected.historyWarningCodes) {
    assert.ok(warningCodes.includes(code), `history warnings: ${warningCodes.join(', ')}`);
  }
  assert.ok(!warningCodes.some(code => card.warnings.some(w => w.code === code)));
});
