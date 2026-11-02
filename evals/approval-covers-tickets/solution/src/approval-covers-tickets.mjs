import { createHash } from 'node:crypto';

const FIELDS = ['acceptance', 'dependsOn', 'files', 'id', 'title'];

function reduceTicket(ticket) {
  const out = {};
  for (const key of FIELDS) out[key] = ticket[key];
  return out;
}

function ticketsHash(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  const sorted = [...list]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(reduceTicket);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

export function approve(ledger, now) {
  const base = ledger || {};
  return {
    ...base,
    approved: { at: now, scopeHash: base.scopeHash, ticketsHash: ticketsHash(base.tickets) },
  };
}

export function isApproved(ledger) {
  if (!ledger || !ledger.approved) return false;
  return (
    ledger.approved.scopeHash === ledger.scopeHash &&
    ledger.approved.ticketsHash === ticketsHash(ledger.tickets)
  );
}
