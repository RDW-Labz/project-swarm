// SPDX-License-Identifier: Apache-2.0
// Automatic re-split or lane reroute for blocked or repeatedly failed tickets (R-013, T-0051).
import { readFile } from 'node:fs/promises';
import { appendLog, logPath, writeLedger } from './tickets.mjs';

/**
 * @typedef {object} TicketLike
 * @property {string} id
 * @property {string} [status]
 * @property {string[]} [dependsOn]
 * @property {string} [lane]
 * @property {string} [blockReason]
 * @property {string} [blockNote]
 * @property {string} [ownerNote]
 * @property {number} [attempts]
 * @property {string} [replanNote]
 */

/**
 * @typedef {object} ReplanLogEntry
 * @property {string} ticketId
 * @property {'split-ticket'|'reroute-lane'} action
 * @property {string} reason
 */

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** @param {TicketLike} ticket */
function isDependencyBlocked(ticket, tickets) {
  const r = ticket?.blockReason;
  if (r === 'deps' || r === 'dependency') return true;
  if (!Array.isArray(tickets) || !Array.isArray(ticket?.dependsOn) || !ticket.dependsOn.length) return false;
  const byId = new Map(tickets.filter(Boolean).map((candidate) => [candidate.id, candidate]));
  return ticket.dependsOn.some((dependency) => byId.get(dependency)?.status !== 'done');
}

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
 * @param {string} ticketId
 * @param {Map<string, Set<string>>} dependentsOf
 */
function transitiveDependentIds(ticketId, dependentsOf) {
  const down = new Set(dependentsOf.get(ticketId) ?? []);
  for (const id of down) for (const d of dependentsOf.get(id) ?? []) down.add(d);
  return down;
}

/**
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
 * @param {TicketLike} ticket
 * @param {number} [gatesCount]
 */
export function ticketQualifiesForReplan(ticket, gatesCount = 0, options = {}) {
  if (!ticket || typeof ticket.id !== 'string') return false;
  if (options.onlyIds && !options.onlyIds.has(ticket.id)) return false;
  if (options.priorReplannedIds?.has(ticket.id)) return false;
  // Human-owned work, review gates, and sensitive work needing review stay with
  // the owner/reviewer. Automatic replanning is only for worker-owned open work.
  if (ticket.type === 'human' || ticket.sensitive === true || ['review', 'done', 'cancelled', 'proposed', 'running', 'todo'].includes(ticket.status)) return false;
  if (ticket.blockNote || ticket.ownerNote || ticket.blockReason === 'manual') return false;
  if (isDependencyBlocked(ticket, options.tickets)) return false;
  const attempts = Number(ticket.attempts) || 0;
  if (attempts >= 2) return true;
  return ticket.status === 'blocked';
}

/**
 * @param {TicketLike} ticket
 * @param {number} [gatesCount]
 * @returns {{ action: 'split-ticket'|'reroute-lane', reason: string }|null}
 */
