// SPDX-License-Identifier: Apache-2.0
import { wavesOf } from './tickets.mjs';

/** R-012: critical path longer than this fraction of tickets, or lower average fill, triggers re-split or ask. */
export const SPLIT_WAVE_LIMITS = {
  maxCriticalPathTicketFraction: 0.25,
  minAverageFillFraction: 0.5,
};

const activeTickets = (tickets) =>
  (tickets ?? []).filter((t) => t && t.status !== 'cancelled' && t.status !== 'proposed');

function longestTicketChain(active) {
  const ids = new Set(active.map((t) => t.id));
  const byId = new Map(active.map((t) => [t.id, t]));
  const memo = new Map();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => ids.has(d));
    const len = deps.length ? 1 + Math.max(...deps.map(depth)) : 1;
    memo.set(id, len);
    return len;
  };
  if (!active.length) return 0;
  return Math.max(...active.map((t) => depth(t.id)));
}

const waveFill = (waveSize, slots) => Math.min(waveSize, slots) / slots;

/**
 * Simulate dependency waves for ingest at the current parallel slot count.
 * @param {object[]} tickets
 * @param {number} slots parallel worker slots
 */
export function simulateSplitWaves(tickets, slots) {
  if (!Number.isInteger(slots) || slots < 1) {
    throw Object.assign(new Error('slots must be a positive integer'), { code: 'bad-slots' });
  }
  const active = activeTickets(tickets);
  const ticketCount = active.length;
  const waveIds = wavesOf(active);
  const fills = waveIds.map((w) => waveFill(w.length, slots));
  const averageFill = fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : 1;
  const criticalPathLength = longestTicketChain(active);
  const criticalPathTicketRatio = ticketCount ? criticalPathLength / ticketCount : 0;
  return {
    slots,
    ticketCount,
    waveCount: waveIds.length,
    waves: waveIds.map((ids, i) => ({ index: i, ticketIds: ids, tickets: ids.length, fill: fills[i] })),
    averageFill,
    criticalPathLength,
    criticalPathTicketRatio,
  };
}

/** Whether simulated waves are healthy enough to ingest without re-splitting or asking the owner. */
export function assessSplitWaveSimulation(sim) {
  const reasons = [];
  const { maxCriticalPathTicketFraction, minAverageFillFraction } = SPLIT_WAVE_LIMITS;
  if (sim.criticalPathTicketRatio > maxCriticalPathTicketFraction) {
    reasons.push({
      code: 'critical-path-long',
      message: `critical path is ${sim.criticalPathLength} tickets (${Math.round(sim.criticalPathTicketRatio * 100)}% of ${sim.ticketCount}), over ${maxCriticalPathTicketFraction * 100}%`,
    });
  }
  if (sim.averageFill < minAverageFillFraction) {
    reasons.push({
      code: 'low-wave-fill',
      message: `average wave fill is ${sim.averageFill.toFixed(3)}, under ${minAverageFillFraction * 100}% of slots`,
    });
  }
  return {
    ok: reasons.length === 0,
    reasons,
    action: reasons.length ? 'resplit-or-ask' : 'proceed',
  };
}

/** Simulate waves and apply R-012 thresholds (for use immediately before ingest). */
export function simulateBeforeIngest(tickets, slots) {
  const simulation = simulateSplitWaves(tickets, slots);
  const assessment = assessSplitWaveSimulation(simulation);
  return { ...simulation, ...assessment };
}
