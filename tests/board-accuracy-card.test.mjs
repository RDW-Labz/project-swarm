// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boardSnapshot } from '../tools/board-data.mjs';
import { readyTickets as ticketsReadyToRun, logPath, approveLedger } from '../tools/tickets.mjs';
import { doneTimes } from '../tools/client-report.mjs';
import { checkTicketTree } from '../tools/scope-integrity.mjs';
import { readEvents } from '../tools/orchestrator-events.mjs';
import { projectId } from '../tools/projects.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';
import { offLedgerRuns } from '../tools/build-progress.mjs';

const execFileP = promisify(execFile);
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });
const iso = at => new Date(at).toISOString();
const activeRunState = state => state?.status === 'running' || state?.status === 'paused';
const COUNTED = ticket => ticket && ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status);

async function gitWorktreeRoots(mainRoot) {
  const { stdout } = await execFileP('git', ['-C', mainRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length).trim());
}

async function familyRootsFromDisk(mainRoot, env) {
  const unique = new Set([await fs.realpath(mainRoot)]);
  for (const root of await gitWorktreeRoots(mainRoot)) unique.add(await fs.realpath(root).catch(() => path.resolve(root)));
  const scratch = env?.SWARM_SCRATCH_ROOT || env?.SWARM_SCRATCH_DIR;
  if (scratch) {
    try {
      for (const name of await fs.readdir(scratch)) {
        const candidate = path.join(scratch, name);
        if ((await fs.stat(candidate)).isDirectory()) unique.add(await fs.realpath(candidate));
      }
    } catch { /* no scratch */ }
  }
  return [...unique];
}

async function readLedgersFromDisk(roots) {
  return Promise.all(roots.map(async root => {
    try { return JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', 'tickets.json'), 'utf8')); }
    catch { return null; }
  }));
}

async function readRunsFromDisk(roots) {
  const out = [];
  for (const root of roots) {
    let ids = [];
    try { ids = await fs.readdir(path.join(root, '.swarm', 'runs')); } catch { continue; }
    for (const id of ids) {
      const file = path.join(root, '.swarm', 'runs', id, 'state.json');
      try {
        const state = JSON.parse(await fs.readFile(file, 'utf8'));
        out.push({ id, root, state });
      } catch { /* unreadable */ }
    }
  }
  return out;
}

async function oracleBuildingTickets(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const ledgers = await readLedgersFromDisk(roots);
  const ids = new Set();
  for (const ledger of ledgers) for (const ticket of ledger?.tickets ?? []) if (ticket?.status === 'running' && ticket.id) ids.add(String(ticket.id));
  return ids.size;
}

async function oracleCheckoutsBuilding(fixture, { liveRuns = [] } = {}) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const liveRoots = new Set();
  for (const run of runs) if (activeRunState(run.state)) liveRoots.add(run.root);
  for (const record of liveRuns) {
    const root = await fs.realpath(record.root ?? fixture.root).catch(() => record.root ?? fixture.root);
    const state = runs.find(r => r.root === root && r.id === record.runId)?.state ?? record.state;
    if (activeRunState(state)) liveRoots.add(root);
  }
  return roots.filter(root => liveRoots.has(root)).length;
}

