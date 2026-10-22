// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boardSnapshot } from '../tools/board-data.mjs';
import { readyTickets as ticketsReadyToRun, logPath, approveLedger, isApproved } from '../tools/tickets.mjs';
import { doneTimes } from '../tools/client-report.mjs';
import { checkTicketTree } from '../tools/scope-integrity.mjs';
import { readEvents } from '../tools/orchestrator-events.mjs';
import { projectId } from '../tools/projects.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';
import { offLedgerRuns, OFF_LEDGER_LIST_ANCHOR_ID } from '../tools/build-progress.mjs';
import { collectInbox } from '../tools/inbox.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';
import { machineConcurrency } from '../tools/lanes.mjs';
import { defaultConfigPath } from '../tools/local-config.mjs';
import { sanitizeText } from '../tools/journal.mjs';
import { sanitizeWorkerText } from '../tools/worker-text.mjs';

/** Every leaf path on projectOverview(...).card must appear here with the test that owns it. */
export const COVERAGE = {
  'now.buildingTickets': 'card.now.buildingTickets counts running tickets across the family',
  'now.checkoutsBuilding': 'card.now.checkoutsBuilding counts family checkouts with a live run',
  'now.lastTicketFinishedAt': 'card.now.lastTicketFinishedAt matches the family oracle',
  'next.ready': 'card.next.ready matches readyTickets on disk',
  'next.items': 'card.next.items fields match disk oracle',
  'next.items.id': 'card.next.items fields match disk oracle',
  'next.items.title': 'card.next.items fields match disk oracle',
  'next.items.command': 'card.next.items fields match disk oracle',
  'blocked.waitingOnTickets': 'card.blocked.waitingOnTickets matches dependency oracle',
  'blocked.items': 'card.blocked.items fields match dependency oracle',
  'blocked.items.id': 'card.blocked.items fields match dependency oracle',
  'blocked.items.title': 'card.blocked.items fields match dependency oracle',
  'blocked.items.waitsOn': 'card.blocked.items fields match dependency oracle',
  'blocked.items.command': 'card.blocked.items command follows release rule read from disk',
  'blocked.needYou': 'card.blocked.needYou matches inbox-on-disk oracle',
  'blocked.needYouItems': 'card.blocked.needYouItems match inbox-on-disk oracle',
  'blocked.needYouItems.id': 'card.blocked.needYouItems match inbox-on-disk oracle',
  'blocked.needYouItems.title': 'card.blocked.needYouItems match inbox-on-disk oracle',
  'blocked.needYouItems.kind': 'card.blocked.needYouItems match inbox-on-disk oracle',
  'blocked.needYouItems.command': 'card.blocked.needYouItems match inbox-on-disk oracle',
  'slots.machineMax': 'card.slots.machineMax reads local config on disk',
  'slots.inUse': 'card.slots reports machine use including other projects',
  'slots.byThisProject': 'card.slots reports machine use including other projects',
  'slots.byOtherProjects': 'card.slots reports machine use including other projects',
  'eta.days': 'card.eta.days matches seven-day tickets.log oracle',
  'eta.remaining': 'card.eta.remaining matches seven-day tickets.log oracle',
  'eta.perDay': 'card.eta.perDay matches seven-day tickets.log oracle',
  'eta.doneLast7Days': 'card.eta.doneLast7Days matches seven-day tickets.log oracle',
  'eta.windowDays': 'card.eta.windowDays matches seven-day tickets.log oracle',
  'eta.basis': 'card.eta.basis matches seven-day tickets.log oracle',
  'facts.handEditsBlocked24h': 'card.facts.handEditsBlocked24h counts recent guard blocked events only',
  'facts.untrackedRuns': 'card.facts.untrackedRuns matches off-ledger run oracle across the family',
  'facts.listHref': 'card.facts.listHref matches off-ledger anchor on disk',
  'facts.checkouts': 'card.facts.checkouts matches git worktrees plus scratch roots',
  'headsUp': 'card.headsUp wave collision, under-filled waves, and finished null',
};

const execFileP = promisify(execFile);
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });
const iso = at => new Date(at).toISOString();
const activeRunState = state => state?.status === 'running' || state?.status === 'paused';
const COUNTED = ticket => ticket && ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status);

