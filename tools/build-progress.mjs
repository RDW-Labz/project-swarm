// SPDX-License-Identifier: Apache-2.0
// Read-only build progress for one project, assembled from its ledger, scope, journal and history.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLedger, isApproved } from './tickets.mjs';
import { worktreeFamily } from './project-spend.mjs';
import { parseScope } from './scope.mjs';
import { doneTimes } from './client-report.mjs';
import { openDecisions } from './inbox.mjs';
import { journalPath, readJournal } from './journal.mjs';
import { historyFile as defaultHistoryFile, readHistory } from './history.mjs';
import { runTotals } from './spend.mjs';

const DAY = 86400000;
const OPEN = new Set(['todo', 'ready', 'running', 'review', 'blocked']);
const COUNTED = ticket => ticket && ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status);
const OWNER_TICKET = ticket => ticket && !['cancelled', 'proposed'].includes(ticket.status);
const stageNumber = stage => { const match = /^S(\d+)$/.exec(String(stage ?? '')); return match ? Number(match[1]) : null; };
const pct = (done, total) => total > 0 ? Math.max(0, Math.min(100, Math.floor(done * 100 / total))) : null;
const text = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const requirementIdRe = /R-\d{3,}/gi;

function requirementIds(ticket) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(requirementIdRe)) ids.add(match[0].toUpperCase());
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      visit(value.id);
      visit(value.requirement);
    }
  };
  visit(ticket?.scopeRefs);
  visit(ticket?.requirement);
  visit(ticket?.requirements);
  return [...ids];
}

function stageMap(scope) {
  const requirements = new Map();
  for (const requirement of scope?.requirements ?? []) requirements.set(String(requirement.id).toUpperCase(), requirement.stage);
  return requirements;
}

function stageOrder(scope, stage) {
  const fromScope = (scope?.stages ?? []).find(item => item.id === stage);
  return fromScope?.order ?? stageNumber(stage) ?? Number.MAX_SAFE_INTEGER;
}

export function stageDisplay(scope, stageId) {
  const raw = text(stageId, 'none');
  if (raw === 'none' || raw === '') return 'No stage';
  const known = (scope?.stages ?? []).find(stage => stage.id === raw);
  if (known?.title) return text(known.title);
  const number = stageNumber(raw);
  return number === null ? raw : `Stage ${number}`;
}

export function effectiveStage(scope, ticket) {
  const stages = stageMap(scope);
  const linked = requirementIds(ticket).map(id => stages.get(id)).filter(Boolean);
  const own = text(ticket?.stage, 'none');
  const knownStageIds = new Set((scope?.stages ?? []).map(stage => stage.id));
  if (knownStageIds.has(own) && linked.length && linked.every(stage => stage === own)) return own;
  if (linked.length) return linked.slice().sort((a, b) => stageOrder(scope, a) - stageOrder(scope, b) || a.localeCompare(b))[0];
  return own || 'none';
}

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

function emptyProgress(notes = []) {
  return {
    percent: { tickets: { done: 0, total: 0, pct: null }, requirements: null, overall: null },
    stages: [],
    left: { openByType: {}, human: [], blockers: [], approvals: [] },
    milestones: [],
    eta: null,
    offLedger: { runs: [], count: 0 },
    spend: null,
    finished: false,
    source: { root: null, approvedAt: null, updatedAt: null, differs: false, candidates: 0 },
    notes,
  };
}

function milestone(key, label, state, at = null, evidence = null) {
  return { key, label, state, at, evidence };
}

