// SPDX-License-Identifier: Apache-2.0
const USD_PER_TICKET = 0.003;
const uniq = (a) => [...new Set(a)];
const norm = (r) => JSON.stringify({ t: r?.text ?? '', a: r?.acceptance ?? [] });

export function diffScopes(oldScope, newScope) {
  const oldReqs = new Map((oldScope?.requirements ?? []).map((r) => [r.id, r]));
  const newReqs = new Map((newScope?.requirements ?? []).map((r) => [r.id, r]));
  const added = [...newReqs.keys()].filter((id) => !oldReqs.has(id));
  const removed = [...oldReqs.keys()].filter((id) => !newReqs.has(id));
  const changed = [...newReqs.keys()].filter((id) => oldReqs.has(id) && norm(oldReqs.get(id)) !== norm(newReqs.get(id)));
  const oldStages = new Set((oldScope?.stages ?? []).map((s) => s.id));
  const newStages = new Set((newScope?.stages ?? []).map((s) => s.id));
  const stagesAdded = [...newStages].filter((s) => !oldStages.has(s));
  const stagesRemoved = [...oldStages].filter((s) => !newStages.has(s));
  return { added, removed, changed, stagesAdded, stagesRemoved };
}

export function impactAnalysis({ diff, tickets = [] } = {}) {
  const removed = new Set(diff?.removed ?? []);
  const changed = new Set(diff?.changed ?? []);
  const live = tickets.filter((t) => t.status !== 'cancelled');
  const refs = (t) => t.scopeRefs ?? [];
  const cancel = [];
  const reopen = [];
  const retag = [];
  for (const t of live) {
    const r = refs(t);
    const hitRemoved = r.filter((x) => removed.has(x));
    if (hitRemoved.length && hitRemoved.length === r.length) cancel.push(t.id);
    else if (hitRemoved.length) retag.push({ ticket: t.id, remove: hitRemoved });
    if ((t.status === 'done' || t.status === 'review') && r.some((x) => changed.has(x))) reopen.push(t.id);
  }
  const covered = new Set(live.flatMap(refs));
  const needTickets = uniq([...(diff?.added ?? []), ...(diff?.changed ?? []).filter((id) => !covered.has(id))]);
  const affected = uniq([...cancel, ...reopen, ...retag.map((x) => x.ticket)]);
  return { cancel, reopen, retag, needTickets, affected, estimate: { newTickets: needTickets.length, usd: needTickets.length * USD_PER_TICKET } };
}

export function nextChangeOrderId(ledger) {
  const nums = (ledger?.changeOrders ?? []).map((c) => Number(String(c.id).replace(/^CO-/, '')) || 0);
  const n = Math.max(0, ...nums) + 1;
  return `CO-${String(n).padStart(3, '0')}`;
}

export function applyChangeOrder(ledger, { impact, diff, reason, by, now, scope } = {}) {
  if (!ledger || !impact) throw new Error('applyChangeOrder needs a ledger and an impact');
  const at = now ?? new Date().toISOString();
  const cancelSet = new Set(impact.cancel ?? []);
  const reopenSet = new Set(impact.reopen ?? []);
  const retagMap = new Map((impact.retag ?? []).map((x) => [x.ticket, new Set(x.remove ?? [])]));
  const tickets = (ledger.tickets ?? []).map((t) => {
    if (cancelSet.has(t.id)) return { ...t, status: 'cancelled' };
    let next = t;
    if (retagMap.has(t.id)) {
      const rm = retagMap.get(t.id);
      next = { ...next, scopeRefs: (next.scopeRefs ?? []).filter((r) => !rm.has(r)) };
    }
    if (reopenSet.has(t.id)) next = { ...next, status: 'todo' };
    return next;
  });
  const diffCounts = {
    added: diff?.added?.length ?? 0,
    removed: diff?.removed?.length ?? 0,
    changed: diff?.changed?.length ?? 0,
    stagesAdded: diff?.stagesAdded?.length ?? 0,
    stagesRemoved: diff?.stagesRemoved?.length ?? 0,
  };
  const impactCounts = {
    cancel: impact.cancel?.length ?? 0,
    reopen: impact.reopen?.length ?? 0,
    retag: impact.retag?.length ?? 0,
    needTickets: impact.needTickets?.length ?? 0,
    affected: impact.affected?.length ?? 0,
    estimate: impact.estimate ?? null,
  };
  const entry = {
    id: nextChangeOrderId(ledger),
    at,
    by: by ?? null,
    reason: reason ?? '',
    diff: diffCounts,
    impact: impactCounts,
    cancelled: [...cancelSet],
    reopened: [...reopenSet],
  };
  return {
    ...ledger,
    scope: scope ? { name: scope.name, version: scope.version, hash: scope.hash } : ledger.scope,
    tickets,
    changeOrders: [...(ledger.changeOrders ?? []), entry],
    updatedAt: at,
  };
}
