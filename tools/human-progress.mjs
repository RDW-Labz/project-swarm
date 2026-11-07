// SPDX-License-Identifier: Apache-2.0
// R-015: human tickets are an owner checklist, not build progress or wave-planning blockers.

export const isHumanTicket = (t) => t?.type === 'human';

export const isLiveTicket = (t) => t && t.status !== 'cancelled' && t.status !== 'proposed';

/** Live tickets that count toward automated build progress. */
export function buildProgressTickets(tickets) {
  return (Array.isArray(tickets) ? tickets : []).filter((t) => isLiveTicket(t) && !isHumanTicket(t));
}

/**
 * Build progress { total, done, percentDone } — human tickets excluded.
 * @param {unknown} tickets
 * @param {{ now?: number }} [opts]
 */
export function buildProgressStats(tickets, { now = Date.now() } = {}) {
  void now;
  const live = buildProgressTickets(tickets);
  const total = live.length;
  const done = live.filter((t) => t.status === 'done').length;
  const percentDone = total ? Math.round((100 * done) / total) : 0;
  return { total, done, percentDone };
}

/** Like scope-loop ledgerSummary, but only non-human tickets count toward build totals. */
export function ledgerBuildSummary(ledger) {
  const tickets = ledger?.tickets ?? [];
  const live = tickets.filter(isLiveTicket);
  const build = live.filter((t) => !isHumanTicket(t));
  const count = (list, status) => list.filter((t) => t.status === status).length;
  return {
    total: build.length,
    done: count(build, 'done'),
    ready: count(build, 'ready') + count(build, 'todo'),
    running: count(build, 'running'),
    review: count(build, 'review'),
    blocked: count(build, 'blocked'),
    humans: live.filter((t) => isHumanTicket(t) && t.status !== 'done').length,
    proposed: tickets.filter((t) => t.status === 'proposed').length,
  };
}

/**
 * Tickets for wave simulation: human tickets omitted and human dependencies ignored
 * (they do not block wave planning).
 */
export function wavePlanningTickets(tickets) {
  const live = (Array.isArray(tickets) ? tickets : []).filter(isLiveTicket);
  const humanIds = new Set(live.filter(isHumanTicket).map((t) => t.id));
  return live
    .filter((t) => !isHumanTicket(t))
    .map((t) => ({
      ...t,
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).filter((d) => !humanIds.has(d)),
    }));
}

const depsOf = (t) => (Array.isArray(t?.dependsOn) ? t.dependsOn : []);

/**
 * Non-human tickets that block wave planning (dependency chains ignore human tickets).
 */
export function waveBlockingTicketIds(tickets) {
  const live = (Array.isArray(tickets) ? tickets : []).filter(isLiveTicket);
  const byId = new Map(live.map((t) => [t.id, t]));
  const humanIds = new Set(live.filter(isHumanTicket).map((t) => t.id));
  const buildLive = live.filter((t) => !isHumanTicket(t));

  const reachesBlocked = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    for (const d of depsOf(byId.get(id))) {
      if (humanIds.has(d)) continue;
      const dep = byId.get(d);
      if (!dep || isHumanTicket(dep)) continue;
      if (dep.status === 'blocked' || reachesBlocked(d, seen)) return true;
    }
    return false;
  };

  return buildLive
    .filter((t) => t.status === 'blocked' || (t.status !== 'done' && reachesBlocked(t.id)))
    .map((t) => t.id)
    .sort();
}

export function waveBlockingCount(tickets) {
  return waveBlockingTicketIds(tickets).length;
}

/**
 * Owner-facing human ticket checklists (steps), separate from build progress.
 * @param {unknown} tickets
 * @param {{ now?: number }} [opts]
 */
export function ownerHumanChecklists(tickets, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  return (Array.isArray(tickets) ? tickets : [])
    .filter((t) => isLiveTicket(t) && isHumanTicket(t))
    .map((t) => ({
      id: t.id,
      title: typeof t.title === 'string' ? t.title : '',
      status: t.status,
      done: t.status === 'done' || t.status === 'cancelled',
      steps: (Array.isArray(t.steps) ? t.steps : []).filter((s) => typeof s === 'string'),
      updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : at,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
