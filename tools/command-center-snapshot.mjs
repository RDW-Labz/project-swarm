// SPDX-License-Identifier: Apache-2.0
// Board /api/board payload → Command Center snapshot and per-project cockpit data.

import { ticketCountsOf } from './ticket-counts.mjs';
import { readyTickets } from './tickets.mjs';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function field(label, value, unit, source, explanation) {
  const n = num(value);
  if (n === null || !source) return undefined;
  return { label, value: n, unit, source, explanation };
}

function textField(label, value, source, explanation) {
  if (value === null || value === undefined || value === '' || !source) return undefined;
  return { label, value: String(value), source, explanation };
}

function projectLane(p) {
  if (p.directBuild) return 'control';
  if ((p.card?.blocked?.needYou ?? 0) > 0) return 'safety';
  if ((p.card?.now?.buildingTickets ?? 0) > 0) return 'context';
  if ((p.readyTickets ?? 0) > 0) return 'route';
  return 'control';
}

function needsYouTotal(projects) {
  let total = 0;
  let any = false;
  for (const p of projects) {
    const n = p.card?.blocked?.needYou;
    if (typeof n === 'number' && Number.isFinite(n)) { total += n; any = true; }
  }
  return any ? total : null;
}

const EXCLUDED_FROM_TOTAL = new Set(['cancelled', 'proposed', 'superseded']);

function shapeFromStatusMap(by, { readyFromStatusOnly = false, tickets = null } = {}) {
  if (!by || typeof by !== 'object') return null;
  const get = (k) => (num(by[k]) ?? 0);
  let total = 0;
  for (const [status, count] of Object.entries(by)) {
    if (EXCLUDED_FROM_TOTAL.has(status)) continue;
    total += num(count) ?? 0;
  }
  const done = get('done');
  const cancelled = get('cancelled');
  const proposed = get('proposed');
  const superseded = get('superseded');
  const review = get('review');
  const blocked = get('blocked');
  const todo = get('todo');
  let ready = get('ready');
  if (tickets && !readyFromStatusOnly) {
    ready = readyTickets(tickets).length;
  } else if (readyFromStatusOnly) {
    ready = get('ready');
  }
  const remaining = Math.max(0, total - done);
  const percentDone = total ? Math.round((100 * done) / total) : 0;
  return {
    total,
    done,
    ready,
    blocked,
    review,
    todo,
    cancelled,
    proposed,
    superseded,
    remaining,
    percentDone,
    counted: total,
  };
}

function ticketCountsFromLedgerRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const tickets = rows.filter(t => t && typeof t === 'object');
  const by = {};
  for (const t of tickets) if (t.status) by[t.status] = (by[t.status] ?? 0) + 1;
  const hasDeps = tickets.some(t => Array.isArray(t.dependsOn) && t.dependsOn.length);
  const hasType = tickets.some(t => t.type != null);
  const shaped = shapeFromStatusMap(by, {
    readyFromStatusOnly: !hasDeps && !hasType,
    tickets: hasDeps || hasType ? tickets : null,
  });
  return shaped;
}

function mergeCardTicketCounts(p, index) {
  const prefix = `projects[${index}]`;
  let base = null;
  let source = null;
  if (p?.counts && typeof p.counts === 'object') {
    base = { ...p.counts };
    source = `${prefix}.counts`;
  } else {
    const fromLedger = ticketCountsFromLedgerRows(p?.ledger?.tickets);
    if (fromLedger) {
      base = fromLedger;
      source = `${prefix}.ledger.tickets`;
    } else if (p?.tickets?.byStatus && Object.keys(p.tickets.byStatus).length) {
      base = shapeFromStatusMap(p.tickets.byStatus, { readyFromStatusOnly: true });
      source = `${prefix}.tickets.byStatus`;
    }
  }
  if (!base) return null;
  const needYou = p.card?.blocked?.needYou;
  return {
    total: base.total,
    done: base.done,
    ready: base.ready,
    blocked: base.blocked,
    review: base.review,
    todo: base.todo ?? 0,
    cancelled: base.cancelled,
    proposed: base.proposed ?? 0,
    superseded: base.superseded ?? 0,
    remaining: base.remaining,
    counted: base.counted ?? base.total,
    percentDone: base.percentDone ?? (base.total ? Math.round((100 * base.done) / base.total) : 0),
    ...(typeof needYou === 'number' && Number.isFinite(needYou) ? { needsYou: needYou } : {}),
    source,
  };
}

