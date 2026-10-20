// SPDX-License-Identifier: Apache-2.0
// Size and cost estimates that come from this project's own history: how many tickets a requirement turns into, and what a ticket costs (estimated full cost: billed plus the
// list value of subscription lanes). `swarm change` used to say "11 requirements, about 11 tickets, $0.03": a requirement is not a ticket and $0.003 is not a price.
import { jobSpend } from './spend.mjs';

const MIN_STAGE_TICKETS = 5;      // a stage this small says little about the ratio
const MIN_LANE_JOBS = 5;          // a lane needs this many finished ticket jobs before its price counts
const MIN_COVERAGE = 0.7;         // the share of a stage's tickets whose cost is on record; less and its cost per ticket would be too low
export const DEFAULT_TICKETS_PER_REQUIREMENT = 4;

const quantile = (sorted, q) => { const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); };
// low / mid / high: the middle half (25th to 75th percentile) of the stages, the lowest and highest with two, one point with one.
function spread(values) {
  const v = values.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length < 3) return { low: v[0], mid: v.reduce((s, x) => s + x, 0) / v.length, high: v.at(-1), n: v.length };
  return { low: quantile(v, 0.25), mid: quantile(v, 0.5), high: quantile(v, 0.75), n: v.length };
}

/** Per finished stage: its tickets, its requirements, and what its tickets cost, from the ledger and the run files (a job is a ticket when it has the ticket's id). */
export function stageHistory({ tickets = [], runs = [] }) {
  const live = tickets.filter(t => t && typeof t.id === 'string' && !['cancelled', 'proposed'].includes(t.status) && t.type !== 'human');
  // Only finished tickets count, for their number and for their cost: work in progress has cost something but is not yet a ticket's price.
  const stageOf = new Map(live.filter(t => t.status === 'done').map(t => [t.id, t.stage]));
  const stages = new Map();
  const slot = s => { if (!stages.has(s)) stages.set(s, { stage: s, tickets: 0, refs: new Set(), costed: new Set(), usd: 0 }); return stages.get(s); };
  for (const t of live) { if (t.status !== 'done') continue; const b = slot(t.stage); b.tickets += 1; for (const r of t.scopeRefs ?? []) b.refs.add(r); }
  for (const { state } of runs) {
    for (const job of state?.jobs ?? []) {
      const s = stageOf.get(job?.id);
      if (s === undefined) continue;
      const usd = jobSpend(job).usd;
      if (typeof usd !== 'number' || !(usd > 0)) continue;   // a job with no cost on record is a gap, not a free job
      const b = slot(s);
      b.usd += usd;
      b.costed.add(job.id);
    }
  }
  return [...stages.values()].map(b => ({ stage: b.stage, tickets: b.tickets, requirements: b.refs.size, costedTickets: Math.min(b.costed.size, b.tickets), usd: b.usd })).filter(b => b.tickets >= MIN_STAGE_TICKETS && b.requirements > 0);
}

const RECENT = 4;   // the pace of the latest stages counts, not the cheap early ones
const stageNo = s => { const m = /^S(\d+)$/.exec(String(s)); return m ? Number(m[1]) : 0; };

/** What one job costs on each lane (median, from jobs that are tickets), and how many jobs a ticket takes: a ticket's cost depends on the lane it runs on. */
export function laneRates({ tickets = [], runs = [] }) {
  const ids = new Set(tickets.filter(t => t && t.status === 'done' && t.type !== 'human').map(t => t.id));
  const byLane = new Map();
  const seen = new Set();
  let jobs = 0;
  for (const { state } of runs) for (const job of state?.jobs ?? []) {
    const usd = jobSpend(job).usd;
    if (!ids.has(job?.id) || job.status !== 'complete' || typeof usd !== 'number' || !(usd > 0)) continue;
    jobs += 1; seen.add(job.id);
    const list = byLane.get(job.agent) ?? [];
    list.push(usd);
    byLane.set(job.agent, list);
  }
  const jobsPerTicket = seen.size ? Math.max(1, jobs / seen.size) : 1;
  const lanes = [...byLane.entries()].filter(([, v]) => v.length >= MIN_LANE_JOBS).map(([lane, v]) => { const s = [...v].sort((a, b) => a - b); return { lane, jobs: v.length, usdPerJob: quantile(s, 0.5), usdPerTicket: quantile(s, 0.5) * jobsPerTicket }; }).sort((a, b) => a.usdPerTicket - b.usdPerTicket);
  return { lanes, jobsPerTicket };
}