const quote = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const boardTitle = (value, max = 140) => (value === null || value === undefined ? null : sanitizeWorkerText(value, max));
const inboxTitle = (value, max = 900) => {
  const cleaned = sanitizeText(value).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/, '')}…`;
};

/** Restated from tools/board-inbox.mjs ticketReleaseAllowed (oracle must not call that function). */
function releaseAllowedFromDisk(ticket, ledger) {
  if (!ticket || ticket.type === 'human') return false;
  if (!['blocked', 'todo', 'review'].includes(ticket.status)) return false;
  const done = new Set((ledger?.tickets ?? []).filter(t => t.status === 'done').map(t => t.id));
  const waiting = (ticket.dependsOn ?? []).filter(d => !done.has(d));
  if (waiting.length) return false;
  if (ticket.status === 'todo' && ledger && !isApproved(ledger)) return false;
  return true;
}

function leafPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object') {
    return prefix ? [prefix] : [];
  }
  if (Array.isArray(value)) {
    if (!value.length) return prefix ? [prefix] : [];
    const paths = [];
    for (let index = 0; index < value.length; index += 1) {
      paths.push(...leafPaths(value[index], `${prefix}[${index}]`));
    }
    return paths;
  }
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    paths.push(...leafPaths(child, next));
  }
  return paths;
}

function coverageKeyForLeaf(path) {
  return path.replace(/\[\d+\]/g, '');
}

function assertLeafCovered(card) {
  for (const leaf of leafPaths(card)) {
    const key = coverageKeyForLeaf(leaf);
    assert.ok(COVERAGE[key], `missing COVERAGE entry for card leaf path ${leaf} (key ${key})`);
  }
}

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
    const command = releaseAllowedFromDisk(ticket, ledger) ? `swarm tickets ${ticket.id} --release` : null;
    items.push({
      id: ticket.id,
      title: boardTitle(ticket.title, 140),
      waitsOn,
      command,
    });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { waitingOnTickets, items };
}

async function oracleMachineMaxFromConfig(env, fallback = null) {
  const configPath = env?.SWARM_CONFIG || process.env.SWARM_CONFIG || defaultConfigPath();
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return machineConcurrency(config) ?? fallback;
  } catch {
    return fallback;
  }
}

async function oracleSlots(fixture, { workersMax = null } = {}) {
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
  const machineMax = workersMax ?? await oracleMachineMaxFromConfig(fixture.env, null);
  return { machineMax, inUse, byThisProject, byOtherProjects };
}

/** Restated from tools/board-inbox.mjs nextFor (commands shown on the board). */
function inboxCommandOnDisk(item, root) {
  const swarm = `swarm --root ${quote(root)}`;
  if (item.kind === 'human') return `${swarm} done ${quote(item.id)}`;
  if (item.kind === 'decision') {
    const choice = String(item.default ?? item.choices?.[0] ?? 'CHOICE');
    return `${swarm} decide ${quote(item.id)} ${quote(choice)}`;
  }
  if (item.kind === 'proposed-ticket') {
    return item.filesNamed
      ? `${swarm} tickets ${quote(item.id)} --approve --yes`
      : `${swarm} tickets ${quote(item.id)} --files FILE[,FILE] --yes`;
  }
  if (item.kind === 'held-ticket') return `${swarm} tickets ${quote(item.id)} --release`;
  if (item.kind === 'blocker') return `${swarm} resolve ${quote(item.id)}`;
  return null;
}

async function oracleNeedYou(fixture, now = NOW) {
  const root = fixture.root;
  const ledger = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const deps = inboxDeps({ channel: 'board' });
  const collected = await collectInbox([root], { ...deps, now: () => now });
  const items = [];
  for (const it of collected) {
    items.push({
      id: it.id,
      title: inboxTitle(it.title),
      kind: it.kind,
      command: inboxCommandOnDisk({
        kind: it.kind,
        id: it.id,
        default: it.default,
        choices: it.choices,
        filesNamed: false,
      }, root),
    });
  }
  for (const t of ledger.tickets ?? []) {
    if (t?.status === 'proposed') {
      const filesNamed = (t.files ?? []).length > 0;
      items.push({
        id: t.id,
        title: inboxTitle(t.title),
        kind: 'proposed-ticket',
        command: inboxCommandOnDisk({ kind: 'proposed-ticket', id: t.id, filesNamed }, root),
      });
    }
  }
  for (const t of ledger.tickets ?? []) {
    if (!releaseAllowedFromDisk(t, ledger)) continue;
    if (t.status === 'blocked' && t.blockReason === 'deps') continue;
    items.push({
      id: t.id,
      title: inboxTitle(t.title),
      kind: 'held-ticket',
      command: inboxCommandOnDisk({ kind: 'held-ticket', id: t.id }, root),
    });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { needYou: items.length, needYouItems: items };
}

async function oracleListHref() {
  return `#${OFF_LEDGER_LIST_ANCHOR_ID}`;
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