function snapshotTotals(cards) {
  let tickets = 0;
  let done = 0;
  let ready = 0;
  let review = 0;
  let blocked = 0;
  let todo = 0;
  let cancelled = 0;
  let needsYou = 0;
  let any = false;
  for (const card of cards) {
    const c = card.ticketCounts;
    if (!c || num(c.total) === null) continue;
    any = true;
    tickets += c.total;
    done += c.done ?? 0;
    ready += c.ready ?? 0;
    review += c.review ?? 0;
    blocked += c.blocked ?? 0;
    todo += c.todo ?? 0;
    cancelled += c.cancelled ?? 0;
    if (typeof c.needsYou === 'number' && Number.isFinite(c.needsYou)) needsYou += c.needsYou;
  }
  if (!any) return null;
  return {
    tickets,
    done,
    ready,
    review,
    blocked,
    todo,
    cancelled,
    percentDone: tickets ? Math.round((100 * done) / tickets) : 0,
    needsYou,
  };
}

function buildProjectCard(p, index) {
  const prefix = `projects[${index}]`;
  const card = {
    id: p.id,
    name: p.name ?? null,
    lane: projectLane(p),
  };
  if (p.directBuild) {
    card.directBuild = true;
    const live = field('Live agents', p.agents?.total, 'count', `${prefix}.agents.total`, 'Running agent jobs in live runs for this project.');
    if (live) card.liveAgents = live;
    if (typeof p.machine === 'string' && p.machine.length) {
      card.machine = textField('Machine', p.machine, `${prefix}.machine`, 'Host name where this project root lives.');
    }
    const out = p.agents?.jobs?.running;
    if (typeof out === 'number' && Number.isFinite(out)) {
      card.out = textField('Out', String(out), `${prefix}.agents.jobs.running`, 'Agent jobs currently running for this project.');
    }
    return card;
  }
  const live = field('Live agents', p.agents?.total, 'count', `${prefix}.agents.total`, 'Running agent jobs in live runs for this project.');
  if (live) card.liveAgents = live;
  const need = field('Needs you', p.card?.blocked?.needYou, 'count', `${prefix}.card.blocked.needYou`, 'Inbox items waiting for the owner on this project.');
  if (need) card.needsYou = need;
  const ticketCountShape = mergeCardTicketCounts(p, index);
  if (ticketCountShape) {
    const pct = ticketCountShape.percentDone;
    card.percentDone = textField('Done', `${Math.round(pct)}%`, `${ticketCountShape.source}.percentDone`, 'Percent of live ledger tickets marked done.');
    card.meter = { label: 'done', value: Math.round(pct), source: `${ticketCountShape.source}.percentDone` };
  } else {
    const overall = p.progress?.overall;
    if (typeof overall === 'number' && Number.isFinite(overall)) {
      card.percentDone = textField('Done', `${Math.round(overall)}%`, `${prefix}.progress.overall`, 'Overall build progress percent from the project ledger.');
      card.meter = { label: 'done', value: Math.round(overall), source: `${prefix}.progress.overall` };
    }
  }
  const building = p.card?.now?.buildingTickets;
  if (typeof building === 'number' && Number.isFinite(building)) {
    card.ticketsBuilding = textField('Building', String(building), `${prefix}.card.now.buildingTickets`, 'Tickets currently marked running across the project family.');
  }
  if (typeof p.machine === 'string' && p.machine.length) {
    card.machine = textField('Machine', p.machine, `${prefix}.machine`, 'Host name where this project root lives.');
  }
  const asks = p.card?.next?.ready;
  if (typeof asks === 'number' && Number.isFinite(asks)) {
    card.asks = textField('Asks', String(asks), `${prefix}.card.next.ready`, 'Tickets ready to run next on this project.');
  }
  const out = p.agents?.jobs?.running;
  if (typeof out === 'number' && Number.isFinite(out)) {
    card.out = textField('Out', String(out), `${prefix}.agents.jobs.running`, 'Agent jobs currently running for this project.');
  }
  const fails = p.tickets?.byStatus?.failed;
  if (typeof fails === 'number' && Number.isFinite(fails)) {
    card.fails = textField('Fails', String(fails), `${prefix}.tickets.byStatus.failed`, 'Ledger tickets in failed status.');
  }
  if (ticketCountShape) card.ticketCounts = ticketCountShape;
  return card;
}