export function replanPlanForTicket(ticket, gatesCount = 0, options = {}) {
  if (!ticketQualifiesForReplan(ticket, gatesCount, options)) return null;
  const attempts = Number(ticket.attempts) || 0;
  if (attempts >= 2) {
    if (options.requireChange && (!Array.isArray(ticket.files) || ticket.files.length < 2)) {
      if (typeof ticket.lane !== 'string' || !ticket.lane.trim()) return null;
      return {
        action: 'reroute-lane',
        reason: `blocked after ${attempts} failed attempts; reroute to a different lane`,
      };
    }
    return {
      action: 'split-ticket',
      reason: `blocked after ${attempts} failed attempts; re-split without a new scope manifest`,
    };
  }
  const lane = typeof ticket.lane === 'string' ? ticket.lane.trim() : '';
  const br = String(ticket.blockReason ?? '');
  if (lane && (ticket.blockReason === 'failure' || br.startsWith('unroutable'))) {
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
  if (ticket.status === 'blocked') {
    return {
      action: 'reroute-lane',
      reason: 'ticket blocked; reroute without orchestrator manifest',
    };
  }
  return null;
}

/**
 * @param {TicketLike} ticket
 * @param {number} [gatesCount]
 * @returns {{ ticket: TicketLike, log: ReplanLogEntry }|null}
 */
export function applyReplanToTicket(ticket, gatesCount = 0, options = {}) {
  const plan = replanPlanForTicket(ticket, gatesCount, options);
  if (!plan) return null;
  /** @type {TicketLike} */
  const next = { ...ticket };
  next.status = 'ready';
  delete next.blockReason;
  if (plan.action === 'reroute-lane') {
    if (options.requireChange) {
      const currentAgent = String(ticket.lane).split(':', 1)[0];
      const alternate = ['claude', 'codex', 'cursor'].find((agent) => agent !== currentAgent);
      if (!alternate) return null;
      next.lane = alternate;
    } else {
      delete next.lane;
    }
  } else {
    if (options.requireChange) {
      const files = Array.isArray(next.files) ? next.files : [];
      const splitAt = Math.ceil(files.length / 2);
      if (splitAt >= files.length) return null;
      next.files = files.slice(0, splitAt);
      next.replanDeferredFiles = files.slice(splitAt);
    }
    next.replanNote = plan.reason.slice(0, 600);
  }
  return {
    ticket: next,
    log: { ticketId: ticket.id, action: plan.action, reason: plan.reason },
  };
}

/**
 * In-memory replans for every qualifying ticket (no scope manifest).
 *
 * @param {TicketLike[]} tickets
 * @returns {{ tickets: TicketLike[], replans: ReplanLogEntry[] }}
 */
export function replanTickets(tickets, options = {}) {
  const list = Array.isArray(tickets) ? tickets.map((t) => ({ ...t })) : [];
  const candidates = list
    .map((ticket, index) => ({
      index,
      ticket,
      gatesCount: gatesCountForTicket(list, ticket.id),
    }))
    .filter(({ ticket, gatesCount }) => ticketQualifiesForReplan(ticket, gatesCount, { ...options, tickets: list }));

  candidates.sort((a, b) => b.gatesCount - a.gatesCount || byId(a.ticket, b.ticket));

  /** @type {ReplanLogEntry[]} */
  const replans = [];
  for (const { index, ticket, gatesCount } of candidates) {
    const applied = applyReplanToTicket(ticket, gatesCount, options);
    if (!applied) continue;
    list[index] = applied.ticket;
    replans.push(applied.log);
  }
  return { tickets: list, replans };
}

/**
 * @param {object} ledger
 * @returns {{ ledger: object, replans: ReplanLogEntry[] }}
 */
export function replanLedger(ledger, options = {}) {
  const copy = structuredClone(ledger ?? { tickets: [] });
  const { tickets, replans } = replanTickets(copy.tickets ?? [], options);
  copy.tickets = tickets;
  return { ledger: copy, replans };
}

/**
 * Persist replans to the ticket ledger and append one log line per change (with reason).
 *
 * @param {string} root
 * @param {object} ledger
 * @param {{ now?: number, by?: string }} [options]
 */
export async function persistReplans(root, ledger, options = {}) {
  const { now = Date.now(), by = 'sync', ...replanOptions } = options;
  let priorReplannedIds = replanOptions.priorReplannedIds;
  if (!priorReplannedIds) {
    priorReplannedIds = new Set();
    try {
      const log = await readFile(logPath(root), 'utf8');
      for (const line of log.split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry?.event === 'replan' && typeof entry.id === 'string') priorReplannedIds.add(entry.id);
        } catch {
          if (line.trim()) console.error('[tools/ticket-replan.mjs] corrupt replan journal line (SyntaxError)');
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const { ledger: next, replans } = replanLedger(ledger, { ...replanOptions, priorReplannedIds });
  if (!replans.length) return { ledger: next, replans, changed: false };
  next.updatedAt = new Date(now).toISOString();
  await writeLedger(root, next);
  for (const entry of replans) {
    await appendLog(root, {
      event: 'replan',
      by,
      id: entry.ticketId,
      action: entry.action,
      reason: entry.reason,
      plan: { action: entry.action, reason: entry.reason },
    });
  }
  return { ledger: next, replans, changed: true };
}