function stageRows(scope, tickets) {
  const stages = new Map();
  for (const stage of scope?.stages ?? []) stages.set(stage.id, { id: stage.id, stageId: stage.id, title: text(stage.title) || stageDisplay(scope, stage.id), order: stageOrder(scope, stage.id) });
  for (const ticket of tickets) {
    const id = effectiveStage(scope, ticket);
    if (!stages.has(id)) stages.set(id, { id, stageId: id, title: stageDisplay(scope, id), order: stageOrder(scope, id) });
  }
  return [...stages.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(stage => {
    const mine = tickets.filter(ticket => effectiveStage(scope, ticket) === stage.id);
    const done = mine.filter(ticket => ticket.status === 'done').length;
    const blocked = mine.filter(ticket => ticket.status === 'blocked').length;
    const open = mine.filter(ticket => OPEN.has(ticket.status) && ticket.status !== 'blocked').length;
    return { id: stage.id, stageId: stage.stageId, title: stage.title, total: mine.length, done, open, blocked, pct: pct(done, mine.length) };
  });
}

function requirementsOf(scope, tickets) {
  if (!scope) return null;
  const requirements = Array.isArray(scope.requirements) ? scope.requirements : [];
  let covered = 0;
  for (const requirement of requirements) {
    const mine = tickets.filter(ticket => requirementIds(ticket).includes(String(requirement.id).toUpperCase()));
    if (mine.length > 0 && mine.every(ticket => ticket.status === 'done')) covered += 1;
  }
  return { covered, total: requirements.length, pct: pct(covered, requirements.length) };
}

function acceptanceBlocked(ticket) {
  return Boolean(ticket.acceptanceBlocked) || (Array.isArray(ticket.acceptanceResults) && ticket.acceptanceResults.some(result => !['pass', 'passed', 'met'].includes(result?.verdict)));
}

function spendOf(spend) {
  if (!spend) return null;
  return {
    usd: spend.usd ?? null,
    capUsd: spend.capUsd ?? null,
    reached: spend.reached ?? false,
    why: spend.why ?? null,
    capBasis: spend.capBasis ?? 'billed+list',
  };
}

async function readScope(root, ledger, notes) {
  let relative = ledger?.scope?.file ? String(ledger.scope.file) : null;
  if (!relative) {
    const roadmap = path.join(root, 'docs', 'scope', 'roadmap.md');
    relative = await exists(roadmap) ? path.join('docs', 'scope', 'roadmap.md') : path.join('docs', 'scope', 'scope.md');
  }
  const file = path.resolve(root, relative);
  try {
    const base = path.resolve(root);
    if (file !== base && !file.startsWith(`${base}${path.sep}`)) throw new Error('scope file is outside the project');
    return parseScope(await fs.readFile(file, 'utf8'));
  } catch (error) {
    notes.push(`scope unavailable: ${text(error.message, 'could not read scope')}`);
    return null;
  }
}

const dateScore = value => {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

export async function ledgerRoot(root, { family = worktreeFamily } = {}) {
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const members = await family(root, { all: true });
  const roots = [];
  for (const member of [...(Array.isArray(members) ? members : []), root]) {
    const candidateRoot = await fs.realpath(member).catch(() => path.resolve(member));
    if (!roots.includes(candidateRoot)) roots.push(candidateRoot);
  }
  const candidates = [];
  for (const candidateRoot of roots) {
    let ledger;
    try { ledger = await readLedger(candidateRoot); } catch { continue; }
    if (!ledger) continue;
    let approved = false;
    try { approved = isApproved(ledger); } catch { approved = false; }
    candidates.push({
      root: candidateRoot,
      ledger,
      approvedAt: approved ? (ledger.approved?.at ?? null) : null,
      updatedAt: ledger.updatedAt ?? null,
      approved,
    });
  }
  candidates.sort((a, b) => (Number(b.approved) - Number(a.approved)) || (dateScore(b.approvedAt) - dateScore(a.approvedAt)) || (dateScore(b.updatedAt) - dateScore(a.updatedAt)));
  const chosen = candidates[0] ?? { root: realRoot, ledger: null, approvedAt: null, updatedAt: null };
  return {
    root: chosen.root,
    ledger: chosen.ledger,
    candidates: candidates.map(({ root: candidateRoot, approvedAt, updatedAt }) => ({ root: candidateRoot, approvedAt, updatedAt })),
    differs: chosen.root !== realRoot,
  };
}

async function readLedgerSafe(root, notes) {
  try {
    const ledger = await readLedger(root);
    if (!ledger) notes.push('ticket ledger unavailable');
    return ledger;
  } catch (error) {
    notes.push(`ticket ledger unavailable: ${text(error.message)}`);
    return null;
  }
}

async function readJournalSafe(root, notes) {
  try {
    const events = await readJournal(root, { limit: Infinity });
    if (!(await exists(journalPath(root)))) notes.push('journal unavailable');
    return events;
  } catch (error) {
    notes.push(`journal unavailable: ${text(error.message)}`);
    return null;
  }
}

const historyCache = new Map(); // history path -> { mtimeMs, size, events }: shared by board polls
async function readHistorySafe(projectId, historyFile, notes) {
  const file = historyFile ?? defaultHistoryFile();
  try {
    let stat;
    try { stat = await fs.stat(file); } catch (error) {
      if (error.code === 'ENOENT') { notes.push('history unavailable'); return null; }
      throw error;
    }
    const hit = historyCache.get(file);
    let events = hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size ? hit.events : null;
    if (!events) {
      const result = await readHistory({ file, limit: 100000, cap: 100000 });
      events = result.events.filter(event => event.kind === 'pr' || event.kind === 'merge');
      historyCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events });
    }
    return events.filter(event => event.projectId === projectId || event.project === projectId);
  } catch (error) {
    notes.push(`history unavailable: ${text(error.message)}`);
    return null;
  }
}

