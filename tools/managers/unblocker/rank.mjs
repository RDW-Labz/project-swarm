// SPDX-License-Identifier: Apache-2.0
// Rank blocked tickets for the Unblocker (T-0202): higher gatesCount first.

/**
 * @typedef {object} TicketLike
 * @property {string} id
 * @property {string} [status]
 * @property {string[]} [dependsOn]
 */

/**
 * @typedef {object} RankedBlockedTicket
 * @property {TicketLike} ticket
 * @property {number} gatesCount
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
  for (const id of [...down]) {
    for (const d of dependentsOf.get(id) ?? []) down.add(d);
  }
  return down;
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
  const ranked = blocked.map((ticket) => ({
    ticket,
    gatesCount: transitiveDependentIds(ticket.id, dependentsOf).size,
  }));

  ranked.sort((a, b) => {
    if (b.gatesCount !== a.gatesCount) return b.gatesCount - a.gatesCount;
    return byId(a.ticket, b.ticket);
  });

  return ranked;
}
