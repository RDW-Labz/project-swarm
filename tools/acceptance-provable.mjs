// SPDX-License-Identifier: Apache-2.0
// R-009: acceptance lines checkable from ticket files plus splitter auto context only.
import { acceptanceLines } from './acceptance.mjs';
import { buildTicketContext } from './ticket-context.mjs';

const norm = (p) => String(p).split('\\').join('/').replace(/^\.\//, '');
const arr = (value) => (Array.isArray(value) ? value : []);

function ticketOutputPaths(ticket) {
  const out = [];
  for (const f of [...arr(ticket?.files), ...arr(ticket?.tests)]) {
    if (typeof f === 'string' && !f.endsWith('/')) out.push(norm(f));
  }
  return out;
}

function transitiveDependents(ticketId, tickets) {
  const dependentsOf = new Map();
  for (const o of tickets) {
    for (const d of arr(o.dependsOn)) {
      if (!dependentsOf.has(d)) dependentsOf.set(d, new Set());
      dependentsOf.get(d).add(o.id);
    }
  }
  const after = new Set(dependentsOf.get(ticketId) ?? []);
  for (const id of [...after]) {
    for (const d of dependentsOf.get(id) ?? []) after.add(d);
  }
  return after;
}

function transitiveDependencies(ticketId, tickets) {
  const byId = new Map(tickets.filter(Boolean).map((t) => [t.id, t]));
  const out = new Set();
  const stack = [...arr(byId.get(ticketId)?.dependsOn)];
  while (stack.length) {
    const id = stack.pop();
    if (!byId.has(id) || out.has(id)) continue;
    out.add(id);
    for (const d of arr(byId.get(id)?.dependsOn)) stack.push(d);
  }
  return out;
}

/**
 * Paths named in an acceptance line (backticks and obvious repo paths with a slash and extension).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function pathsInAcceptanceText(text) {
  const out = new Set();
  const s = String(text ?? '');
  for (const m of s.matchAll(/`([^`\s]+)`/g)) {
    const p = norm(m[1]);
    if (p.includes('://')) continue;
    if (p.includes('/') || /\.[a-z0-9]+$/i.test(p)) out.add(p);
  }
  for (const m of s.matchAll(/\b([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._*-]+)+\.[a-z][a-z0-9]{0,9})\b/gi)) {
    out.add(norm(m[1]));
  }
  return [...out].sort();
}

/**
 * Repo paths a reviewer or worker may use to check acceptance for this ticket.
 *
 * @param {object} params
 * @returns {Set<string>}
 */
export function allowedPathsForAcceptance({
  ticket = {},
  scope = {},
  exists = () => false,
  sizes = {},
  profileContext = {},
  listFiles,
  allTickets = [],
  requirements = '',
} = {}) {
  const built = buildTicketContext({
    ticket: { ...ticket, requirements: String(requirements ?? '') },
    scope,
    exists,
    sizes,
    profileContext,
    listFiles,
    allTickets,
  });
  const allowed = new Set([
    ...built.shared.map(norm),
    ...built.context.map(norm),
    ...ticketOutputPaths(ticket),
    ...arr(ticket.context).map(norm),
    ...arr(ticket.contracts).map(norm),
  ]);
  for (const id of transitiveDependencies(ticket.id, allTickets)) {
    const t = allTickets.find((x) => x?.id === id);
    if (t) for (const p of ticketOutputPaths(t)) allowed.add(p);
  }
  return allowed;
}

/**
 * Owners of a path among active tickets (files, tests, and test-ticket test lists).
 *
 * @param {string} path
 * @param {object[]} tickets
 * @returns {string[]}
 */
export function ownersOfPath(path, tickets) {
  const p = norm(path);
  const owners = new Set();
  for (const t of tickets) {
    if (!t?.id) continue;
    for (const f of ticketOutputPaths(t)) {
      if (f === p) owners.add(t.id);
    }
  }
  return [...owners].sort();
}

/**
 * @param {object} params
 * @param {string} params.line
 * @param {object} params.ticket
 * @param {Set<string>} params.allowed
 * @param {object[]} params.allTickets
 * @returns {{ provable: boolean, code: string, reason: string }}
 */
export function provabilityOfAcceptanceLine({ line, ticket = {}, allowed, allTickets = [] }) {
  const refs = pathsInAcceptanceText(line);
  if (!refs.length) {
    return { provable: true, code: 'ok', reason: '' };
  }
  const later = transitiveDependents(ticket.id, allTickets);
  const deps = transitiveDependencies(ticket.id, allTickets);
  const own = new Set(ticketOutputPaths(ticket));

  for (const ref of refs) {
    const p = norm(ref);
    const owners = ownersOfPath(p, allTickets);
    for (const owner of owners) {
      if (later.has(owner)) {
        return {
          provable: false,
          code: 'later-ticket-file',
          reason: `line references ${p}, which ticket ${owner} (later than ${ticket.id}) will write`,
        };
      }
    }
    if (allowed.has(p) || own.has(p)) continue;
    if (owners.length === 1 && deps.has(owners[0])) continue;
    if (owners.length > 0) {
      return {
        provable: false,
        code: 'outside-context',
        reason: `line references ${p}, owned by ${owners.join(', ')}, which is not in this ticket's files or auto context`,
      };
    }
    return {
      provable: false,
      code: 'outside-context',
      reason: `line references ${p}, which is not in this ticket's files or auto context`,
    };
  }
  return { provable: true, code: 'ok', reason: '' };
}

/**
 * Keep only acceptance lines provable from ticket files, dependencies, and auto context.
 *
 * @param {object} params
 * @returns {{ acceptance: string[], dropped: Array<{ n: number, line: string, code: string, reason: string }> }}
 */
export function filterProvableAcceptance(params = {}) {
  const ticket = params.ticket ?? {};
  const acceptance = Array.isArray(params.acceptance) ? params.acceptance : arr(ticket.acceptance);
  const allowed = params.allowed ?? allowedPathsForAcceptance(params);
  const allTickets = arr(params.allTickets);
  const kept = [];
  const dropped = [];
  for (const item of acceptanceLines({ acceptance })) {
    const verdict = provabilityOfAcceptanceLine({ line: item.line, ticket, allowed, allTickets });
    if (verdict.provable) kept.push(item.line);
    else dropped.push({ n: item.n, line: item.line, code: verdict.code, reason: verdict.reason });
  }
  return { acceptance: kept, dropped };
}