async function readDoneTimes(root, notes) {
  try {
    const times = await doneTimes(root);
    if (!(await exists(path.join(root, '.swarm', 'project', 'tickets.log')))) notes.push('ticket completion log unavailable');
    return times;
  } catch (error) {
    notes.push(`ticket completion log unavailable: ${text(error.message)}`);
    return null;
  }
}

async function readRunStates(root) {
  const dir = path.join(root, '.swarm', 'runs');
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) continue;
    const folder = path.join(dir, name);
    try {
      const info = await fs.lstat(folder);
      if (!info.isDirectory()) continue;
      const state = JSON.parse(await fs.readFile(path.join(folder, 'state.json'), 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
      out.push({ root, runId: name, state });
    } catch { /* an incomplete or damaged run is not progress evidence */ }
  }
  return out;
}

async function readRunRecords(roots) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const record of await readRunStates(root)) {
      if (seen.has(record.runId)) continue;
      seen.add(record.runId);
      out.push(record);
    }
  }
  return out;
}

function prNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string') return null;
  const url = /\/pull\/(\d+)(?:\/?$)/i.exec(value.trim());
  if (url) return url[1];
  const hash = /^#(\d+)$/.exec(value.trim());
  return hash ? hash[1] : null;
}

function ticketPr(ticket) {
  return prNumber(ticket?.pr);
}

function stateTicketIds(state) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') { visit(value.id); visit(value.ticket); visit(value.ticketId); }
  };
  visit(state?.ticketIds);
  visit(state?.tickets);
  return ids;
}

function jobTicketIds(job) {
  const ids = new Set();
  for (const key of ['id', 'ticket', 'ticketId']) if (typeof job?.[key] === 'string') ids.add(job[key]);
  return ids;
}

function linkedTicketsForEvent(event, ledger, runRecords, approvedAt = null) {
  const at = Date.parse(event?.at ?? '');
  const approvedMs = Date.parse(approvedAt ?? '');
  if (Number.isFinite(approvedMs) && (!Number.isFinite(at) || at < approvedMs)) return [];
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  const linked = new Set();
  const eventPr = prNumber(event?.ref);
  if (eventPr) for (const ticket of tickets) if (ticketPr(ticket) === eventPr) linked.add(ticket.id);
  if (event?.run) {
    for (const record of runRecords.filter(item => item.runId === event.run)) {
      const ids = stateTicketIds(record.state);
      for (const job of record.state.jobs ?? []) for (const id of jobTicketIds(job)) ids.add(id);
      for (const ticket of tickets) if (ids.has(ticket.id)) linked.add(ticket.id);
    }
  }
  return [...linked];
}

function linkedHistory(history, ledger, runRecords) {
  const approvedAt = ledger?.approved?.at ?? null;
  return (history ?? []).map(event => ({ event, ticketIds: linkedTicketsForEvent(event, ledger, runRecords, approvedAt) })).filter(item => item.ticketIds.length);
}

function runCost(state) {
  try { return Math.round(Number(runTotals(state).usd || 0) * 1e6) / 1e6; } catch { return 0; }
}

