// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { boardSnapshot, projectDetail } from '../tools/board-data.mjs';
import { makeBoardFixture } from './helpers/board-accuracy-fixture.mjs';

const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const boardPath = path.join(assets, 'board.js');
const execFileP = promisify(execFile);
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 21, 18, 0, 0);
const iso = at => new Date(at).toISOString();
const summary = async () => ({ spendUsd: 0, billedUsd: 0, capUsd: null, reached: false });
const activeRunState = state => state?.status === 'running' || state?.status === 'paused';
const COUNTED = ticket => ticket && ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status);
const OFF_LEDGER_LIST_ANCHOR_ID = 'untracked';
const LIVE_RUN = new Set(['queued', 'pending', 'running', 'active', 'in_progress', 'in-progress', 'live']);
const IGNORED_RUN_WORDS = /\b(?:smoke|lane-test|lane-bench|probe|doctor)\b/i;
const PROPOSAL_ORIGINS = ['comment', 'error', 'handoff'];
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const unapprovedProposal = t => PROPOSAL_ORIGINS.includes(t?.origin) && t.approvedBy !== 'owner';

const testTools = (async () => {
  const [
    tickets,
    clientReport,
    scopeIntegrity,
    orchestratorEvents,
    projects,
    inbox,
    inboxCommands,
    lanes,
    localConfig,
    journal,
    workerText,
  ] = await Promise.all([
    import('../tools/tickets.mjs'),
    import('../tools/client-report.mjs'),
    import('../tools/scope-integrity.mjs'),
    import('../tools/orchestrator-events.mjs'),
    import('../tools/projects.mjs'),
    import('../tools/inbox.mjs'),
    import('../tools/inbox-commands.mjs'),
    import('../tools/lanes.mjs'),
    import('../tools/local-config.mjs'),
    import('../tools/journal.mjs'),
    import('../tools/worker-text.mjs'),
  ]);
  return {
    logPath: tickets.logPath,
    approveLedger: tickets.approveLedger,
    isApproved: tickets.isApproved,
    doneTimes: clientReport.doneTimes,
    checkTicketTree: scopeIntegrity.checkTicketTree,
    readEvents: orchestratorEvents.readEvents,
    projectId: projects.projectId,
    collectInbox: inbox.collectInbox,
    inboxDeps: inboxCommands.inboxDeps,
    machineConcurrency: lanes.machineConcurrency,
    defaultConfigPath: localConfig.defaultConfigPath,
    sanitizeText: journal.sanitizeText,
    sanitizeWorkerText: workerText.sanitizeWorkerText,
  };
})();

async function tools() {
  return testTools;
}

/** Every displayed field on the project page and board overview must appear here with its owning test. */
export const COVERAGE = {
  'card.now.buildingTickets': 'displayed numbers match disk oracles on project page and overview',
  'card.now.checkoutsBuilding': 'displayed numbers match disk oracles on project page and overview',
  'card.now.lastTicketFinishedAt': 'displayed numbers match disk oracles on project page and overview',
  'card.next.ready': 'displayed numbers match disk oracles on project page and overview',
  'card.next.items': 'displayed numbers match disk oracles on project page and overview',
  'card.blocked.waitingOnTickets': 'displayed numbers match disk oracles on project page and overview',
  'card.blocked.needYou': 'displayed numbers match disk oracles on project page and overview',
  'card.blocked.items': 'displayed numbers match disk oracles on project page and overview',
  'card.slots.machineMax': 'displayed numbers match disk oracles on project page and overview',
  'card.slots.inUse': 'displayed numbers match disk oracles on project page and overview',
  'card.slots.byThisProject': 'displayed numbers match disk oracles on project page and overview',
  'card.slots.byOtherProjects': 'displayed numbers match disk oracles on project page and overview',
  'card.eta.days': 'displayed numbers match disk oracles on project page and overview',
  'card.eta.remaining': 'displayed numbers match disk oracles on project page and overview',
  'card.eta.perDay': 'displayed numbers match disk oracles on project page and overview',
  'card.eta.doneLast7Days': 'displayed numbers match disk oracles on project page and overview',
  'card.eta.windowDays': 'displayed numbers match disk oracles on project page and overview',
  'card.eta.basis': 'displayed numbers match disk oracles on project page and overview',
  'card.facts.handEditsBlocked24h': 'displayed numbers match disk oracles on project page and overview',
  'card.facts.untrackedRuns': 'displayed numbers match disk oracles on project page and overview',
  'card.facts.listHref': 'displayed numbers match disk oracles on project page and overview',
  'card.facts.checkouts': 'displayed numbers match disk oracles on project page and overview',
  'card.headsUp': 'displayed numbers match disk oracles on project page and overview',
  'progress.overall': 'project page percent matches boardPercent oracle from ledger JSON',
  'overview.machine.agents.total': 'overview KPI live agents matches disk oracle',
  'overview.machine.liveRuns': 'overview KPI subline matches disk oracle',
  'overview.machine.workers.total': 'overview KPI workers held matches disk oracle',
  'overview.table.jobs.running': 'overview table jobs column matches disk oracle',
  'overview.table.tickets.open': 'overview table tickets column matches disk oracle',
  'overview.table.liveCount': 'overview table live runs column matches disk oracle',
};

