// SPDX-License-Identifier: Apache-2.0
import { readyTickets } from './tickets.mjs';

const EXCLUDED_FROM_TOTAL = new Set(['cancelled', 'proposed', 'superseded']);

const empty = () => ({
  total: 0,
  done: 0,
  ready: 0,
  review: 0,
  blocked: 0,
  todo: 0,
  cancelled: 0,
  proposed: 0,
  superseded: 0,
  remaining: 0,
  percentDone: 0,
  counted: 0,
});

/** Canonical ticket headline counts for one ledger (live set, dependency-aware ready). */
export function ticketCountsOf(ledger) {
  if (!ledger || !Array.isArray(ledger.tickets) || !ledger.tickets.length) return empty();
  const tickets = ledger.tickets.filter(t => t && typeof t === 'object');
  const byStatus = Object.create(null);
  for (const t of tickets) {
    const s = t.status;
    if (typeof s === 'string') byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const live = tickets.filter(t => !EXCLUDED_FROM_TOTAL.has(t.status));
  const total = live.length;
  const done = live.filter(t => t.status === 'done').length;
  const ready = readyTickets(tickets).length;
  const review = live.filter(t => t.status === 'review').length;
  const blocked = live.filter(t => t.status === 'blocked').length;
  const todo = live.filter(t => t.status === 'todo').length;
  const cancelled = byStatus.cancelled ?? 0;
  const proposed = byStatus.proposed ?? 0;
  const superseded = byStatus.superseded ?? 0;
  const remaining = total - done;
  const percentDone = total ? Math.round((100 * done) / total) : 0;
  return {
    total,
    done,
    ready,
    review,
    blocked,
    todo,
    cancelled,
    proposed,
    superseded,
    remaining,
    percentDone,
    counted: total,
  };
}