function offLedgerRuns(records, ledger, history, now) {
  const ids = new Set((ledger?.tickets ?? []).map(ticket => ticket?.id).filter(Boolean));
  const prsByRun = new Map();
  for (const event of history ?? []) {
    if (!event.run || !['pr', 'merge'].includes(event.kind)) continue;
    const ref = prNumber(event.ref);
    if (!ref) continue;
    const list = prsByRun.get(event.run) ?? [];
    if (!list.includes(`#${ref}`)) list.push(`#${ref}`);
    prsByRun.set(event.run, list);
  }
  const runs = [];
  for (const record of records) {
    const started = Date.parse(record.state.startedAt ?? '');
    if (!Number.isFinite(started) || started < now - 14 * DAY || started > now) continue;
    const jobs = Array.isArray(record.state.jobs) ? record.state.jobs : [];
    const mapped = jobs.some(job => [...jobTicketIds(job)].some(id => ids.has(id))) || [...stateTicketIds(record.state)].some(id => ids.has(id));
    if (mapped) continue;
    runs.push({
      runId: record.runId,
      startedAt: iso(record.state.startedAt),
      status: text(record.state.status, 'unknown'),
      jobs: jobs.length,
      done: jobs.filter(job => job?.status === 'complete').length,
      costUsd: runCost(record.state),
      prs: prsByRun.get(record.runId) ?? [],
    });
  }
  runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || a.runId.localeCompare(b.runId));
  return { runs, count: runs.length };
}

function buildMilestones({ ledger, tickets, history, historyKnown, runRecords = [], deploy = null }) {
  let approved = false;
  try { approved = Boolean(ledger && isApproved(ledger)); } catch { approved = false; }
  const counted = tickets.filter(COUNTED);
  const building = counted.some(ticket => ticket.status === 'done' || ['running', 'review'].includes(ticket.status));
  const e2e = counted.length > 0 && counted.every(ticket => ticket.status === 'done') && !counted.some(acceptanceBlocked);
  const linked = linkedHistory(history, ledger, runRecords);
  const prs = linked.filter(item => item.event.kind === 'pr').map(item => item.event);
  const merges = linked.filter(item => item.event.kind === 'merge').map(item => item.event);
  const newestPr = prs.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const newestMerge = merges.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
  const prDone = Boolean(newestPr);
  const mergeDone = Boolean(newestPr && newestMerge && Date.parse(newestMerge.at) >= Date.parse(newestPr.at));
  const deploySuccess = deploy?.lastSuccess;
  const deployedAfterMerge = Boolean(deploySuccess && (!mergeDone || Date.parse(deploySuccess.at) >= Date.parse(newestMerge?.at ?? '')));
  const deployedEvidence = deploySuccess ? `${deploySuccess.environment || 'deploy'}${deploySuccess.url ? ` ${deploySuccess.url}` : ''}` : null;
  const deployed = deployedAfterMerge
    ? milestone('deployed', 'Deployed', 'done', deploySuccess.at, deployedEvidence)
    : deploy?.latest?.state === 'failure' || deploy?.latest?.state === 'error'
      ? milestone('deployed', 'Deployed', 'todo', null, `last deploy failed ${deploy.latest.at}`)
      : deploy?.latest
        ? milestone('deployed', 'Deployed', 'todo', null, `latest deploy ${deploy.latest.state}`)
        : milestone('deployed', 'Deployed', 'unknown', null, deploy?.error ? `not tracked: ${deploy.error}` : 'not tracked');
  const raw = [
    ledger ? milestone('scope', 'Scope approved', approved ? 'done' : 'todo', approved ? iso(ledger.approved?.at) : null, approved ? 'ledger approval' : null) : milestone('scope', 'Scope approved', 'unknown'),
    ledger ? milestone('building', 'Building', building ? 'done' : 'todo', null, building ? 'ticket activity' : null) : milestone('building', 'Building', 'unknown'),
    ledger ? milestone('e2e', 'E2E green', e2e ? 'done' : 'todo', null, e2e ? 'all counted tickets done' : null) : milestone('e2e', 'E2E green', 'unknown'),
    historyKnown ? milestone('pr', 'PR open', prDone ? 'done' : 'todo', prDone ? iso(newestPr.at) : null, prDone ? (newestPr.ref ?? null) : null) : milestone('pr', 'PR open', 'unknown'),
    historyKnown ? milestone('merged', 'Merged', mergeDone ? 'done' : 'todo', mergeDone ? iso(newestMerge.at) : null, mergeDone ? (newestMerge.ref ?? null) : null) : milestone('merged', 'Merged', 'unknown'),
    deployed,
  ];
  const furthestDone = raw.reduce((last, item, index) => item.state === 'done' ? index : last, -1);
  if (furthestDone >= 0) {
    raw[furthestDone].state = 'current';
    raw[furthestDone].currentDone = true;
    for (let index = furthestDone + 1; index < raw.length; index += 1) if (raw[index].key !== 'deployed') raw[index].state = 'todo';
  } else {
    const first = raw.find(item => item.key !== 'deployed');
    if (first) first.state = 'current';
  }
  return raw;
}

