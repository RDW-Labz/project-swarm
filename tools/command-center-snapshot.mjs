// SPDX-License-Identifier: Apache-2.0
// Board /api/board payload → Command Center snapshot and per-project cockpit data.

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

function buildProjectCard(p, index) {
  const prefix = `projects[${index}]`;
  const card = {
    id: p.id,
    name: p.name ?? null,
    lane: projectLane(p),
  };
  const live = field('Live agents', p.agents?.total, 'count', `${prefix}.agents.total`, 'Running agent jobs in live runs for this project.');
  if (live) card.liveAgents = live;
  const need = field('Needs you', p.card?.blocked?.needYou, 'count', `${prefix}.card.blocked.needYou`, 'Inbox items waiting for the owner on this project.');
  if (need) card.needsYou = need;
  const overall = p.progress?.overall;
  if (typeof overall === 'number' && Number.isFinite(overall)) {
    card.percentDone = textField('Done', `${Math.round(overall)}%`, `${prefix}.progress.overall`, 'Overall build progress percent from the project ledger.');
    card.meter = { label: 'done', value: Math.round(overall), source: `${prefix}.progress.overall` };
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
  const counts = ticketCounts(p);
  if (counts) card.ticketCounts = { ...counts, source: `${prefix}.tickets.byStatus` };
  return card;
}

const HOUR_MS = 3600000;
const DONE_AT_KEYS = ['doneAt', 'completedAt', 'closedAt', 'finishedAt', 'updatedAt'];

/** Ticket counts by status for the Hive card and panels: the board's byStatus map, else the ledger rows. Null when neither exists. */
function ticketCounts(p) {
  let by = p?.tickets?.byStatus;
  if (!by || typeof by !== 'object' || !Object.keys(by).length) {
    const rows = Array.isArray(p?.ledger?.tickets) ? p.ledger.tickets : [];
    if (!rows.length) return null;
    by = {};
    for (const t of rows) if (t?.status) by[t.status] = (by[t.status] ?? 0) + 1;
  }
  const get = (k) => (num(by[k]) ?? 0);
  const total = Object.entries(by).reduce((a, [k, v]) => a + (k === 'proposed' ? 0 : (num(v) ?? 0)), 0);
  const cancelled = get('cancelled');
  const done = get('done');
  return { total, done, ready: get('ready'), blocked: get('blocked'), review: get('review'), cancelled, remaining: Math.max(0, total - done - cancelled) };
}

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
  if (hours) {
    hive.throughput24h = hours;
    hive.doneLast24h = hours.reduce((a, v) => a + v, 0);
  }
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
  const nowMs = Number.isFinite(Date.parse(at)) ? Date.parse(at) : (options.now ?? Date.now());
  return { at, stats, projects: cards, hive: buildHiveExtras(board, projects, nowMs) };
}

/** Update only changed cards; aggregates are cheap reductions over the cached rows. */
export function patchCommandCenterSnapshot(snapshot, board, ids) {
  const changed = new Set(ids);
  const projects = board.projects ?? [];
  for (let i = 0; i < projects.length; i++) {
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
      // Ready/blocked card rows are only a partial ledger. Fill the remaining
      // statuses too, so a newly completed ticket appears in the cockpit.
      const present = tickets.filter(ticket => ticket.status === status).length;
      for (let i = present; i < count; i += 1) tickets.push({ id: `${status}-${i}`, title: status, status });
    }
  }
  const scope = project?.progress?.scope ?? project?.progress?.stages ? { stages: project.progress.stages } : undefined;
  return { tickets, ...(scope ? { scope } : {}) };
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
  const live = (ledger.tickets ?? []).filter(t => !['cancelled', 'proposed'].includes(t.status));
  const done = live.filter(t => t.status === 'done').length;
  const total = live.length;
  return {
    id: project.id,
    name: project.name ?? null,
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
    done,
    total,
  };
}
