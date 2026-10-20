// SPDX-License-Identifier: Apache-2.0
import { estimateWork } from './estimates.mjs';
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

// `stages` is the project's finished-stage history (see estimates.mjs): the estimate is requirements times the tickets a requirement has turned into, times what a ticket has cost.
export function impactAnalysis({ diff, tickets = [], history = {} } = {}) {
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
  // Transitive dependents of reopened tickets that are not todo and not cancelled.
  const children = new Map();
  for (const t of live) {
    for (const d of t.deps ?? []) {
      if (!children.has(d)) children.set(d, []);
      children.get(d).push(t.id);
    }
  }
  const statusOf = new Map(live.map((t) => [t.id, t.status]));
  const seen = new Set(reopen);
  const queue = [...reopen];
  const dependentsReset = [];
  while (queue.length) {
    const id = queue.shift();
    for (const c of children.get(id) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      queue.push(c);
      if (statusOf.get(c) !== 'todo') dependentsReset.push(c);
    }
  }
  const covered = new Set(live.flatMap(refs));
  const needTickets = uniq([...(diff?.added ?? []), ...(diff?.changed ?? []).filter((id) => !covered.has(id))]);
  const affected = uniq([...cancel, ...reopen, ...retag.map((x) => x.ticket)]);
  return {
    cancel,
    reopen,
    retag,
    needTickets,
    affected,
    dependentsReset,
    estimate: (() => {
      const work = estimateWork({ requirements: needTickets.length, stages: history.stages ?? [], lanes: history.lanes ?? null });
      return { requirements: needTickets.length, newTickets: work.tickets.mid, ticketsRange: work.tickets, usd: work.usd?.high ?? null, usdRange: work.usd, byLane: work.byLane, basis: work.basis, learned: work.learned, dependentsReset: dependentsReset.length };
    })(),
  };
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
  const dependentsSet = new Set(impact.dependentsReset ?? []);
  const retagMap = new Map((impact.retag ?? []).map((x) => [x.ticket, new Set(x.remove ?? [])]));
  const tickets = (ledger.tickets ?? []).map((t) => {
    if (cancelSet.has(t.id)) return { ...t, status: 'cancelled' };
    let next = t;
    if (retagMap.has(t.id)) {
      const rm = retagMap.get(t.id);
      next = { ...next, scopeRefs: (next.scopeRefs ?? []).filter((r) => !rm.has(r)) };
    }
    if (reopenSet.has(t.id) || dependentsSet.has(t.id)) next = { ...next, status: 'todo' };
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
    dependentsReset: impact.dependentsReset?.length ?? 0,
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
    dependentsReset: [...dependentsSet],
    retagged: (impact.retag ?? []).map((x) => ({ ticket: x.ticket, removed: [...(x.remove ?? [])] })),
  };
  return {
    ...ledger,
    scope: scope ? { name: scope.name, version: scope.version, hash: scope.hash } : ledger.scope,
    tickets,
    changeOrders: [...(ledger.changeOrders ?? []), entry],
    updatedAt: at,
  };
}