export async function buildProgress({ root, projectId, now = Date.now(), historyFile, spend = null, deploy = null } = {}) {
  const notes = [];
  try {
    const selected = await ledgerRoot(root);
    const sourceCandidate = selected.candidates.find(candidate => candidate.root === selected.root);
    const source = { root: selected.root, approvedAt: sourceCandidate?.approvedAt ?? null, updatedAt: sourceCandidate?.updatedAt ?? null, differs: selected.differs, candidates: selected.candidates.length };
    if (selected.differs) notes.push(`ledger read from ${path.basename(selected.root)} (newest approved of ${selected.candidates.length} checkouts)`);
    const ledger = selected.ledger;
    if (!ledger) notes.push('ticket ledger unavailable');
    const scope = await readScope(selected.root, ledger, notes);
    const journal = await readJournalSafe(selected.root, notes);
    const history = await readHistorySafe(projectId, historyFile, notes);
    const times = await readDoneTimes(selected.root, notes);
    const runRecords = await readRunRecords([root, selected.root]);
    const allTickets = Array.isArray(ledger?.tickets) ? ledger.tickets.filter(ticket => ticket && typeof ticket === 'object') : [];
    const tickets = allTickets.filter(COUNTED);
    const ticketDone = tickets.filter(ticket => ticket.status === 'done').length;
    const requirements = requirementsOf(scope, tickets);
    const approvals = [];
    let approved = false;
    try { approved = Boolean(ledger && isApproved(ledger)); } catch (error) { notes.push(`approval status unavailable: ${text(error.message)}`); }
    if (ledger && !approved) approvals.push({ kind: 'scope', id: 'scope', title: 'Scope approval required' });
    for (const ticket of allTickets.filter(ticket => ticket.status === 'proposed')) approvals.push({ kind: 'proposal', id: text(ticket.id), title: text(ticket.title, text(ticket.id)) });
    for (const decision of journal ? openDecisions(journal) : []) approvals.push({ kind: 'decision', id: text(decision.id), title: text(decision.text ?? decision.question, text(decision.id)) });

    const openTickets = tickets.filter(ticket => OPEN.has(ticket.status));
    const ownerTickets = allTickets.filter(OWNER_TICKET);
    const ownerOpenTickets = ownerTickets.filter(ticket => OPEN.has(ticket.status));
    const openByType = Object.create(null);
    for (const ticket of ownerOpenTickets) openByType[ticket.type ?? 'other'] = (openByType[ticket.type ?? 'other'] ?? 0) + 1;
    const blockers = [];
    for (const ticket of ownerTickets) {
      if (ticket.status === 'blocked') blockers.push({ id: text(ticket.id), title: text(ticket.title, text(ticket.id)), reason: text(ticket.blockReason, 'blocked') });
      if (ticket.acceptanceBlocked) blockers.push({ id: text(ticket.id), title: text(ticket.title, text(ticket.id)), reason: text(ticket.acceptanceBlocked.reason, 'acceptance blocked') });
    }
    const doneIds = new Set(tickets.filter(ticket => ticket.status === 'done').map(ticket => ticket.id));
    const completion = new Map();
    const setEarliest = (id, at) => {
      if (!doneIds.has(id) || !Number.isFinite(at) || at > now) return;
      completion.set(id, Math.min(completion.get(id) ?? Number.POSITIVE_INFINITY, at));
    };
    for (const [id, at] of times ?? []) setEarliest(id, at);
    const logDoneCount = completion.size;
    let usedWaveAtFallback = false;
    let usedRunFallback = false;
    let usedMergeFallback = false;
    for (const ticket of tickets) {
      if (ticket.status !== 'done') continue;
      const at = Date.parse(ticket.waveAt ?? '');
      if (!Number.isFinite(at)) continue;
      const before = completion.get(ticket.id);
      setEarliest(ticket.id, at);
      if (completion.has(ticket.id) && completion.get(ticket.id) !== before) usedWaveAtFallback = true;
    }
    if (logDoneCount < 2) {
      for (const record of runRecords) {
        for (const job of record.state.jobs ?? []) {
          const at = Date.parse(job?.finishedAt ?? '');
          if (!Number.isFinite(at)) continue;
          for (const id of jobTicketIds(job)) if (doneIds.has(id)) {
            const before = completion.get(id);
            setEarliest(id, at);
            if (completion.get(id) !== before) usedRunFallback = true;
          }
        }
      }
      const mergeLinks = linkedHistory(history, ledger, runRecords).filter(item => item.event.kind === 'merge');
      for (const item of mergeLinks) {
        const at = Date.parse(item.event.at ?? '');
        for (const id of item.ticketIds) if (doneIds.has(id)) {
          const before = completion.get(id);
          setEarliest(id, at);
          if (completion.get(id) !== before) usedMergeFallback = true;
        }
      }
    }
    const relevantTimes = [...completion.values()].filter(at => Number.isFinite(at) && at <= now);
    const recent14 = relevantTimes.filter(at => at >= now - 14 * DAY);
    const recent30 = relevantTimes.filter(at => at >= now - 30 * DAY);
    let eta = null;
    const etaFor = (count, days, basis) => {
      const unroundedRate = count / days;
      const perDay = Number.isFinite(unroundedRate) && unroundedRate > 0 ? Math.round(unroundedRate * 100) / 100 : 0;
      const remaining = openTickets.length;
      const etaDays = remaining === 0 ? 0 : perDay > 0 ? Math.min(3650, Math.ceil(remaining / perDay)) : Number.isFinite(unroundedRate) && unroundedRate > 0 ? Math.min(3650, Math.ceil(remaining / unroundedRate)) : 3650;
      const source = usedRunFallback ? ' (from run finish times)' : usedMergeFallback ? ' (from merge history)' : usedWaveAtFallback ? ' (from wave timestamps)' : '';
      return { remaining, perDay, days: etaDays, basis: `${basis}${source}` };
    };
    if (recent14.length >= 2) {
      eta = etaFor(recent14.length, 14, `${recent14.length} done in the last 14 days`);
    } else if (recent30.length >= 2) {
      eta = etaFor(recent30.length, 30, `${recent30.length} done in the last 30 days`);
    } else if (relevantTimes.length >= 2) {
      const since = Math.min(...relevantTimes);
      const days = Math.max(1, (now - since) / DAY);
      eta = etaFor(relevantTimes.length, days, `${relevantTimes.length} done since ${new Date(since).toISOString().slice(0, 10)}`);
    } else {
      notes.push('no completion times recorded in tickets.log');
    }
    const milestones = buildMilestones({ ledger, tickets, history, historyKnown: history !== null, runRecords, deploy });
    const e2eItem = milestones.find(item => item.key === 'e2e');
    const mergedItem = milestones.find(item => item.key === 'merged');
    const e2e = e2eItem?.state === 'done' || e2eItem?.currentDone === true;
    const merged = mergedItem?.state === 'done' || mergedItem?.currentDone === true;
    const finished = Boolean((requirements ? requirements.covered === requirements.total : ticketDone === tickets.length && tickets.length > 0) && e2e && merged);
    const offLedger = offLedgerRuns(runRecords, ledger, history, now);
    const result = {
      percent: { tickets: { done: ticketDone, total: tickets.length, pct: pct(ticketDone, tickets.length) }, requirements, overall: pct(ticketDone, tickets.length) },
      stages: stageRows(scope, tickets),
      left: { openByType: Object.fromEntries(Object.entries(openByType).filter(([, count]) => count > 0)), human: ownerOpenTickets.filter(ticket => ticket.type === 'human').map(ticket => { const stageId = effectiveStage(scope, ticket); return { id: text(ticket.id), title: text(ticket.title, text(ticket.id)), stage: stageDisplay(scope, stageId), stageId }; }), blockers, approvals },
      milestones,
      eta,
      offLedger,
      spend: spendOf(spend),
      finished,
      source,
      notes,
    };
    return result;
  } catch (error) {
    notes.push(`build progress unavailable: ${text(error.message, 'unknown error')}`);
    return emptyProgress(notes);
  }
}

export function progressSummary(progress) {
  if (!progress) return null;
  const current = progress.finished ? 'Finished' : progress.milestones?.find(item => item.state === 'current')?.label ?? 'Unknown';
  return { overall: progress.percent?.overall ?? null, ticketsPct: progress.percent?.tickets?.pct ?? null, current, eta: progress.eta?.days ?? null, finished: Boolean(progress.finished), offLedger: progress.offLedger?.count ?? 0 };
}