function underfilledWavesFromDisk(counts, slots) {
  if (!Array.isArray(counts) || !Number.isInteger(slots) || slots < 4) return null;
  let streak = 0;
  for (let i = counts.length - 1; i >= 0 && counts[i] <= 1; i -= 1) streak += 1;
  return streak >= 3
    ? `waves under-filled: 1 job of ${slots} slots (the last ${streak} runs each had 1 job); run the ready tickets as one wave`
    : null;
}

async function oracleRecentJobCounts(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  return runs
    .slice()
    .sort((a, b) => (Date.parse(a.state?.startedAt ?? '') || 0) - (Date.parse(b.state?.startedAt ?? '') || 0))
    .slice(-6)
    .map(record => (Array.isArray(record.state?.jobs) ? record.state.jobs.length : 0));
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
  const waves = underfilledWavesFromDisk(await oracleRecentJobCounts(fixture), slots);
  if (waves) return `${waves.charAt(0).toUpperCase()}${waves.slice(1)}.`;
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

test('card.next.ready matches readyTickets on disk', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).next.ready, (await oracleNextReady(fixture)).length);
});

test('card.next.items fields match disk oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ready = await oracleNextReady(fixture);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.deepEqual(card.next.items, ready.map(ticket => ({ id: ticket.id, title: ticket.title, command: `swarm tickets ${ticket.id}` })));
});

test('card.blocked.waitingOnTickets matches dependency oracle', async t => {
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
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const expected = await oracleBlocked(fixture);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).blocked.waitingOnTickets, expected.waitingOnTickets);
});

test('card.blocked.items fields match dependency oracle', async t => {
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
  assert.deepEqual(cardOf(snapshot, fixture).blocked.items, expected.items);
});

test('card.blocked.items command follows release rule read from disk', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const build = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status));
  const [a, b, c] = build.slice(0, 3);
  assert.ok(a?.id && b?.id && c?.id);
  a.status = 'done';
  b.status = 'blocked';
  b.blockReason = 'deps';
  b.dependsOn = [a.id];
  c.status = 'blocked';
  c.blockReason = 'deps';
  c.dependsOn = ['T-missing-dep'];
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const expected = await oracleBlocked(fixture);
  assert.ok(expected.items.length >= 1);
  for (const item of expected.items) assert.equal(item.command, null);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  for (const item of card.blocked.items) {
    const oracleItem = expected.items.find(entry => entry.id === item.id);
    assert.ok(oracleItem);
    assert.equal(item.command, oracleItem.command);
  }
  const releasable = build.find(ticket => ticket.id !== a.id && ticket.id !== b.id && ticket.id !== c.id);
  assert.ok(releasable?.id);
  releasable.status = 'blocked';
  releasable.blockReason = 'manual';
  releasable.dependsOn = [a.id];
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const releaseOracle = releaseAllowedFromDisk(releasable, ledger);
  assert.equal(releaseOracle, true);
  const need = await oracleNeedYou(fixture);
  const held = need.needYouItems.find(entry => entry.id === releasable.id);
  assert.ok(held);
  assert.equal(held.command, `swarm --root ${quote(fixture.root)} tickets ${quote(releasable.id)} --release`);
});

