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
  const spendUsd = num(p.spend?.usd ?? p.cost?.allUsd);
  const spend = field('Spend', spendUsd, 'usd', `${prefix}.spend.usd`, 'Total spend recorded for this project on the board.');
  if (spend) card.spendUsd = spend;
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
  return card;
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
  const spend = field('Spend', board?.machine?.cost?.allUsd, 'usd', 'machine.cost.allUsd', 'Total machine spend from project run history.');
  if (spend) stats.spendUsd = spend;
  const cards = [];
  for (let i = 0; i < (board?.projects ?? []).length; i += 1) {
    const p = board.projects[i];
    if (!p || p.parentId) continue;
    cards.push(buildProjectCard(p, i));
  }
  return { at, stats, projects: cards };
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
  if (!tickets.length && project?.tickets?.byStatus) {
    for (const [status, count] of Object.entries(project.tickets.byStatus)) {
      if (!count || status === 'proposed') continue;
      for (let i = 0; i < count; i += 1) tickets.push({ id: `${status}-${i}`, title: status, status });
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
