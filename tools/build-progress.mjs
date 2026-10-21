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

const DAY = 86400000;
const OPEN = new Set(['todo', 'ready', 'running', 'review', 'blocked']);
const COUNTED = ticket => ticket && ticket.type !== 'human' && !['cancelled', 'proposed'].includes(ticket.status);
const OWNER_TICKET = ticket => ticket && !['cancelled', 'proposed'].includes(ticket.status);
const stageNumber = stage => { const match = /^S(\d+)$/.exec(String(stage ?? '')); return match ? Number(match[1]) : null; };
const pct = (done, total) => total > 0 ? Math.max(0, Math.min(100, Math.floor(done * 100 / total))) : null;
const text = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

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
  for (const stage of scope?.stages ?? []) stages.set(stage.id, { id: stage.id, title: text(stage.title), order: stageNumber(stage.id) ?? Number.MAX_SAFE_INTEGER });
  for (const ticket of tickets) {
    const id = text(ticket.stage, 'none');
    if (!stages.has(id)) stages.set(id, { id, title: '', order: stageNumber(id) ?? Number.MAX_SAFE_INTEGER });
  }
  return [...stages.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(stage => {
    const mine = tickets.filter(ticket => text(ticket.stage, 'none') === stage.id);
    const done = mine.filter(ticket => ticket.status === 'done').length;
    const open = mine.filter(ticket => OPEN.has(ticket.status)).length;
    const blocked = mine.filter(ticket => ticket.status === 'blocked').length;
    return { id: stage.id, title: stage.title, total: mine.length, done, open, blocked, pct: pct(done, mine.length) };
  });
}

function requirementsOf(scope, tickets) {
  if (!scope) return null;
  const requirements = Array.isArray(scope.requirements) ? scope.requirements : [];
  let covered = 0;
  for (const requirement of requirements) {
    const mine = tickets.filter(ticket => (ticket.scopeRefs ?? []).includes(requirement.id));
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

function buildMilestones({ ledger, tickets, history, historyKnown, deploy = null }) {
  let approved = false;
  try { approved = Boolean(ledger && isApproved(ledger)); } catch { approved = false; }
  const counted = tickets.filter(COUNTED);
  const building = counted.some(ticket => ticket.status === 'done' || ['running', 'review'].includes(ticket.status));
  const e2e = counted.length > 0 && counted.every(ticket => ticket.status === 'done') && !counted.some(acceptanceBlocked);
  const prs = (history ?? []).filter(event => event.kind === 'pr');
  const merges = (history ?? []).filter(event => event.kind === 'merge');
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
  let current = false;
  for (const item of raw) {
    if (item.state === 'done' || item.state === 'unknown') continue;
    if (!current) { item.state = 'current'; current = true; } else item.state = 'todo';
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
    const relevantTimes = times ? [...times.entries()].filter(([id, at]) => tickets.some(ticket => ticket.id === id) && at <= now).map(([, at]) => at) : [];
    const recent14 = relevantTimes.filter(at => at >= now - 14 * DAY);
    const recent30 = relevantTimes.filter(at => at >= now - 30 * DAY);
    let eta = null;
    if (recent14.length >= 2) {
      const perDay = Math.round((recent14.length / 14) * 100) / 100;
      eta = { remaining: openTickets.length, perDay, days: openTickets.length === 0 ? 0 : Math.ceil(openTickets.length / perDay), basis: `${recent14.length} done in the last 14 days` };
    } else if (recent30.length >= 2) {
      const perDay = Math.round((recent30.length / 30) * 100) / 100;
      eta = { remaining: openTickets.length, perDay, days: openTickets.length === 0 ? 0 : Math.ceil(openTickets.length / perDay), basis: `${recent30.length} done in the last 30 days` };
    } else if (relevantTimes.length >= 2) {
      const since = Math.min(...relevantTimes);
      const days = Math.max(1, (now - since) / DAY);
      const perDay = Math.round((relevantTimes.length / days) * 100) / 100;
      eta = { remaining: openTickets.length, perDay, days: openTickets.length === 0 ? 0 : Math.ceil(openTickets.length / perDay), basis: `${relevantTimes.length} done since ${new Date(since).toISOString().slice(0, 10)}` };
    } else {
      notes.push('no completion times recorded in tickets.log');
    }
    const milestones = buildMilestones({ ledger, tickets, history, historyKnown: history !== null, deploy });
    const e2e = milestones.find(item => item.key === 'e2e')?.state === 'done';
    const merged = milestones.find(item => item.key === 'merged')?.state === 'done';
    const finished = Boolean((requirements ? requirements.covered === requirements.total : ticketDone === tickets.length && tickets.length > 0) && e2e && merged);
    const result = {
      percent: { tickets: { done: ticketDone, total: tickets.length, pct: pct(ticketDone, tickets.length) }, requirements, overall: requirements ? requirements.pct : pct(ticketDone, tickets.length) },
      stages: stageRows(scope, tickets),
      left: { openByType: Object.fromEntries(Object.entries(openByType).filter(([, count]) => count > 0)), human: ownerOpenTickets.filter(ticket => ticket.type === 'human').map(ticket => ({ id: text(ticket.id), title: text(ticket.title, text(ticket.id)), stage: ticket.stage ?? null })), blockers, approvals },
      milestones,
      eta,
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
  return { overall: progress.percent?.overall ?? null, ticketsPct: progress.percent?.tickets?.pct ?? null, current, eta: progress.eta?.days ?? null, finished: Boolean(progress.finished) };
}
