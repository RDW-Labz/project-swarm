// SPDX-License-Identifier: Apache-2.0
import { ledgerStats } from './tickets.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';

const txt = (v, max = 200) => (v === undefined || v === null ? null : sanitizeWorkerText(v, max));
const strs = v => (Array.isArray(v) ? v.filter(x => x !== undefined && x !== null).map(x => sanitizeWorkerText(x, 200)) : []);
const pick = v => (typeof v === 'number' ? v : typeof v === 'string' ? txt(v) : null);
const isDone = t => t.status === 'done';
const isLive = t => t.status !== 'cancelled';
const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const addedCount = v => (Array.isArray(v) ? v.length : Number(v) || 0);

const group = (list, key) => {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
};

function card(t) {
  return { id: txt(t.id), title: txt(t.title), type: txt(t.type), status: txt(t.status), risk: txt(t.risk), sensitive: t.sensitive ?? null, lane: txt(t.lane) };
}

export function buildPlanSnapshot(ledger, { now = Date.now() } = {}) {
  void now;
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  if (!ledger || tickets.length === 0) return { schema: 1, present: false };

  const stats = ledgerStats(ledger);
  const live = tickets.filter(isLive);
  const byIdMap = new Map(tickets.map(t => [t.id, t]));

  const header = {
    scopeName: txt(ledger.scope?.name),
    scopeVersion: pick(ledger.scope?.version),
    percentDone: stats.percentDone,
    coveragePct: stats.coveragePct,
    total: stats.total,
    byStatus: stats.byStatus,
    spendUsd: tickets.reduce((s, t) => s + (Number(t.costUsd) || 0), 0),
    estimateUsd: typeof ledger.estimate?.usd === 'number' ? ledger.estimate.usd : null,
    changeOrderCount: Array.isArray(ledger.changeOrders) ? ledger.changeOrders.length : 0,
  };

  const stages = [...group(tickets, t => txt(t.stage) ?? 'none')].map(([id, list]) => {
    const liveCount = list.filter(isLive).length;
    const done = list.filter(isDone).length;
    const epics = [...group(list, t => txt(t.epic) ?? 'general')].map(([eid, eList]) => ({
      id: eid,
      total: eList.length,
      done: eList.filter(isDone).length,
      cards: eList.map(card),
    }));
    return { id, total: list.length, done, percent: liveCount ? Math.round(100 * done / liveCount) : 0, epics };
  });

  const declared = Array.isArray(ledger.requirements)
    ? ledger.requirements.map(r => (typeof r === 'string' ? { id: r, title: null } : { id: String(r?.id ?? ''), title: txt(r?.title) }))
    : null;
  const source = declared ?? [...new Set(tickets.flatMap(t => strs(t.scopeRefs)))].map(id => ({ id, title: null }));
  const reqMap = new Map();
  for (const r of source) if (!reqMap.has(r.id)) reqMap.set(r.id, r);
  const requirements = [...reqMap.values()].sort((a, b) => cmpId(a.id, b.id)).map(r => {
    const refs = live.filter(t => strs(t.scopeRefs).includes(r.id));
    const state = refs.length === 0 ? 'missing' : refs.every(isDone) ? 'done' : 'partial';
    return { id: r.id, title: r.title, tickets: refs.map(t => t.id), state };
  });

  const liveIds = new Set(live.map(t => t.id));
  const nodes = live.map(t => ({ id: t.id, status: t.status }));
  const edges = live.flatMap(t => strs(t.dependsOn).filter(d => liveIds.has(d)).map(d => ({ from: t.id, to: d })));
  const reaches = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    for (const d of strs(byIdMap.get(id)?.dependsOn)) {
      if (byIdMap.get(d)?.status === 'blocked' || reaches(d, seen)) return true;
    }
    return false;
  };
  const blocked = live
    .filter(t => t.status === 'blocked' || (t.status !== 'done' && reaches(t.id)))
    .map(t => t.id)
    .sort(cmpId);

  const changeOrders = (Array.isArray(ledger.changeOrders) ? ledger.changeOrders : [])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => cmpId(String(a.c?.at ?? ''), String(b.c?.at ?? '')) || a.i - b.i)
    .map(({ c }) => ({
      id: txt(c?.id),
      at: c?.at ?? null,
      by: txt(c?.by),
      reason: txt(c?.reason),
      cancelled: Boolean(c?.cancelled),
      reopened: Boolean(c?.reopened),
      added: addedCount(c?.diff?.added),
    }));

  const ticketObj = Object.fromEntries(tickets.map(t => [t.id, {
    id: t.id,
    title: txt(t.title),
    type: txt(t.type),
    status: txt(t.status),
    stage: txt(t.stage),
    epic: txt(t.epic),
    risk: txt(t.risk),
    sensitive: t.sensitive ?? null,
    lane: txt(t.lane),
    scopeRefs: strs(t.scopeRefs),
    acceptance: strs(t.acceptance),
    files: strs(t.files),
    dependsOn: strs(t.dependsOn),
    costUsd: typeof t.costUsd === 'number' ? t.costUsd : null,
    pr: pick(t.pr),
    review: pick(t.review),
    drift: strs(t.drift),
  }]));

  return {
    schema: 1,
    present: true,
    header,
    stages,
    requirements,
    dependencies: { nodes, edges, blocked },
    changeOrders,
    tickets: ticketObj,
  };
}
