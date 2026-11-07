// SPDX-License-Identifier: Apache-2.0
// Ready-pool maintenance for the Ticket Manager (R-036 AC1): at least five ready tickets per active project.

import { PROPOSAL_ORIGINS } from '../../tickets.mjs';
import { releaseReady, unlockReady } from '../../ticket-unlock.mjs';

/** Minimum ready tickets for an active project (R-036). */
export const READY_POOL_MIN = 5;

const OPEN_STATUSES = new Set(['todo', 'ready', 'running', 'review', 'blocked']);

const unapprovedProposal = (ticket) =>
  PROPOSAL_ORIGINS.includes(ticket?.origin) && ticket.approvedBy !== 'owner';

/** @param {unknown} tickets */
function ticketList(tickets) {
  return Array.isArray(tickets) ? tickets : [];
}

/**
 * A project is active while it still has non-terminal build work (not only proposed or cancelled).
 *
 * @param {unknown} tickets
 * @returns {boolean}
 */
export function isActiveProject(tickets) {
  return ticketList(tickets).some((t) => t && OPEN_STATUSES.has(t.status));
}

/**
 * Tickets in `ready` that workers may pick up (approved proposals only).
 *
 * @param {unknown} tickets
 * @returns {number}
 */
export function countReadyTickets(tickets) {
  return ticketList(tickets).filter((t) => t && t.status === 'ready' && !unapprovedProposal(t)).length;
}

/**
 * How many more ready tickets are needed to meet {@link READY_POOL_MIN} (zero when inactive).
 *
 * @param {unknown} tickets
 * @param {number} [min]
 * @returns {number}
 */
export function readyPoolShortfall(tickets, min = READY_POOL_MIN) {
  if (!isActiveProject(tickets)) return 0;
  return Math.max(0, min - countReadyTickets(tickets));
}

/**
 * Simulate unlock + release on a ledger copy; returns how many tickets would move to ready.
 *
 * @param {object|null|undefined} ledger
 * @returns {number}
 */
export function promotableToReadyCount(ledger) {
  if (!ledger || typeof ledger !== 'object') return 0;
  const before = countReadyTickets(ledger.tickets);
  let current = structuredClone(ledger);
  const unlock = unlockReady(current);
  current = unlock.ledger;
  const release = releaseReady(current);
  return countReadyTickets(release.ledger.tickets) - before;
}

/**
 * Read-only ready-pool status for one project ledger.
 *
 * @param {object|null|undefined} ledger
 * @returns {{ active: boolean, readyCount: number, min: number, shortfall: number, promotable: number }}
 */
export function assessReadyPool(ledger) {
  const tickets = ledger?.tickets;
  const active = isActiveProject(tickets);
  const readyCount = countReadyTickets(tickets);
  const min = READY_POOL_MIN;
  const shortfall = active ? Math.max(0, min - readyCount) : 0;
  const promotable = active ? promotableToReadyCount(ledger) : 0;
  return { active, readyCount, min, shortfall, promotable };
}

/**
 * Whether the ready-pool rule is satisfied (or nothing more can be done without new tickets finishing).
 *
 * @param {object|null|undefined} ledger
 * @returns {boolean}
 */
export function readyPoolSatisfied(ledger) {
  const { active, readyCount, min, shortfall, promotable } = assessReadyPool(ledger);
  if (!active) return true;
  if (shortfall === 0) return true;
  return promotable === 0 && readyCount + promotable < min;
}

/**
 * Unlock dependency-blocked tickets and release todo tickets until the pool reaches {@link READY_POOL_MIN}
 * or no more promotions are possible.
 *
 * @param {object|null|undefined} ledger
 * @returns {{
 *   ledger: object,
 *   unlocked: string[],
 *   released: string[],
 *   readyCount: number,
 *   active: boolean,
 *   ok: boolean,
 * }}
 */
export function fillReadyPool(ledger) {
  const base = ledger && typeof ledger === 'object' ? structuredClone(ledger) : { tickets: [] };
  if (!Array.isArray(base.tickets)) base.tickets = [];

  if (!isActiveProject(base.tickets)) {
    return {
      ledger: base,
      unlocked: [],
      released: [],
      readyCount: countReadyTickets(base.tickets),
      active: false,
      ok: true,
    };
  }

  /** @type {string[]} */
  const unlocked = [];
  /** @type {string[]} */
  const released = [];
  let current = base;

  for (;;) {
    const readyCount = countReadyTickets(current.tickets);
    if (readyCount >= READY_POOL_MIN) {
      return { ledger: current, unlocked, released, readyCount, active: true, ok: true };
    }

    const unlock = unlockReady(current);
    if (unlock.unlocked.length) {
      current = unlock.ledger;
      unlocked.push(...unlock.unlocked);
      continue;
    }

    const release = releaseReady(current);
    if (release.released.length) {
      current = release.ledger;
      released.push(...release.released);
      continue;
    }

    return {
      ledger: current,
      unlocked,
      released,
      readyCount,
      active: true,
      ok: readyPoolSatisfied({ tickets: current.tickets }),
    };
  }
}

/**
 * Ready-pool check for the Ticket Manager. With `apply: true`, mutates a ledger copy via {@link fillReadyPool}.
 *
 * @param {object|null|undefined} ledger
 * @param {{ apply?: boolean }} [options]
 * @returns {ReturnType<typeof assessReadyPool> & { ok: boolean, unlocked?: string[], released?: string[], ledger?: object }}
 */
export function checkReadyPool(ledger, { apply = false } = {}) {
  if (apply) {
    const filled = fillReadyPool(ledger);
    const assessment = assessReadyPool(filled.ledger);
    return {
      ...assessment,
      ok: filled.ok,
      unlocked: filled.unlocked,
      released: filled.released,
      ledger: filled.ledger,
    };
  }
  const assessment = assessReadyPool(ledger);
  const ok = readyPoolSatisfied(ledger);
  return { ...assessment, ok };
}