const HOUR_MS = 3600000;
const DONE_AT_KEYS = ['doneAt', 'completedAt', 'closedAt', 'finishedAt', 'updatedAt'];

function doneAtMs(t) {
  for (const k of DONE_AT_KEYS) {
    const ms = typeof t?.[k] === 'string' ? Date.parse(t[k]) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

/** Last 24 hours of ticket completions, oldest bucket first. Null when no ledger row carries a completion time. */
function throughput24h(projects, nowMs) {
  const buckets = new Array(24).fill(0);
  let seen = false;
  for (const p of projects) {
    for (const t of p?.ledger?.tickets ?? []) {
      if (t?.status !== 'done') continue;
      const ms = doneAtMs(t);
      if (!Number.isFinite(ms)) continue;
      seen = true;
      const ago = Math.floor((nowMs - ms) / HOUR_MS);
      if (ago >= 0 && ago < 24) buckets[23 - ago] += 1;
    }
  }
  return seen ? buckets : null;
}

/** Jobs per lane in the last 24 hours, read from whichever lane map the board payload carries. */
function laneStats(board) {
  const src = board?.machine?.lanes ?? board?.lanes;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const out = {};
  for (const [name, v] of Object.entries(src)) {
    const jobs = num(typeof v === 'number' ? v : v?.jobs24h ?? v?.jobs);
    if (jobs === null) continue;
    out[name] = { jobs24h: jobs, running: num(v?.running) ?? 0 };
  }
  return Object.keys(out).length ? out : null;
}

const EVENT_LIMIT = 40;

/** Session log rows: review, blocked and recently finished tickets plus open PRs, newest first where a time exists. */
function hiveEvents(projects, prs, nowMs) {
  const events = [];
  for (const p of projects) {
    const name = p?.name ?? p?.id ?? '';
    for (const t of p?.ledger?.tickets ?? []) {
      if (!t?.id) continue;
      if (t.status === 'review') events.push({ kind: 'review', id: t.id, title: t.title ?? t.id, project: name });
      else if (t.status === 'blocked') events.push({ kind: 'blocked', id: t.id, title: t.title ?? t.id, project: name });
      else if (t.status === 'done') {
        const ms = doneAtMs(t);
        if (Number.isFinite(ms) && nowMs - ms < 24 * HOUR_MS) events.push({ kind: 'done', id: t.id, title: t.title ?? t.id, project: name, at: new Date(ms).toISOString() });
      }
    }
  }
  const rank = { review: 0, blocked: 1, done: 2 };
  events.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (Date.parse(b.at ?? '') || 0) - (Date.parse(a.at ?? '') || 0));
  const out = events.slice(0, EVENT_LIMIT);
  for (const r of prs) out.push({ kind: 'pr', id: `#${r.number}`, title: r.title });
  return out;
}

function openPrs(board) {
  const list = Array.isArray(board?.prs) ? board.prs : Array.isArray(board?.machine?.prs) ? board.machine.prs : [];
  return list.filter(r => r && num(r.number) !== null && typeof r.title === 'string').map(r => ({ number: r.number, title: r.title }));
}

/** Server-side extras for the Hive panels; every key is left out when the board payload cannot back it. */
function buildHiveExtras(board, projects, nowMs) {
  const hive = {};
  const hours = throughput24h(projects, nowMs);
  if (hours) hive.throughput24h = hours;
  let doneSum = 0;
  let anyDoneLast24h = false;
  for (const p of projects) {
    if (typeof p?.doneLast24h === 'number' && Number.isFinite(p.doneLast24h)) {
      doneSum += p.doneLast24h;
      anyDoneLast24h = true;
    }
  }
  if (anyDoneLast24h) hive.doneLast24h = doneSum;
  else if (hours) hive.doneLast24h = hours.reduce((a, v) => a + v, 0);
  const lanes = laneStats(board);
  if (lanes) hive.lanes = lanes;
  const prs = openPrs(board);
  hive.prs = prs;
  const events = hiveEvents(projects, prs, nowMs);
  if (events.length) hive.events = events;
  return hive;
}

/**
 * @param {object} board Payload from GET /api/board (snapshot plus server metadata).
 * @param {{ now?: number }} [options]
 */
export function buildCommandCenterSnapshot(board, options = {}) {
  const projects = Array.isArray(board?.projects) ? board.projects.filter(p => p && !p.parentId) : [];
  const at = typeof board?.at === 'string' ? board.at : new Date(options.now ?? Date.now()).toISOString();
  const stats = {};
  const pt = field('Projects', projects.length, 'count', 'projects.length', 'Registered top-level projects on this board.');
  if (pt) stats.projectsTotal = pt;
  const agents = field('Agents live', board?.machine?.agents?.total, 'count', 'machine.agents.total', 'Running agent jobs across all projects.');
  if (agents) stats.agentsLive = agents;
  const needTotal = needsYouTotal(board?.projects ?? []);
  const ny = field('Needs you', needTotal, 'count', 'projects[].card.blocked.needYou', 'Owner inbox items summed across projects.');
  if (ny) stats.needsYouCount = ny;
  const cards = [];
  for (let i = 0; i < (board?.projects ?? []).length; i += 1) {
    const p = board.projects[i];
    if (!p || p.parentId) continue;
    cards.push(buildProjectCard(p, i));
  }
  const totals = snapshotTotals(cards);
  const nowMs = Number.isFinite(Date.parse(at)) ? Date.parse(at) : (options.now ?? Date.now());
  return { at, stats, projects: cards, totals, hive: buildHiveExtras(board, projects, nowMs) };
}

/** Update only changed cards; aggregates are cheap reductions over the cached rows. */
export function patchCommandCenterSnapshot(snapshot, board, ids) {
  const changed = new Set(ids);
  const projects = board.projects ?? [];
  for (let i = 0; i < projects.length; i += 1) {
    const p = projects[i];
    if (!changed.has(p.id) || p.parentId) continue;
    const index = snapshot.projects.findIndex(card => card.id === p.id);
    const card = buildProjectCard(p, i);
    if (index >= 0) snapshot.projects[index] = card;
    else snapshot.projects.push(card);
  }
  snapshot.at = board.at;
  if (snapshot.stats.agentsLive) snapshot.stats.agentsLive.value = board.machine?.agents?.total ?? 0;
  const needs = needsYouTotal(projects);
  if (needs !== null) snapshot.stats.needsYouCount = field('Needs you', needs, 'count', 'projects[].card.blocked.needYou', 'Owner inbox items summed across projects.');
  snapshot.totals = snapshotTotals(snapshot.projects);
  snapshot.hive = buildHiveExtras(board, projects.filter(p => !p.parentId), Date.parse(board.at));
  return snapshot;
}

function ledgerFromProject(project) {
  if (project?.ledger && Array.isArray(project.ledger.tickets)) return project.ledger;
  const tickets = [];
  for (const item of project?.card?.next?.items ?? []) {
    if (item?.id) tickets.push({ id: item.id, title: item.title ?? item.id, status: 'ready' });
  }
  for (const item of project?.card?.blocked?.items ?? []) {
    if (item?.id) tickets.push({ id: item.id, title: item.title ?? item.id, status: 'blocked' });
  }
  if (project?.tickets?.byStatus) {
    for (const [status, count] of Object.entries(project.tickets.byStatus)) {
      if (!count || status === 'proposed') continue;
      const present = tickets.filter(ticket => ticket.status === status).length;
      for (let i = present; i < count; i += 1) tickets.push({ id: `${status}-${i}`, title: status, status });
    }
  }
  const scope = project?.progress?.scope ?? project?.progress?.stages ? { stages: project.progress.stages } : undefined;
  return { tickets, ...(scope ? { scope } : {}) };
}

function cockpitCounts(project) {
  const cardShape = mergeCardTicketCounts(project, 0);
  if (cardShape) {
    return {
      total: cardShape.total,
      done: cardShape.done,
      ready: cardShape.ready,
      blocked: cardShape.blocked,
      review: cardShape.review,
      todo: cardShape.todo ?? 0,
      cancelled: cardShape.cancelled,
      proposed: cardShape.proposed ?? 0,
      superseded: cardShape.superseded ?? 0,
      remaining: cardShape.remaining,
      counted: cardShape.counted,
      percentDone: cardShape.percentDone,
      needsYou: cardShape.needsYou ?? (typeof project?.card?.blocked?.needYou === 'number' ? project.card.blocked.needYou : 0),
      source: cardShape.source,
    };
  }
  const ledger = ledgerFromProject(project);
  const fromLedger = ticketCountsFromLedgerRows(ledger.tickets);
  if (fromLedger) {
    return {
      ...fromLedger,
      needsYou: typeof project?.card?.blocked?.needYou === 'number' ? project.card.blocked.needYou : 0,
      source: 'ledger.tickets',
    };
  }
  return {
    ...ticketCountsOf(null),
    needsYou: typeof project?.card?.blocked?.needYou === 'number' ? project.card.blocked.needYou : 0,
    source: 'empty',
  };
}

function runStreamItems(project) {
  if (Array.isArray(project?.runStream)) return project.runStream;
  const live = Array.isArray(project?.live) ? project.live : [];
  return live.slice(0, 20).map(r => ({
    id: String(r.runId ?? r.id ?? ''),
    title: String(r.status ?? 'run'),
    body: `${r.done ?? 0}/${r.jobs ?? 0} jobs`,
  })).filter(item => item.id);
}

/**
 * @param {object} board GET /api/board payload
 * @param {string} projectId
 * @returns {object|null}
 */
export function buildProjectCockpit(board, projectId) {
  const id = String(projectId ?? '');
  const project = (board?.projects ?? []).find(p => p && p.id === id);
  if (!project) return null;
  const ledger = ledgerFromProject(project);
  const counts = cockpitCounts(project);
  const nextItems = project?.card?.next?.items;
  const readyIds = Array.isArray(nextItems)
    ? nextItems.map(item => item?.id).filter(id => id != null && String(id) !== '').map(String)
    : null;
  return {
    id: project.id,
    name: project.name ?? null,
    directBuild: Boolean(project.directBuild),
    ledger,
    sessions: project.orchestrator?.sessions ?? [],
    meta: {
      project: project.name ?? project.id,
      lane: project.stage ?? project.tickets?.stage ?? null,
      owner: project.machine ?? null,
    },
    progress: project.progress ?? null,
    stageRings: project.progress ?? null,
    runStream: runStreamItems(project),
    counts,
    readyIds,
    done: counts.done,
    total: counts.total,
    percentDone: counts.percentDone,
  };
}

export { ticketCountsOf, mergeCardTicketCounts, snapshotTotals };
