// SPDX-License-Identifier: Apache-2.0
// Automatic, in-memory recovery for the Unblocker (R-013, T-0203).
import { gatesCountForTicket, rankBlockedTickets } from './rank.mjs';

/**
 * @typedef {import('./rank.mjs').TicketLike} TicketLike
 * @typedef {import('./rank.mjs').ReplanLogEntry} ReplanLogEntry
 */

/** @param {TicketLike} ticket */
function isDependencyWait(ticket) {
  return ticket.blockReason === 'deps' || ticket.blockReason === 'dependency';
}

/**
 * Rerouting releases the old lane assignment so normal dispatch can select a
 * lane again. Keep the worker's original reason in the log before clearing it.
 * A ready ticket is already queued for dispatch, so repeated manager runs must
 * not keep reporting the same recovery or reset its failure count.
 *
 * @param {TicketLike} ticket
 * @param {number} [gatesCount]
 * @returns {{ ticket: TicketLike, log: ReplanLogEntry } | null}
 */
export function applyBlockedReplan(ticket, gatesCount = 0) {
  if (!ticket || isDependencyWait(ticket)) return null;
  const attempts = Number(ticket.attempts) || 0;
  const blocked = ticket.status === 'blocked';
  const failedTwice = ticket.status === 'failed' && attempts >= 2;
  if (!blocked && !failedTwice) return null;

  const cause = typeof ticket.blockReason === 'string' && ticket.blockReason.trim()
    ? ticket.blockReason.trim()
    : blocked ? 'ticket blocked' : 'ticket failed';
  const lane = typeof ticket.lane === 'string' ? ticket.lane.trim() : '';
  const reason = [
    cause,
    attempts >= 2 ? `after ${attempts} failed attempts` : '',
    gatesCount > 0 ? `gating ${gatesCount} other ticket(s)` : '',
    lane ? `released lane ${lane} for automatic routing` : 'returned to automatic routing',
    'without a new scope manifest',
  ].filter(Boolean).join('; ').slice(0, 2000);
  const next = { ...ticket, status: 'ready', replanNote: reason.slice(0, 600) };
  delete next.lane;
  delete next.blockReason;
  return {
    ticket: next,
    log: { ticketId: ticket.id, action: 'reroute-lane', reason },
  };
}

/**
 * Apply recoveries in descending downstream impact, then by ticket id.
 * Dependency-only blocks belong to dependency unlocking, not failure recovery.
 * Inputs are copied; callers persist the returned tickets and reason logs using
 * their normal manager transaction, without asking for a scope manifest.
 *
 * @param {TicketLike[]} tickets
 * @returns {{ tickets: TicketLike[], ranked: import('./rank.mjs').RankedBlockedTicket[], replans: ReplanLogEntry[] }}
 */
export function rankAndApplyBlockedReplans(tickets) {
  const list = Array.isArray(tickets) ? tickets.map((ticket) => ({ ...ticket })) : [];
  const candidates = list.map((ticket, index) => ({
    index,
    ticket,
    gatesCount: gatesCountForTicket(list, ticket.id),
  })).filter(({ ticket }) =>
    !isDependencyWait(ticket) && (ticket.status === 'blocked'
      || (ticket.status === 'failed' && Number(ticket.attempts) >= 2)));
  candidates.sort((a, b) => b.gatesCount - a.gatesCount
    || (a.ticket.id < b.ticket.id ? -1 : a.ticket.id > b.ticket.id ? 1 : 0));

  const ranked = rankBlockedTickets(list).map((row) => {
    const applied = applyBlockedReplan(row.ticket, row.gatesCount);
    // Replace the ranking helper's advisory split with the action actually used.
    return {
      ticket: row.ticket,
      gatesCount: row.gatesCount,
      ...(applied ? {
        replanAction: applied.log.action,
        replanReason: applied.log.reason,
      } : {}),
    };
  });
  /** @type {ReplanLogEntry[]} */
  const replans = [];
  for (const { index, ticket, gatesCount } of candidates) {
    const applied = applyBlockedReplan(ticket, gatesCount);
    if (!applied) continue;
    list[index] = applied.ticket;
    replans.push(applied.log);
  }
  return { tickets: list, ranked, replans };
}

export { rankAndApplyBlockedReplans as replanBlockedTickets };