function readyTicketsFromLedgerJson(tickets) {
  const done = new Set((tickets ?? []).filter(t => t.status === 'done').map(t => t.id));
  return (tickets ?? [])
    .filter(t =>
      t.type !== 'human' &&
      !['cancelled', 'proposed'].includes(t.status) &&
      (t.status === 'todo' || t.status === 'ready') &&
      !unapprovedProposal(t) &&
      (t.dependsOn ?? []).every(d => done.has(d)))
    .sort(byId);
}

function runIsLive(state) {
  return state?.live === true || LIVE_RUN.has(String(state?.status ?? '').toLowerCase());
}

function stateTicketIds(state) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') {
      visit(value.id);
      visit(value.ticket);
      visit(value.ticketId);
    }
  };
  visit(state?.ticketIds);
  visit(state?.tickets);
  return ids;
}

function jobTicketIds(job) {
  const ids = new Set();
  for (const key of ['id', 'ticket', 'ticketId', 'name']) if (typeof job?.[key] === 'string') ids.add(job[key]);
  return ids;
}

function runHasIgnoredName(state, jobs) {
  const manifestNames = [
    state?.manifest,
    state?.manifest?.file,
    state?.manifestFile,
    state?.request?.manifest,
    state?.options?.manifest,
  ];
  if (manifestNames.some(value => typeof value === 'string' && IGNORED_RUN_WORDS.test(value))) return true;
  return jobs.some(job => typeof job?.id === 'string' && IGNORED_RUN_WORDS.test(job.id));
}

function countUntrackedRunsFromDisk(records, familyTicketIds, now) {
  const ids = familyTicketIds;
  let count = 0;
  for (const record of records) {
    const state = record.state;
    const live = runIsLive(state);
    const started = Date.parse(state?.startedAt ?? '');
    if (Number.isFinite(started) ? (started > now || (!live && started < now - 14 * DAY)) : !live) continue;
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    if (state?.nonIntegrating === true || runHasIgnoredName(state, jobs)) continue;
    const stateIds = stateTicketIds(state);
    const stateMapped = [...stateIds].some(id => ids.has(id));
    const untrackedJobs = jobs.filter(job => ![...jobTicketIds(job)].some(id => ids.has(id)));
    if (!untrackedJobs.length && !(!jobs.length && !stateMapped)) continue;
    count += 1;
  }
  return count;
}

function boardPercentFromLedger(ledger) {
  const tickets = (ledger?.tickets ?? []).filter(COUNTED);
  const total = tickets.length;
  if (!total) return 0;
  const done = tickets.filter(t => t.status === 'done').length;
  return Math.floor(done * 100 / total);
}

function ticketsOpenFromLedger(ledger) {
  const tickets = (ledger?.tickets ?? []).filter(t => t && t.type !== 'human');
  return tickets.filter(t => ['todo', 'ready', 'running', 'review', 'blocked'].includes(t.status)).length;
}

function ticketsBlockedFromLedger(ledger) {
  const tickets = (ledger?.tickets ?? []).filter(t => t && t.type !== 'human');
  return tickets.filter(t => t.status === 'blocked').length;
}

const quote = s => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

async function boardTitle(value, max = 140) {
  const { sanitizeWorkerText } = await tools();
  return value === null || value === undefined ? null : sanitizeWorkerText(value, max);
}

