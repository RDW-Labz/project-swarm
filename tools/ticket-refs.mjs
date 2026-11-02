// SPDX-License-Identifier: Apache-2.0
// A ticket's context may name another ticket ("T-0193") instead of a file. Every place that turns context into paths resolves it to that ticket's files (its tests too); an id that
// matches no ticket is dropped, never passed on as a path.
const MAX_EXPANDED = 60;
// Secret files and the project profile are never handed on through a reference.
const withheld = f => /(^|\/)\.env(\.|$)/.test(f) && !/example/i.test(f) || /(^|\/)\.project-swarm\.json$/.test(f) || /[*?]/.test(f);
const TICKET_ID = /^T-\d{1,6}$/;

export const isTicketRef = v => typeof v === 'string' && TICKET_ID.test(v.trim());

export function expandTicketRefs(paths, tickets) {
  const byId = new Map((Array.isArray(tickets) ? tickets : []).map(t => [t.id, t]));
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!isTicketRef(p)) { out.push(p); continue; }
    const t = byId.get(p.trim());
    if (!t) continue;
    for (const f of [...(t.files ?? []), ...(t.tests ?? [])]) if (typeof f === 'string' && f && !f.endsWith('/') && !withheld(f) && out.length < MAX_EXPANDED) out.push(f);
  }
  return [...new Set(out)];
}