async function oracleLastTicketFinishedAt(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const ledgers = await readLedgersFromDisk(roots);
  const doneIds = new Set();
  for (const ledger of ledgers) for (const ticket of ledger?.tickets ?? []) if (ticket?.status === 'done' && ticket.id) doneIds.add(String(ticket.id));
  let newest = 0;
  const add = (id, value) => {
    const at = Date.parse(value ?? '');
    if (id && Number.isFinite(at)) { doneIds.add(String(id)); newest = Math.max(newest, at); }
  };
  for (const root of roots) {
    try { for (const [id, at] of await doneTimes(root)) add(id, at); } catch { /* no log */ }
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

async function oracleNextReady(fixture) {
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  return ticketsReadyToRun(ledger.tickets ?? []);
}

async function oracleBlocked(fixture) {
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const byId = new Map((ledger.tickets ?? []).map(ticket => [ticket.id, ticket]));
  const items = [];
  let waitingOnTickets = 0;
  for (const ticket of ledger.tickets ?? []) {
    if (ticket.status !== 'blocked') continue;
    const waitsOn = (ticket.dependsOn ?? []).filter(dep => byId.get(dep)?.status !== 'done');
    if (!waitsOn.length) continue;
    if (ticket.blockReason && ticket.blockReason !== 'deps') continue;
    waitingOnTickets += 1;
    items.push({
      id: ticket.id,
      title: ticket.title,
      waitsOn,
      command: waitsOn.length === 0 && ticket.type !== 'human' ? `swarm tickets ${ticket.id} --release` : null,
    });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { waitingOnTickets, items };
}

async function oracleSlots(fixture, { workersMax = 8 } = {}) {
  const lanes = JSON.parse(await fs.readFile(path.join(fixture.lanesDir, 'lanes.json'), 'utf8'));
  const familyId = fixture.projects[0].id;
  let inUse = 0;
  let byThisProject = 0;
  let byOtherProjects = 0;
  for (const slots of Object.values(lanes.slots ?? {})) {
    for (const slot of Array.isArray(slots) ? slots : []) {
      inUse += 1;
      const key = slot.project ?? 'unknown';
      if (key === familyId) byThisProject += 1;
      else if (key !== 'unknown') byOtherProjects += 1;
    }
  }
  return { machineMax: workersMax, inUse, byThisProject, byOtherProjects };
}

async function oracleEta(fixture, now = NOW) {
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const tickets = (ledger.tickets ?? []).filter(COUNTED);
  const remaining = tickets.filter(ticket => ticket.status !== 'done').length;
  const since = now - 7 * DAY;
  let doneLast7Days = 0;
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  for (const root of roots) {
    try {
      const content = await fs.readFile(logPath(root), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const to = event.to ?? event.nextStatus ?? event.status;
        if (String(to).toLowerCase() !== 'done') continue;
        const at = Date.parse(event.at ?? '');
        if (!Number.isFinite(at) || at < since || at > now) continue;
        if (event.event === 'transition' || event.event === 'delivered' || event.event === undefined) doneLast7Days += 1;
      }
    } catch { /* no log */ }
  }
  const perDay = doneLast7Days > 0 ? Math.round((doneLast7Days / 7) * 100) / 100 : 0;
  let days = null;
  if (remaining === 0) days = 0;
  else if (perDay > 0) days = Math.min(3650, Math.ceil(remaining / perDay));
  const basis = doneLast7Days > 0
    ? `${doneLast7Days} done in the last 7 days (family tickets.log)`
    : 'no done transitions in family tickets.log in the last 7 days';
  return { days, remaining, perDay, doneLast7Days, windowDays: 7, basis };
}

async function oracleFacts(fixture, now = NOW) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const since = now - DAY;
  let handEditsBlocked24h = 0;
  for (const root of roots) {
    for (const event of readEvents(root, { limit: 4000 })) {
      if (event.e !== 'blocked') continue;
      const at = Date.parse(event.at ?? '');
      if (Number.isFinite(at) && at >= since && at <= now) handEditsBlocked24h += 1;
    }
  }
  return { handEditsBlocked24h };
}

async function familyTicketIdsFromDisk(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const ledgers = await readLedgersFromDisk(roots);
  const ids = new Set();
  for (const ledger of ledgers) for (const ticket of ledger?.tickets ?? []) if (ticket?.id) ids.add(String(ticket.id));
  return ids;
}

async function oracleUntrackedRuns(fixture, now = NOW) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const ticketIds = await familyTicketIdsFromDisk(fixture);
  const off = offLedgerRuns(
    runs.map(record => ({ runId: record.id, state: record.state })),
    null,
    null,
    now,
    ticketIds,
    fixture.projects[0].id,
  );
  return off.count;
}

async function oracleFactsCheckouts(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  return roots.length;
}

const MONEY_KEY = /^(usd|cost|billed|listValue|flatRate|price|spend|budget)$/i;

function assertCardHasNoMoney(card) {
  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /\$\d/, 'card JSON must not contain dollar-shaped values');
  const visit = (value, path = 'card') => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string' && /\$\d/.test(value)) assert.fail(`dollar value at ${path}: ${value}`);
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) visit(value[index], `${path}[${index}]`);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!MONEY_KEY.test(key), `money-shaped key "${key}" at ${path}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(card);
}

async function oracleHeadsUp(fixture, { slots = 8, finished = false } = {}) {
  if (finished) return null;
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const scopeFile = path.join(fixture.root, ledger.scope?.file ?? 'docs/scope/scope.md');
  let scope = null;
  try {
    const { parseScope } = await import('../tools/scope.mjs');
    scope = parseScope(await fs.readFile(scopeFile, 'utf8'));
  } catch { /* no scope */ }
  const conflicts = checkTicketTree({ scope, tickets: ledger.tickets ?? [] }).conflicts ?? [];
  if (conflicts.length) {
    const groups = new Map();
    for (const conflict of conflicts) {
      const stage = (ledger.tickets ?? []).find(ticket => conflict.tickets?.includes(ticket.id))?.stage ?? 'unknown';
      const key = `${stage}\0${conflict.file}`;
      const entry = groups.get(key) ?? { stage, tickets: new Set() };
      for (const id of conflict.tickets ?? []) entry.tickets.add(id);
      groups.set(key, entry);
    }
    const worst = [...groups.values()].sort((a, b) => b.tickets.size - a.tickets.size)[0];
    const count = worst.tickets.size;
    const stageLabel = /^S\d+$/i.test(String(worst.stage)) ? `Stage ${worst.stage}` : `Stage ${worst.stage}`;
    return `${stageLabel} has ${count} ticket${count === 1 ? '' : 's'} that write the same file in the same wave, so they cannot run together.`;
  }
  return null;
}

async function snapshotFor(fixture, options = {}) {
  return boardSnapshot({
    projects: [fixture.projects[0]],
    liveRuns: [],
    now: NOW,
    env: fixture.env,
    summary,
    workers: { max: options.workersMax ?? 8 },
    ...options,
  });
}

const cardOf = (snapshot, fixture) => snapshot.projects.find(project => project.id === fixture.projects[0].id)?.card;

test('card.now.buildingTickets counts running tickets across the family', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json', worktrees: [{ name: 'linked' }] });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const target = ledger.tickets.find(ticket => ticket.type !== 'human' && !['cancelled', 'proposed', 'done'].includes(ticket.status));
  assert.ok(target?.id);
  target.status = 'running';
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const childLedger = JSON.parse(await fs.readFile(path.join(fixture.worktreeRoots[0], '.swarm', 'project', 'tickets.json'), 'utf8'));
  const other = childLedger.tickets.find(ticket => ticket.id !== target.id && ticket.type !== 'human' && !['cancelled', 'proposed', 'done'].includes(ticket.status));
  assert.ok(other?.id);
  other.status = 'running';
  await fs.writeFile(path.join(fixture.worktreeRoots[0], '.swarm', 'project', 'tickets.json'), JSON.stringify(childLedger));
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).now.buildingTickets, await oracleBuildingTickets(fixture));
});

test('card.now.checkoutsBuilding counts family checkouts with a live run', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'wt-live', status: 'running', startedAt: iso(NOW), jobs: [] }] }],
  });
  t.after(fixture.cleanup);
  const liveRuns = [{ runId: 'wt-live', root: fixture.worktreeRoots[0] }];
  const snapshot = await snapshotFor(fixture, { liveRuns, now: NOW });
  assert.equal(cardOf(snapshot, fixture).now.checkoutsBuilding, await oracleCheckoutsBuilding(fixture, { liveRuns }));
});

test('card.now.lastTicketFinishedAt matches the family oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const done = ledger.tickets.find(ticket => ticket.status === 'done');
  assert.ok(done?.id);
  await fs.mkdir(path.dirname(logPath(fixture.root)), { recursive: true });
  await fs.writeFile(logPath(fixture.root), `${JSON.stringify({ event: 'transition', id: done.id, to: 'done', at: iso(NOW - 5000) })}\n`);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).now.lastTicketFinishedAt, await oracleLastTicketFinishedAt(fixture));
});

test('card.next.ready and items follow readyTickets on the ledger', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ready = await oracleNextReady(fixture);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.equal(card.next.ready, ready.length);
  assert.deepEqual(card.next.items, ready.map(ticket => ({ id: ticket.id, title: ticket.title, command: `swarm tickets ${ticket.id}` })));
});

test('card.blocked reflects dependency waits', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const [a, b] = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status)).slice(0, 2);
  assert.ok(a?.id && b?.id);
  a.status = 'done';
  b.status = 'blocked';
  b.blockReason = 'deps';
  b.dependsOn = [a.id];
  const c = ledger.tickets.find(ticket => ticket.id !== a.id && ticket.id !== b.id && ticket.type !== 'human' && !['cancelled', 'proposed', 'done'].includes(ticket.status));
  assert.ok(c?.id);
  c.status = 'blocked';
  c.blockReason = 'deps';
  c.dependsOn = ['T-missing'];
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const expected = await oracleBlocked(fixture);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.equal(card.blocked.waitingOnTickets, expected.waitingOnTickets);
  assert.deepEqual(card.blocked.items, expected.items);
});

test('card.blocked.needYou counts held tickets from the inbox', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const held = ledger.tickets.find(ticket => ticket.type !== 'human' && !['cancelled', 'proposed', 'done'].includes(ticket.status));
  assert.ok(held?.id);
  held.status = 'blocked';
  held.blockReason = 'manual';
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.ok(card.blocked.needYou >= 1);
  const item = card.blocked.needYouItems.find(entry => entry.id === held.id);
  assert.ok(item);
  assert.equal(item.kind, 'held-ticket');
  assert.match(item.command, /--release$/);
});

test('card.slots reports machine use including other projects', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const otherId = projectId(path.join(path.dirname(fixture.root), 'foreign'));
  const lanes = {
    version: 1,
    slots: {
      cursor: [
        { id: 's1', pid: process.pid, host: 'fixture-host', runId: 'r1', project: fixture.projects[0].id },
        { id: 's2', pid: process.pid, host: 'fixture-host', runId: 'r2', project: otherId },
        { id: 's3', pid: process.pid, host: 'fixture-host', runId: 'r3', project: otherId },
      ],
    },
    demand: {},
    pauses: {},
  };
  await fs.writeFile(path.join(fixture.lanesDir, 'lanes.json'), `${JSON.stringify(lanes)}\n`);
  const expected = await oracleSlots(fixture, { workersMax: 8 });
  const snapshot = await snapshotFor(fixture, { workersMax: 8 });
  assert.deepEqual(cardOf(snapshot, fixture).slots, expected);
});

test('card.eta uses seven-day tickets.log done transitions', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await fs.mkdir(path.dirname(logPath(fixture.root)), { recursive: true });
  const lines = [];
  for (let i = 0; i < 5; i += 1) {
    lines.push(JSON.stringify({ event: 'transition', id: `T-900${i}`, to: 'done', at: iso(NOW - (i + 1) * DAY) }));
  }
  await fs.writeFile(logPath(fixture.root), `${lines.join('\n')}\n`);
  const expected = await oracleEta(fixture, NOW);
  const snapshot = await snapshotFor(fixture);
  assert.deepEqual(cardOf(snapshot, fixture).eta, expected);
});

test('card.facts.handEditsBlocked24h counts recent guard blocked events only', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const eventsDir = path.join(fixture.root, '.swarm', 'orchestrator');
  await fs.mkdir(eventsDir, { recursive: true });
  const events = [
    { at: iso(NOW - 2 * 3600000), s: 'sess-1', e: 'blocked', t: 'Write', f: 'src/a.ts' },
    { at: iso(NOW - 10 * 3600000), s: 'sess-2', e: 'blocked', t: 'Write', f: 'src/b.ts' },
    { at: iso(NOW - 48 * 3600000), s: 'sess-3', e: 'blocked', t: 'Write', f: 'src/c.ts' },
  ];
  await fs.writeFile(path.join(eventsDir, 'events.ndjson'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  const snapshot = await snapshotFor(fixture);
  const facts = cardOf(snapshot, fixture).facts;
  assert.equal(facts.handEditsBlocked24h, (await oracleFacts(fixture, NOW)).handEditsBlocked24h);
  assert.equal(facts.handEditsBlocked24h, 2);
});

test('card.facts.untrackedRuns matches off-ledger run oracle across the family', async t => {
  const recent = iso(NOW - 2 * DAY);
  const stale = iso(NOW - 20 * DAY);
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [
      { id: 'run-smoke', status: 'complete', startedAt: recent, jobs: [{ id: 'smoke-check', status: 'complete' }] },
      { id: 'run-lane-test', status: 'complete', startedAt: recent, jobs: [{ id: 'lane-test-1', status: 'complete' }] },
      { id: 'run-lane-bench', status: 'complete', startedAt: recent, jobs: [{ id: 'lane-bench-a', status: 'complete' }] },
      { id: 'run-probe', status: 'complete', startedAt: recent, manifest: 'probe-manifest.json', jobs: [] },
      { id: 'run-doctor', status: 'complete', startedAt: recent, jobs: [{ id: 'doctor-run', status: 'complete' }] },
      { id: 'run-non-int', status: 'complete', startedAt: recent, nonIntegrating: true, jobs: [{ id: 'T-off-ledger-1', status: 'complete' }] },
      { id: 'run-stale', status: 'complete', startedAt: stale, jobs: [{ id: 'T-off-ledger-2', status: 'complete' }] },
      { id: 'run-untracked-a', status: 'complete', startedAt: recent, jobs: [{ id: 'T-not-in-ledger-a', status: 'complete' }] },
      { id: 'run-untracked-b', status: 'running', startedAt: recent, jobs: [{ id: 'T-not-in-ledger-b', status: 'running' }] },
    ] }],
    scratch: [{ runs: [{ id: 'scratch-untracked', status: 'complete', startedAt: recent, jobs: [{ id: 'scratch-job-off-ledger', status: 'complete' }] }] }],
    runs: [{ id: 'main-untracked', status: 'complete', startedAt: recent, jobs: [{ id: 'main-off-ledger-job', status: 'complete' }] }],
  });
  t.after(fixture.cleanup);
  const expected = await oracleUntrackedRuns(fixture, NOW);
  assert.equal(expected, 4, 'two untracked on worktree, one on main, one on scratch');
  const snapshot = await snapshotFor(fixture);
  const facts = cardOf(snapshot, fixture).facts;
  assert.equal(facts.untrackedRuns, await oracleUntrackedRuns(fixture, NOW));
});

test('card.facts.checkouts matches git worktrees plus scratch roots', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked' }],
    scratch: [{ runs: [] }, { runs: [] }],
  });
  t.after(fixture.cleanup);
  const expected = await oracleFactsCheckouts(fixture);
  assert.ok(expected >= 4, 'main + linked worktree + two scratch dirs');
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).facts.checkouts, expected);
});

test('card ignores fixture merged PR list (progress milestones only)', async t => {
  const openPrs = [{ state: 'OPEN', number: 42, headRefName: 'swarm/T-0001', mergedAt: null }];
  const mergedPrs = [{ state: 'MERGED', number: 42, headRefName: 'swarm/T-0001', mergedAt: iso(NOW) }];
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json', prs: openPrs });
  t.after(fixture.cleanup);
  const snapshotOpts = prState => ({
    projects: [fixture.projects[0]],
    liveRuns: [],
    now: NOW,
    env: fixture.env,
    summary,
    prState,
  });
  const snapOpen = await boardSnapshot(snapshotOpts(async () => openPrs));
  const snapMerged = await boardSnapshot(snapshotOpts(async () => mergedPrs));
  const cardCore = card => ({
    now: card.now,
    next: card.next,
    blocked: { waitingOnTickets: card.blocked.waitingOnTickets, items: card.blocked.items },
  });
  const cardA = cardOf(snapOpen, fixture);
  const cardB = cardOf(snapMerged, fixture);
  // Watch card is built without prState; merged PRs affect progress milestones, not card.now/next/blocked.
  assert.deepEqual(cardCore(cardA), cardCore(cardB));
  const pctA = snapOpen.projects[0].progress?.overall ?? snapOpen.projects[0].progress?.percent?.board?.pct;
  const pctB = snapMerged.projects[0].progress?.overall ?? snapMerged.projects[0].progress?.percent?.board?.pct;
  assert.equal(pctA, pctB);
});

test('card JSON omits money-shaped keys and dollar values', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json', spend: { billedToday: 12.5, listToday: 3 } });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assertCardHasNoMoney(cardOf(snapshot, fixture));
});

test('card.headsUp names same-file wave collisions', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const picks = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status)).slice(0, 3);
  assert.equal(picks.length, 3);
  for (const ticket of picks) {
    ticket.status = 'ready';
    ticket.stage = 'S9';
    ticket.dependsOn = [];
    ticket.files = ['src/shared/collision.ts'];
  }
  await fs.writeFile(ledgerFile, JSON.stringify(approveLedger(ledger, { now: iso(NOW) })));
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).headsUp, await oracleHeadsUp(fixture));
});