async function inboxTitle(value, max = 900) {
  const { sanitizeText } = await tools();
  const cleaned = sanitizeText(value).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/, '')}…`;
}

async function releaseAllowedFromDisk(ticket, ledger) {
  const { isApproved } = await tools();
  if (!ticket || ticket.type === 'human') return false;
  if (!['blocked', 'todo', 'review'].includes(ticket.status)) return false;
  const done = new Set((ledger?.tickets ?? []).filter(t => t.status === 'done').map(t => t.id));
  const waiting = (ticket.dependsOn ?? []).filter(d => !done.has(d));
  if (waiting.length) return false;
  if (ticket.status === 'todo' && ledger && !isApproved(ledger)) return false;
  return true;
}

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

function ticketDoneAtMsFromDisk(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : NaN;
}

async function oracleLastTicketFinishedAt(fixture) {
  const { doneTimes } = await tools();
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  const runs = await readRunsFromDisk(roots);
  const ledgers = await readLedgersFromDisk(roots);
  const doneIds = new Set();
  for (const ledger of ledgers) for (const ticket of ledger?.tickets ?? []) if (ticket?.status === 'done' && ticket.id) doneIds.add(String(ticket.id));
  let newest = 0;
  const add = (id, value) => {
    const at = ticketDoneAtMsFromDisk(value);
    if (id && Number.isFinite(at)) { doneIds.add(String(id)); newest = Math.max(newest, at); }
  };
  for (const root of roots) {
    try { for (const [id, at] of await doneTimes(root)) add(id, at); } catch { /* no log */ }
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

async function oracleNextReady(fixture) {
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  return readyTicketsFromLedgerJson(ledger.tickets ?? []);
}

async function oracleBlocked(fixture) {
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const byIdMap = new Map((ledger.tickets ?? []).map(ticket => [ticket.id, ticket]));
  const items = [];
  let waitingOnTickets = 0;
  for (const ticket of ledger.tickets ?? []) {
    if (ticket.status !== 'blocked') continue;
    const waitsOn = (ticket.dependsOn ?? []).filter(dep => byIdMap.get(dep)?.status !== 'done');
    if (!waitsOn.length) continue;
    if (ticket.blockReason && ticket.blockReason !== 'deps') continue;
    waitingOnTickets += 1;
    const command = (await releaseAllowedFromDisk(ticket, ledger)) ? `swarm tickets ${ticket.id} --release` : null;
    items.push({
      id: ticket.id,
      title: await boardTitle(ticket.title, 140),
      waitsOn,
      command,
    });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { waitingOnTickets, items };
}

async function oracleMachineMaxFromConfig(env, fallback = null) {
  const { defaultConfigPath, machineConcurrency } = await tools();
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

async function oracleNeedYou(fixture, now = NOW) {
  const { inboxDeps, collectInbox } = await tools();
  const root = fixture.root;
  const ledger = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const deps = inboxDeps({ channel: 'board' });
  const collected = await collectInbox([root], { ...deps, now: () => now });
  const items = [];
  for (const it of collected) {
    items.push({
      id: it.id,
      title: await inboxTitle(it.title),
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
        title: await inboxTitle(t.title),
        kind: 'proposed-ticket',
        command: inboxCommandOnDisk({ kind: 'proposed-ticket', id: t.id, filesNamed }, root),
      });
    }
  }
  for (const t of ledger.tickets ?? []) {
    if (t.status !== 'blocked') continue;
    if (!(await releaseAllowedFromDisk(t, ledger))) continue;
    if (t.blockReason === 'deps') continue;
    if (t.blockReason !== 'deps' && !t.holdQuestion) continue;
    items.push({
      id: t.id,
      title: await inboxTitle(t.holdQuestion ?? t.title),
      kind: 'held-ticket',
      command: inboxCommandOnDisk({ kind: 'held-ticket', id: t.id }, root),
    });
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { needYou: items.length, needYouItems: items };
}

async function oracleEta(fixture, now = NOW) {
  const { logPath } = await tools();
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
  const { readEvents } = await tools();
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
  return countUntrackedRunsFromDisk(runs, ticketIds, now);
}

async function oracleFactsCheckouts(fixture) {
  const roots = await familyRootsFromDisk(fixture.root, fixture.env);
  return roots.length;
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
  const { checkTicketTree } = await tools();
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

async function oracleBoardPercent(fixture) {
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  return boardPercentFromLedger(ledger);
}

function oracleAgentsJobsFromLiveRuns(liveRuns, runsOnDisk) {
  const jobs = { running: 0, queued: 0, blocked: 0 };
  const liveIds = new Set(liveRuns.map(r => r.runId));
  for (const record of runsOnDisk) {
    if (!liveIds.has(record.id)) continue;
    if (!activeRunState(record.state)) continue;
    for (const job of record.state?.jobs ?? []) {
      if (!job || typeof job !== 'object') continue;
      if (job.status === 'running') jobs.running += 1;
      else if (job.status === 'queued') jobs.queued += 1;
      else if (job.status === 'held' || job.status === 'blocked') jobs.blocked += 1;
    }
  }
  return jobs;
}

function oracleMachineAgentsTotal(liveRuns, runsOnDisk) {
  return oracleAgentsJobsFromLiveRuns(liveRuns, runsOnDisk).running;
}

function oracleMachineLiveRuns(liveRuns, runsOnDisk) {
  const liveIds = new Set(liveRuns.map(r => r.runId));
  let count = 0;
  for (const record of runsOnDisk) {
    if (!liveIds.has(record.id)) continue;
    if (activeRunState(record.state)) count += 1;
  }
  return count;
}

async function oracleWorkersHeldTotal(fixture) {
  const lanes = JSON.parse(await fs.readFile(path.join(fixture.lanesDir, 'lanes.json'), 'utf8'));
  let total = 0;
  for (const slots of Object.values(lanes.slots ?? {})) {
    for (const slot of Array.isArray(slots) ? slots : []) total += 1;
  }
  return total;
}

async function oracleExpectedCard(fixture, options = {}) {
  const ready = await oracleNextReady(fixture);
  const blocked = await oracleBlocked(fixture);
  const need = await oracleNeedYou(fixture, NOW);
  const eta = await oracleEta(fixture, NOW);
  const slots = await oracleSlots(fixture, options);
  const factsBase = await oracleFacts(fixture, NOW);
  const listHref = `#${OFF_LEDGER_LIST_ANCHOR_ID}`;
  const expectedItems = await Promise.all(ready.map(async ticket => ({
    id: ticket.id,
    title: await boardTitle(ticket.title, 140),
    command: `swarm tickets ${ticket.id}`,
  })));
  return {
    now: {
      buildingTickets: await oracleBuildingTickets(fixture),
      checkoutsBuilding: await oracleCheckoutsBuilding(fixture, options),
      lastTicketFinishedAt: await oracleLastTicketFinishedAt(fixture),
    },
    next: { ready: ready.length, items: expectedItems },
    blocked: {
      waitingOnTickets: blocked.waitingOnTickets,
      items: blocked.items,
      needYou: need.needYou,
      needYouItems: need.needYouItems,
    },
    slots,
    eta,
    facts: {
      ...factsBase,
      untrackedRuns: await oracleUntrackedRuns(fixture, NOW),
      listHref,
      checkouts: await oracleFactsCheckouts(fixture),
    },
    headsUp: await oracleHeadsUp(fixture, options),
  };
}

