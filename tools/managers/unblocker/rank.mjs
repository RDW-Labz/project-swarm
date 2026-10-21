// SPDX-License-Identifier: Apache-2.0
// Rank blocked tickets for the Unblocker (T-0202): higher gatesCount first; plan safe replans (R-013).

/**
 * @typedef {object} TicketLike
 * @property {string} id
 * @property {string} [status]
 * @property {string[]} [dependsOn]
 * @property {string} [lane]
 * @property {string} [blockReason]
 * @property {number} [attempts]
 * @property {string} [replanNote]
 */

/**
 * @typedef {object} RankedBlockedTicket
 * @property {TicketLike} ticket
 * @property {number} gatesCount
 * @property {'split-ticket'|'reroute-lane'} [replanAction]
 * @property {string} [replanReason]
 */

/**
 * @typedef {object} ReplanLogEntry
 * @property {string} ticketId
 * @property {'split-ticket'|'reroute-lane'} action
 * @property {string} reason
 */

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** @param {TicketLike[]} tickets */
const activeOf = (tickets) =>
  tickets.filter((t) => t && t.status !== 'cancelled' && t.status !== 'proposed');

/**
 * @param {TicketLike[]} active
 * @param {Set<string>} ids
 */
function buildDependentsOf(active, ids) {
  /** @type {Map<string, Set<string>>} */
  const dependentsOf = new Map();
  for (const o of active) {
    for (const d of Array.isArray(o.dependsOn) ? o.dependsOn : []) {
      if (!ids.has(d)) continue;
      if (!dependentsOf.has(d)) dependentsOf.set(d, new Set());
      dependentsOf.get(d).add(o.id);
    }
  }
  return dependentsOf;
}

/**
 * Transitive dependents of `ticketId` (same closure as scope-integrity gating-ticket).
 *
 * @param {string} ticketId
 * @param {Map<string, Set<string>>} dependentsOf
 */
function transitiveDependentIds(ticketId, dependentsOf) {
  const down = new Set(dependentsOf.get(ticketId) ?? []);
  for (const id of down) for (const d of dependentsOf.get(id) ?? []) down.add(d);
  return down;
}

/** @param {TicketLike} ticket */
function isDependencyBlocked(ticket) {
  const r = ticket.blockReason;
  return r === 'deps' || r === 'dependency';
}

/**
 * @param {TicketLike} ticket
 * @param {number} gatesCount
 */
export function blockedTicketQualifiesForReplan(ticket, gatesCount) {
  if (ticket?.status !== 'blocked') return false;
  if (isDependencyBlocked(ticket)) return false;
  const attempts = Number(ticket.attempts) || 0;
  if (attempts >= 2) return true;
  return gatesCount > 0;
}

/**
 * @param {TicketLike} ticket
 * @param {number} gatesCount
 * @returns {{ action: 'split-ticket'|'reroute-lane', reason: string }|null}
 */
export function replanActionForBlockedTicket(ticket, gatesCount) {
  if (!blockedTicketQualifiesForReplan(ticket, gatesCount)) return null;
  const attempts = Number(ticket.attempts) || 0;
  if (attempts >= 2) {
    return {
      action: 'split-ticket',
      reason: `blocked after ${attempts} failed attempts; re-split without a new scope manifest`,
    };
  }
  const lane = typeof ticket.lane === 'string' ? ticket.lane.trim() : '';
  if (lane && (ticket.blockReason === 'failure' || String(ticket.blockReason ?? '').startsWith('unroutable'))) {
    return {
      action: 'reroute-lane',
      reason: 'blocked on lane; reroute without orchestrator manifest',
    };
  }
  if (gatesCount > 0) {
    return {
      action: 'split-ticket',
      reason: `blocked while gating ${gatesCount} other ticket(s); re-split shared work`,
    };
  }
  return null;
}

/**
 * Apply an in-memory replan for one blocked ticket (manager safe action; no scope manifest).
 *
 * @param {TicketLike} ticket
 * @param {number} gatesCount
 * @returns {{ ticket: TicketLike, log: ReplanLogEntry }|null}
 */
export function applyBlockedReplan(ticket, gatesCount) {
  const plan = replanActionForBlockedTicket(ticket, gatesCount);
  if (!plan) return null;
  /** @type {TicketLike} */
  const next = { ...ticket };
  if (plan.action === 'reroute-lane') {
    delete next.lane;
    next.status = 'ready';
    delete next.blockReason;
  } else {
    next.status = 'ready';
    delete next.blockReason;
    next.replanNote = plan.reason.slice(0, 600);
  }
  return {
    ticket: next,
    log: { ticketId: ticket.id, action: plan.action, reason: plan.reason },
  };
}

/**
 * How many live tickets sit downstream of `ticketId` in the dependency graph.
 *
 * @param {TicketLike[]} tickets
 * @param {string} ticketId
 * @returns {number}
 */
export function gatesCountForTicket(tickets, ticketId) {
  const active = activeOf(Array.isArray(tickets) ? tickets : []);
  const ids = new Set(active.map((t) => t.id));
  if (!ids.has(ticketId)) return 0;
  const dependentsOf = buildDependentsOf(active, ids);
  return transitiveDependentIds(ticketId, dependentsOf).size;
}

/**
 * Blocked tickets ordered by how many others they gate (desc), then ticket id (asc).
 * Replans (split or reroute) are attached when the ticket blocks others or failed twice.
 *
 * @param {TicketLike[]} tickets
 * @returns {RankedBlockedTicket[]}
 */
export function rankBlockedTickets(tickets) {
  const active = activeOf(Array.isArray(tickets) ? tickets : []);
  const ids = new Set(active.map((t) => t.id));
  const dependentsOf = buildDependentsOf(active, ids);
  const blocked = active.filter((t) => t.status === 'blocked');

  /** @type {RankedBlockedTicket[]} */
  const ranked = blocked.map((ticket) => {
    const gatesCount = transitiveDependentIds(ticket.id, dependentsOf).size;
    const plan = replanActionForBlockedTicket(ticket, gatesCount);
    return {
      ticket,
      gatesCount,
      ...(plan ? { replanAction: plan.action, replanReason: plan.reason } : {}),
    };
  });

  ranked.sort((a, b) => {
    if (b.gatesCount !== a.gatesCount) return b.gatesCount - a.gatesCount;
    return byId(a.ticket, b.ticket);
  });

  return ranked;
}

/**
 * Rank blocked tickets, then apply safe replans in priority order (highest gates first).
 *
 * @param {TicketLike[]} tickets
 * @returns {{ tickets: TicketLike[], ranked: RankedBlockedTicket[], replans: ReplanLogEntry[] }}
 */
export function rankAndApplyBlockedReplans(tickets) {
  const list = Array.isArray(tickets) ? tickets.map((t) => ({ ...t })) : [];
  const ranked = rankBlockedTickets(list);
  /** @type {ReplanLogEntry[]} */
  const replans = [];
  for (const row of ranked) {
    const idx = list.findIndex((t) => t.id === row.ticket.id);
    if (idx < 0) continue;
    const applied = applyBlockedReplan(list[idx], row.gatesCount);
    if (!applied) continue;
    list[idx] = applied.ticket;
    replans.push(applied.log);
  }
  return { tickets: list, ranked, replans };
}