test('card.blocked.needYou matches inbox-on-disk oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await writeInboxNeedYouFixture(fixture);
  const expected = await oracleNeedYou(fixture);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).blocked.needYou, expected.needYou);
});

test('card.blocked.needYouItems match inbox-on-disk oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await writeInboxNeedYouFixture(fixture);
  const expected = await oracleNeedYou(fixture);
  const snapshot = await snapshotFor(fixture);
  const card = cardOf(snapshot, fixture);
  assert.deepEqual(
    card.blocked.needYouItems.map(item => ({ id: item.id, title: item.title, kind: item.kind, command: item.command })).sort((a, b) => a.id.localeCompare(b.id)),
    expected.needYouItems.sort((a, b) => a.id.localeCompare(b.id)),
  );
});

async function writeInboxNeedYouFixture(fixture) {
  const root = fixture.root;
  const ledgerFile = path.join(root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const humanId = 'inbox-human-1';
  const decisionId = 'inbox-decision-1';
  const blockerId = 'inbox-blocker-1';
  const proposedId = 'T-proposed-inbox';
  ledger.tickets.push({
    id: proposedId,
    title: 'Proposed from oracle fixture',
    status: 'proposed',
    type: 'build',
    files: ['src/proposed.ts'],
    createdAt: iso(NOW),
  });
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const journalFile = path.join(root, '.swarm', 'project', 'journal.ndjson');
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  const journal = [
    { kind: 'human', id: humanId, title: 'Human journal task', ts: iso(NOW - 3600000) },
    { kind: 'blocker', id: blockerId, text: 'Journal blocker needs resolve', ts: iso(NOW - 1800000) },
    { kind: 'decision', id: decisionId, text: 'Pick a lane', confirm: true, confirmed: false, choice: 'cursor', options: ['cursor', 'codex'], ts: iso(NOW - 900000) },
  ];
  await fs.writeFile(journalFile, `${journal.map(line => JSON.stringify(line)).join('\n')}\n`);
  const runId = 'inbox-human-run';
  const runDir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), `${JSON.stringify({
    id: runId,
    status: 'running',
    startedAt: iso(NOW - 600000),
    jobs: [{ id: 'job-human', heldReason: 'human', status: 'held', title: 'Run human gate', heldAt: iso(NOW - 600000) }],
  })}\n`);
}

test('card.slots.machineMax reads local config on disk', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const configPath = fixture.env.SWARM_CONFIG || process.env.SWARM_CONFIG;
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.machineConcurrency = 11;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const expectedMax = await oracleMachineMaxFromConfig(fixture.env, null);
  assert.equal(expectedMax, 11);
  const snapshot = await snapshotFor(fixture, { workersMax: expectedMax });
  assert.equal(cardOf(snapshot, fixture).slots.machineMax, expectedMax);
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

test('card.eta.days is null when perDay is zero', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const expected = await oracleEta(fixture, NOW);
  assert.equal(expected.perDay, 0);
  assert.equal(expected.days, null);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).eta.days, null);
});

test('card.eta.days matches seven-day tickets.log oracle', async t => {
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
  assert.equal(cardOf(snapshot, fixture).eta.days, expected.days);
});

test('card.eta.remaining matches seven-day tickets.log oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const expected = await oracleEta(fixture, NOW);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).eta.remaining, expected.remaining);
});

test('card.eta.perDay matches seven-day tickets.log oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await fs.mkdir(path.dirname(logPath(fixture.root)), { recursive: true });
  await fs.writeFile(logPath(fixture.root), `${JSON.stringify({ event: 'transition', id: 'T-9000', to: 'done', at: iso(NOW - DAY) })}\n`);
  const expected = await oracleEta(fixture, NOW);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).eta.perDay, expected.perDay);
});

test('card.eta.doneLast7Days matches seven-day tickets.log oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  await fs.mkdir(path.dirname(logPath(fixture.root)), { recursive: true });
  await fs.writeFile(logPath(fixture.root), `${JSON.stringify({ event: 'transition', id: 'T-9001', to: 'done', at: iso(NOW - 2 * DAY) })}\n`);
  const expected = await oracleEta(fixture, NOW);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).eta.doneLast7Days, expected.doneLast7Days);
});