async function assertCardMatchesOracle(card, fixture, options = {}) {
  const expected = await oracleExpectedCard(fixture, options);
  assert.equal(card.now.buildingTickets, expected.now.buildingTickets);
  assert.equal(card.now.checkoutsBuilding, expected.now.checkoutsBuilding);
  assert.equal(card.now.lastTicketFinishedAt, expected.now.lastTicketFinishedAt);
  assert.equal(card.next.ready, expected.next.ready);
  assert.deepEqual(card.next.items, expected.next.items);
  assert.equal(card.blocked.waitingOnTickets, expected.blocked.waitingOnTickets);
  assert.deepEqual(card.blocked.items, expected.blocked.items);
  assert.equal(card.blocked.needYou, expected.blocked.needYou);
  assert.deepEqual(
    card.blocked.needYouItems.map(item => ({ id: item.id, title: item.title, kind: item.kind, command: item.command })).sort((a, b) => a.id.localeCompare(b.id)),
    expected.blocked.needYouItems.sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.deepEqual(card.slots, expected.slots);
  assert.equal(card.eta.days, expected.eta.days);
  assert.equal(card.eta.remaining, expected.eta.remaining);
  assert.equal(card.eta.perDay, expected.eta.perDay);
  assert.equal(card.eta.doneLast7Days, expected.eta.doneLast7Days);
  assert.equal(card.eta.windowDays, expected.eta.windowDays);
  assert.equal(card.eta.basis, expected.eta.basis);
  assert.equal(card.facts.handEditsBlocked24h, expected.facts.handEditsBlocked24h);
  assert.equal(card.facts.untrackedRuns, expected.facts.untrackedRuns);
  assert.equal(card.facts.listHref, expected.facts.listHref);
  assert.equal(card.facts.checkouts, expected.facts.checkouts);
  assert.equal(card.headsUp, expected.headsUp);
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, force) => { const on = force !== undefined ? force : !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
    contains: c => set.has(c),
    toString: () => [...set].join(' '),
  };
}

