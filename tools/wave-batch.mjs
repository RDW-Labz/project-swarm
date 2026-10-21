// SPDX-License-Identifier: Apache-2.0

function ticketFiles(ticket) {
  if (!ticket || typeof ticket !== 'object') return [];
  if (Array.isArray(ticket.files)) return ticket.files.map(String).filter(Boolean);
  if (typeof ticket.file === 'string' && ticket.file) return [ticket.file];
  return [];
}

function dependsMet(ticket, doneIds) {
  const deps = Array.isArray(ticket.dependsOn) ? ticket.dependsOn : (Array.isArray(ticket.dependencies) ? ticket.dependencies : []);
  if (!deps.length) return true;
  return deps.every(id => doneIds.has(String(id)));
}

function needsReviewFirst(ticket) {
  if (!ticket || typeof ticket !== 'object') return false;
  if (ticket.status === 'review') return true;
  if (ticket.sensitive === true && ticket.status !== 'done') return true;
  if (ticket.sensitiveNeedsReview === true) return true;
  return false;
}

function sharesOutput(a, b) {
  const left = new Set(ticketFiles(a).map(f => f.toLowerCase()));
  const right = new Set(ticketFiles(b).map(f => f.toLowerCase()));
  for (const file of left) if (right.has(file)) return true;
  return false;
}

function conflicts(batch, candidate) {
  return batch.some(item => sharesOutput(item, candidate));
}

/**
 * Pick ready tickets that can share one scope wave without output collisions.
 *
 * @param {object[]} readyTickets Tickets with status ready (already filtered by caller).
 * @param {{ slots: number, ownedFiles?: Set<string>, doneTicketIds?: Set<string>, heldIds?: Set<string> }} options
 * @returns {object[]}
 */
export function planWaveBatch(readyTickets, { slots, ownedFiles = new Set(), doneTicketIds = new Set(), heldIds = new Set() } = {}) {
  const limit = Number.isInteger(slots) && slots > 0 ? slots : 0;
  if (!limit) return [];
  const list = Array.isArray(readyTickets) ? readyTickets : [];
  const held = heldIds instanceof Set ? heldIds : new Set(Array.isArray(heldIds) ? heldIds : []);
  const done = doneTicketIds instanceof Set ? doneTicketIds : new Set(Array.isArray(doneTicketIds) ? doneTicketIds : []);
  const owned = ownedFiles instanceof Set ? ownedFiles : new Set(Array.isArray(ownedFiles) ? ownedFiles : []);
  const batch = [];
  for (const ticket of list) {
    if (!ticket || typeof ticket.id !== 'string') continue;
    if (held.has(ticket.id)) continue;
    if (ticket.held === true) continue;
    if (needsReviewFirst(ticket)) continue;
    if (!dependsMet(ticket, done)) continue;
    const files = ticketFiles(ticket);
    if (files.some(file => owned.has(String(file).toLowerCase()))) continue;
    if (conflicts(batch, ticket)) continue;
    batch.push(ticket);
    if (batch.length >= limit) break;
  }
  return batch;
}