test('card.eta.windowDays matches seven-day tickets.log oracle', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).eta.windowDays, (await oracleEta(fixture, NOW)).windowDays);
});

test('card.eta.basis matches seven-day tickets.log oracle', async t => {
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
  assert.equal(cardOf(snapshot, fixture).eta.basis, expected.basis);
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

test('card.facts.listHref matches off-ledger anchor on disk', async t => {
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json' });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture);
  assert.equal(cardOf(snapshot, fixture).facts.listHref, await oracleListHref());
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

test('card.headsUp wave collision, under-filled waves, and finished null', async t => {
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
  const collisionSnapshot = await snapshotFor(fixture);
  assert.equal(cardOf(collisionSnapshot, fixture).headsUp, await oracleHeadsUp(fixture));
});

test('card.headsUp warns when recent runs under-fill machine slots', async t => {
  const slots = 8;
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    runs: [
      { id: 'wave-1', status: 'complete', startedAt: iso(NOW - 5 * DAY), jobs: [{ id: 'j1', status: 'complete' }] },
      { id: 'wave-2', status: 'complete', startedAt: iso(NOW - 4 * DAY), jobs: [{ id: 'j2', status: 'complete' }] },
      { id: 'wave-3', status: 'complete', startedAt: iso(NOW - 3 * DAY), jobs: [{ id: 'j3', status: 'complete' }] },
      { id: 'wave-4', status: 'complete', startedAt: iso(NOW - 2 * DAY), jobs: [{ id: 'j4', status: 'complete' }] },
    ],
  });
  t.after(fixture.cleanup);
  const snapshot = await snapshotFor(fixture, { workersMax: slots });
  assert.equal(cardOf(snapshot, fixture).headsUp, await oracleHeadsUp(fixture, { slots }));
});

test('card.headsUp is null when the project is finished', async t => {
  const mergedPrs = [{ state: 'MERGED', number: 99, headRefName: 'swarm/finished', mergedAt: iso(NOW) }];
  const fixture = await makeBoardFixture({ ledger: 'roadmap-ledger.json', prs: mergedPrs });
  t.after(fixture.cleanup);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  let ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  for (const ticket of ledger.tickets ?? []) {
    if (ticket.type === 'human' || ['cancelled', 'proposed'].includes(ticket.status)) continue;
    ticket.status = 'done';
  }
  ledger = approveLedger(ledger, { now: iso(NOW) });
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const snapshot = await boardSnapshot({
    projects: [fixture.projects[0]],
    liveRuns: [],
    now: NOW,
    env: fixture.env,
    summary,
    workers: { max: 8 },
    prState: async () => mergedPrs,
  });
  const card = cardOf(snapshot, fixture);
  assert.equal(card.headsUp, null);
  assert.equal(await oracleHeadsUp(fixture, { finished: true }), null);
});

test('card COVERAGE lists every leaf field on a populated card', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'wt-live', status: 'running', startedAt: iso(NOW), jobs: [] }] }],
    scratch: [{ runs: [] }],
  });
  t.after(fixture.cleanup);
  await writeInboxNeedYouFixture(fixture);
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const buildTickets = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status));
  const [depA, depB] = buildTickets.slice(0, 2);
  assert.ok(depA?.id && depB?.id, 'coverage fixture needs two build tickets');
  depA.status = 'done';
  depB.status = 'blocked';
  depB.blockReason = 'deps';
  depB.dependsOn = [depA.id];
  const ready = ledger.tickets.find(ticket => ticket.type !== 'human' && !['cancelled', 'proposed', 'done', 'blocked'].includes(ticket.status));
  if (ready?.id) {
    ready.status = 'ready';
    ready.dependsOn = [];
    delete ready.blockReason;
  }
  await fs.writeFile(ledgerFile, JSON.stringify(approveLedger(ledger, { now: iso(NOW) })));
  const liveRuns = [{ runId: 'wt-live', root: fixture.worktreeRoots[0] }];
  const snapshot = await snapshotFor(fixture, { liveRuns });
  const card = cardOf(snapshot, fixture);
  assert.ok(card);
  assertLeafCovered(card);
});