function makeElement(tag, id) {
  const classList = makeClassList();
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    id: id || '',
    className: '',
    classList,
    children: [],
    childNodes: [],
    style: {},
    dataset: {},
    attributes: {},
    hidden: false,
    textContent: '',
    title: '',
    href: '',
    type: 'button',
    parentNode: null,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    click() { for (const fn of listeners.click || []) fn({ target: this, preventDefault() {} }); },
    querySelector(sel) {
      const walk = n => {
        if (!n) return null;
        if (sel === '.watch-card-pct' && n.classList?.contains('watch-card-pct')) return n;
        if (sel === 'a.watch-card-fact-link' && n.tagName === 'A' && n.classList?.contains('watch-card-fact-link')) return n;
        for (const c of n.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = n => {
        if (!n) return;
        if (sel === '.watch-num' && n.classList?.contains('watch-num')) out.push(n);
        for (const c of n.children || []) walk(c);
      };
      walk(this);
      return out;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return classList.toString(); },
    set(v) { classList.add(...String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

async function loadBoardLib() {
  const doc = makeElement('body');
  doc.createElement = tag => makeElement(tag);
  const win = {
    document: doc,
    location: { search: '', pathname: '/', hash: '' },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    history: { replaceState: () => {} },
  };
  const libSrc = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  const box = { self: win, document: doc };
  vm.runInNewContext(libSrc, box);
  return box.self.BoardLib;
}

function collectText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  return (node.children || []).map(collectText).join('');
}

async function detailFor(fixture, options = {}) {
  const project = fixture.projects[0];
  return projectDetail(project, {
    now: NOW,
    liveRunIds: new Set(),
    env: fixture.env,
    summary,
    slots: options.workersMax ?? 8,
    extraRoots: fixture.projects.map(p => p.root),
    ...options,
  });
}

async function workersParamForFixture(fixture, workersMax = 8) {
  const total = await oracleWorkersHeldTotal(fixture);
  return { max: workersMax, total, free: Math.max(0, workersMax - total), byProject: {}, demand: {} };
}

async function snapshotFor(fixture, options = {}) {
  const workersMax = options.workersMax ?? 8;
  return boardSnapshot({
    projects: [fixture.projects[0]],
    liveRuns: options.liveRuns || [],
    now: NOW,
    env: fixture.env,
    summary,
    workers: await workersParamForFixture(fixture, workersMax),
    ...options,
  });
}

async function writeRichFixture(fixture) {
  const { approveLedger, logPath } = await tools();
  const ledgerFile = path.join(fixture.root, '.swarm', 'project', 'tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  const proposedId = 'T-proposed-page';
  ledger.tickets.push({
    id: proposedId,
    title: 'Proposed page fixture',
    status: 'proposed',
    type: 'build',
    files: ['src/page.ts'],
    createdAt: iso(NOW),
  });
  const build = ledger.tickets.filter(ticket => ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status));
  const [depA, depB] = build.slice(0, 2);
  assert.ok(depA?.id && depB?.id);
  depA.status = 'done';
  depB.status = 'blocked';
  depB.blockReason = 'deps';
  depB.dependsOn = [depA.id];
  const ready = ledger.tickets.find(ticket => ticket.type !== 'human' && !['cancelled', 'proposed', 'done', 'blocked'].includes(ticket.status));
  if (ready?.id) {
    ready.status = 'ready';
    ready.dependsOn = [];
  }
  await fs.writeFile(ledgerFile, JSON.stringify(approveLedger(ledger, { now: iso(NOW) })));
  const journalFile = path.join(fixture.root, '.swarm', 'project', 'journal.ndjson');
  await fs.mkdir(path.dirname(journalFile), { recursive: true });
  await fs.writeFile(journalFile, `${[
    { kind: 'human', id: 'page-human-1', title: 'Human page task', ts: iso(NOW - 3600000) },
  ].map(line => JSON.stringify(line)).join('\n')}\n`);
  await fs.mkdir(path.dirname(logPath(fixture.root)), { recursive: true });
  await fs.writeFile(logPath(fixture.root), `${JSON.stringify({ event: 'transition', id: depA.id, to: 'done', at: iso(NOW - DAY) })}\n`);
  const eventsDir = path.join(fixture.root, '.swarm', 'orchestrator');
  await fs.mkdir(eventsDir, { recursive: true });
  await fs.writeFile(path.join(eventsDir, 'events.ndjson'), `${JSON.stringify({ at: iso(NOW - 3600000), s: 'sess-1', e: 'blocked', t: 'Write', f: 'src/a.ts' })}\n`);
  const { projectId } = await tools();
  const otherId = projectId(path.join(path.dirname(fixture.root), 'foreign'));
  await fs.writeFile(path.join(fixture.lanesDir, 'lanes.json'), `${JSON.stringify({
    version: 1,
    slots: { cursor: [{ id: 's1', pid: process.pid, host: 'fixture-host', runId: 'r1', project: fixture.projects[0].id }, { id: 's2', pid: process.pid, host: 'fixture-host', runId: 'r2', project: otherId }] },
    demand: {},
    pauses: {},
  })}\n`);
}

test('board-accuracy-page test file avoids forbidden static tools imports', async () => {
  const src = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
  const allowedBoardData = new Set(['boardSnapshot', 'projectDetail']);
  const importRe = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"](\.\.\/tools\/[^'"]+)['"]/g;
  for (const match of src.matchAll(importRe)) {
    const spec = match[3];
    if (spec !== '../tools/board-data.mjs') {
      assert.fail(`forbidden static import from ${spec}: only ../tools/board-data.mjs and ./helpers/board-accuracy-fixture.mjs are allowed`);
    }
    const named = match[1];
    if (named) {
      for (const part of named.split(',')) {
        const binding = part.trim().split(/\s+as\s+/).pop().trim();
        assert.ok(allowedBoardData.has(binding), `board-data import "${binding}" is not a function under test`);
      }
    } else {
      assert.ok(allowedBoardData.has(match[2]), `board-data import "${match[2]}" is not a function under test`);
    }
  }
});

test('displayed numbers match disk oracles on project page and overview', async t => {
  const fixture = await makeBoardFixture({
    ledger: 'roadmap-ledger.json',
    worktrees: [{ name: 'linked', runs: [{ id: 'wt-live', status: 'running', startedAt: iso(NOW), jobs: [{ id: 'j-live', status: 'running', agent: 'cursor' }] }] }],
    scratch: [{ runs: [] }],
    runs: [{ id: 'main-untracked', status: 'complete', startedAt: iso(NOW - 2 * DAY), jobs: [{ id: 'T-not-on-ledger', status: 'complete' }] }],
  });
  t.after(fixture.cleanup);
  await writeRichFixture(fixture);
  const liveRuns = [{ runId: 'wt-live', root: fixture.worktreeRoots[0] }];
  const options = { liveRuns, workersMax: 8 };
  const detail = await detailFor(fixture, options);
  const snap = await snapshotFor(fixture, options);
  const overview = snap.projects[0];
  const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, '.swarm', 'project', 'tickets.json'), 'utf8'));
  const percentOracle = await oracleBoardPercent(fixture);
  const runsOnDisk = await readRunsFromDisk(await familyRootsFromDisk(fixture.root, fixture.env));
  const agentsJobsOracle = oracleAgentsJobsFromLiveRuns(liveRuns, runsOnDisk);
  const ticketsOpenOracle = ticketsOpenFromLedger(ledger);
  const ticketsBlockedOracle = ticketsBlockedFromLedger(ledger);
  const liveCountOracle = overview.live?.length ?? liveRuns.length;
  const workersHeldOracle = await oracleWorkersHeldTotal(fixture);
  const agentsTotalOracle = oracleMachineAgentsTotal(liveRuns, runsOnDisk);
  const machineLiveRunsOracle = oracleMachineLiveRuns(liveRuns, runsOnDisk);

  await assertCardMatchesOracle(detail.card, fixture, options);
  await assertCardMatchesOracle(overview.card, fixture, options);
  assert.equal(detail.progress.overall, percentOracle);
  assert.equal(overview.progress.overall, percentOracle);

  const BoardLib = await loadBoardLib();
  const pageHost = makeElement('div');
  BoardLib.renderWatchProjectCard(detail, pageHost, { pageMode: true });
  const pctEl = pageHost.querySelector('.watch-card-pct');
  assert.ok(pctEl);
  assert.equal(pctEl.textContent, String(percentOracle));
  const pageNums = pageHost.querySelectorAll('.watch-num').map(n => n.textContent);
  assert.ok(pageNums.includes(String(await oracleBuildingTickets(fixture))));
  assert.ok(pageNums.includes(String((await oracleNextReady(fixture)).length)));
  const untrackedLink = pageHost.querySelector('a.watch-card-fact-link');
  assert.ok(untrackedLink);
  assert.equal(untrackedLink.href, `#${OFF_LEDGER_LIST_ANCHOR_ID}`);

  const cardHost = makeElement('div');
  BoardLib.renderWatchProjectCard(overview, cardHost, {});
  const cardText = collectText(cardHost);
  assert.match(cardText, new RegExp(String(percentOracle)));
  assert.match(cardText, new RegExp(String(await oracleUntrackedRuns(fixture, NOW))));

  const jobsCellText = `${overview.agents.jobs.running} run, ${overview.agents.jobs.queued} q, ${overview.agents.jobs.blocked} blk`;
  assert.equal(overview.agents.jobs.running, agentsJobsOracle.running);
  assert.equal(overview.agents.jobs.queued, agentsJobsOracle.queued);
  assert.equal(overview.agents.jobs.blocked, agentsJobsOracle.blocked);
  assert.match(jobsCellText, new RegExp(String(agentsJobsOracle.running)));
  const ticketsCellText = `${overview.tickets.open} open` + (overview.tickets.blocked ? `, ${overview.tickets.blocked} blocked` : '');
  assert.equal(overview.tickets.open, ticketsOpenOracle);
  assert.equal(overview.tickets.blocked, ticketsBlockedOracle);
  assert.match(ticketsCellText, new RegExp(String(ticketsOpenOracle)));
  assert.equal(liveCountOracle, machineLiveRunsOracle);

  const kpis = makeElement('div', 'kpis');
  const agentsVal = makeElement('div', 'v');
  agentsVal.appendChild(BoardLib.watchNum(snap.machine.agents.total, 'live agents', String(snap.machine.agents.total)));
  kpis.appendChild(BoardLib.kpiTile('Live agents', agentsVal, String(snap.machine.liveRuns) + ' live runs', null));
  const heldVal = makeElement('div', 'v');
  heldVal.appendChild(BoardLib.watchNum(snap.machine.workers.total, 'workers held', String(snap.machine.workers.total)));
  kpis.appendChild(BoardLib.kpiTile('Workers held', heldVal, 'machine limit', null));
  const kpiNums = kpis.querySelectorAll('.watch-num').map(n => n.textContent);
  assert.equal(snap.machine.agents.total, agentsTotalOracle);
  assert.equal(snap.machine.liveRuns, machineLiveRunsOracle);
  assert.equal(snap.machine.workers.total, workersHeldOracle);
  assert.equal(kpiNums[0], String(agentsTotalOracle));
  assert.equal(kpiNums[1], String(workersHeldOracle));
});

test('page COVERAGE lists every asserted displayed field', async () => {
  for (const key of Object.keys(COVERAGE)) {
    assert.ok(COVERAGE[key], key);
  }
  assert.ok(COVERAGE['progress.overall']);
  assert.ok(COVERAGE['overview.table.jobs.running']);
});

test('project page and board scripts avoid forbidden wording', async () => {
  const projectJs = await fs.readFile(path.join(assets, 'project.js'), 'utf8');
  const boardJs = await fs.readFile(boardPath, 'utf8');
  assert.doesNotMatch(projectJs, /off-ledger/i);
  assert.doesNotMatch(boardJs, /off-ledger/i);
});