export function historyRates(stages) {
  const recent = stages.slice().sort((a, b) => stageNo(a.stage) - stageNo(b.stage)).slice(-RECENT);
  const ratio = spread(recent.map(s => s.tickets / s.requirements));
  const enough = recent.filter(s => s.usd > 0 && s.costedTickets / s.tickets >= MIN_COVERAGE);
  const perTicket = spread(enough.map(s => s.usd / s.costedTickets));
  // The latest stage with its cost on record sets the pace: how the swarm is working now (its lanes, its ticket size), not the average of cheaper early stages.
  const latest = enough.at(-1);
  return { stages: recent.length, ticketsPerRequirement: ratio, usdPerTicket: perTicket, latestUsdPerTicket: latest ? { stage: latest.stage, usd: latest.usd / latest.costedTickets } : null, costStages: enough.length };
}

/** What `requirements` new requirements will take: tickets and dollars as a range, with what the numbers rest on. Dollars are null with no cost history (never an invented price). */
export function estimateWork({ requirements, stages = [], lanes = null }) {
  const r = historyRates(stages);
  const ratio = r.ticketsPerRequirement ?? { low: DEFAULT_TICKETS_PER_REQUIREMENT, mid: DEFAULT_TICKETS_PER_REQUIREMENT, high: DEFAULT_TICKETS_PER_REQUIREMENT, n: 0 };
  const tickets = { low: Math.round(requirements * ratio.low), mid: Math.round(requirements * ratio.mid), high: Math.round(requirements * ratio.high) };
  // The range of cost: the cheapest lane to the dearest lane seen (a ticket costs what its lane costs), with the recent stages' own pace as the middle.
  const cheap = lanes?.lanes?.[0]?.usdPerTicket, dear = lanes?.lanes?.at(-1)?.usdPerTicket;
  const pace = r.latestUsdPerTicket?.usd ?? null;
  const perTicket = pace === null && cheap === undefined ? null : { low: Math.min(...[cheap, pace].filter(x => x !== undefined && x !== null)), mid: pace ?? (cheap + dear) / 2, high: Math.max(...[dear, pace].filter(x => x !== undefined && x !== null)) };
  const usd = perTicket ? { low: tickets.low * perTicket.low, mid: tickets.mid * perTicket.mid, high: tickets.high * perTicket.high } : null;
  const byLane = (lanes?.lanes ?? []).map(l => ({ lane: l.lane, usdPerTicket: l.usdPerTicket, usd: tickets.mid * l.usdPerTicket }));
  const basis = r.ticketsPerRequirement
    ? `${r.stages} finished stage${r.stages === 1 ? '' : 's'} of this project (${ratio.low.toFixed(1)} to ${ratio.high.toFixed(1)} tickets per requirement${perTicket ? `, $${perTicket.low.toFixed(3)} to $${perTicket.high.toFixed(3)} per ticket${r.latestUsdPerTicket ? `, ${r.latestUsdPerTicket.stage} ran at $${r.latestUsdPerTicket.usd.toFixed(3)}` : ''}${byLane.length ? ` (${byLane.map(l => `${l.lane} $${l.usdPerTicket.toFixed(3)}`).join(', ')})` : ''}` : ', no cost history'})`
    : `no finished stage to learn from: ${DEFAULT_TICKETS_PER_REQUIREMENT} tickets per requirement assumed, no cost`;
  return { requirements, tickets, usd, byLane, basis, learned: Boolean(r.ticketsPerRequirement) };
}
