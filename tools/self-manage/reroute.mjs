// SPDX-License-Identifier: Apache-2.0
// Lane rerouting for T-0455 (R-083). Pure functions: no I/O, no scheduler state.
// A down lane gets no new jobs; its share moves to the cheapest healthy lane in cost order.
// A degraded lane stays routable at a lower weight.

import { isStale } from './lane-monitor.mjs';

export const LANE_HEALTH = Object.freeze(['up', 'degraded', 'down']);
export const DEGRADED_WEIGHT = 0.5;

/**
 * Map lane-monitor and legacy health strings to normalized lane health.
 * Routable: up (includes healthy). Degraded is routable at DEGRADED_WEIGHT.
 * Not routable: down, paused, and anything unknown.
 *
 * @param {unknown} state
 * @returns {'up' | 'degraded' | 'down'}
 */
export function normalizeLaneHealth(state) {
  if (state === 'up' || state === 'healthy') return 'up';
  if (state === 'degraded') return 'degraded';
  if (state === 'down' || state === 'paused') return 'down';
  return 'down';
}

function emptyLaneMap(costOrder) {
  const map = Object.create(null);
  for (const agent of costOrder) {
    map[agent] = 0;
  }
  return map;
}

function assertCostOrder(costOrder) {
  if (!Array.isArray(costOrder) || costOrder.length === 0) {
    throw Object.assign(new Error('reroute-invalid: costOrder must be a non-empty array'), { code: 'reroute-invalid' });
  }
  const seen = Object.create(null);
  for (const agent of costOrder) {
    if (Object.hasOwn(seen, agent)) {
      throw Object.assign(new Error('reroute-invalid: costOrder must not contain duplicate lane names'), { code: 'reroute-invalid' });
    }
    seen[agent] = true;
  }
}

function healthFromOptions(opts) {
  if (!Object.hasOwn(opts, 'health')) return {};
  const health = opts.health;
  if (health === null || health === undefined) {
    throw Object.assign(new Error('reroute-invalid: health must be an object'), { code: 'reroute-invalid' });
  }
  return health;
}

function validateBaseShares(baseShares, costOrder) {
  const allowed = new Set(costOrder);
  for (const key of Reflect.ownKeys(baseShares)) {
    if (!Object.hasOwn(baseShares, key)) continue;
    if (!allowed.has(key)) {
      throw Object.assign(new Error(`reroute-invalid: baseShares key ${String(key)} is not in costOrder`), { code: 'reroute-invalid' });
    }
    const val = baseShares[key];
    if (!Number.isFinite(val) || val < 0) {
      throw Object.assign(new Error('reroute-invalid: baseShares values must be finite numbers >= 0'), { code: 'reroute-invalid' });
    }
  }
}

function laneState(health, agent, now, intervalMs) {
  if (!Object.hasOwn(health, agent)) return 'down';
  const entry = health[agent];
  if (entry !== null && typeof entry === 'object') {
    if (isStale(entry, now, intervalMs)) return 'down';
    return normalizeLaneHealth(entry.status);
  }
  return normalizeLaneHealth(entry);
}

function isRoutable(state) {
  return state === 'up' || state === 'degraded';
}

function weightForState(state) {
  return state === 'degraded' ? DEGRADED_WEIGHT : 1;
}

function cheapestRoutableLane(costOrder, health, now, intervalMs) {
  return costOrder.find(agent => isRoutable(laneState(health, agent, now, intervalMs)));
}

function baseShareFor(baseShares, agent) {
  if (Object.hasOwn(baseShares, agent)) return baseShares[agent];
  return 1;
}

function routableAgents(costOrder, health, now, intervalMs) {
  return costOrder.filter(agent => isRoutable(laneState(health, agent, now, intervalMs)));
}

// costOrder: lane names cheapest first. health: monitor or legacy vocabulary (missing entry means down).
// baseShares: optional { agent: non-negative finite number } (missing means 1).
// Returns { agent: effective share } for every lane in costOrder.
export function effectiveShares(opts = {}) {
  const { costOrder, baseShares = {}, now, intervalMs } = opts;
  const health = healthFromOptions(opts);
  assertCostOrder(costOrder);
  validateBaseShares(baseShares, costOrder);
  const shares = emptyLaneMap(costOrder);
  const routable = routableAgents(costOrder, health, now, intervalMs);
  if (routable.length === 0) return shares;

  const target = cheapestRoutableLane(costOrder, health, now, intervalMs);
  for (const agent of costOrder) {
    const base = baseShareFor(baseShares, agent);
    const state = laneState(health, agent, now, intervalMs);
    if (!isRoutable(state)) {
      if (target && base > 0) {
        const targetState = laneState(health, target, now, intervalMs);
        shares[target] += base * weightForState(targetState);
      }
    } else {
      shares[agent] += base * weightForState(state);
    }
  }
  return shares;
}

// Splits `count` jobs over the effective shares by largest remainder.
// Ties on the fractional part go to the cheaper lane (earlier in costOrder). Down lanes get 0 jobs.
export function allocateJobs(opts = {}) {
  const { count, costOrder, baseShares = {}, now, intervalMs } = opts;
  const health = healthFromOptions(opts);
  if (!Number.isInteger(count) || count < 0) {
    throw Object.assign(new Error('reroute-invalid: count must be a non-negative integer'), { code: 'reroute-invalid' });
  }
  assertCostOrder(costOrder);
  validateBaseShares(baseShares, costOrder);

  const allocations = emptyLaneMap(costOrder);
  const routable = routableAgents(costOrder, health, now, intervalMs);
  if (routable.length === 0) {
    return { allocations, allDown: true };
  }

  const shares = effectiveShares({ costOrder, health, baseShares, now, intervalMs });
  const total = costOrder.reduce((sum, agent) => sum + shares[agent], 0);
  if (total <= 0) {
    return { allocations, allDown: false, noCapacity: true };
  }
  if (count === 0) {
    return { allocations, allDown: false };
  }

  const rows = costOrder.map((agent, index) => {
    const exact = (shares[agent] / total) * count;
    return { agent, index, whole: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  for (const row of rows) allocations[row.agent] = row.whole;
  let left = count - rows.reduce((sum, row) => sum + row.whole, 0);
  const byRemainder = [...rows]
    .filter(row => shares[row.agent] > 0)
    .sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));
  for (let i = 0; left > 0 && byRemainder.length > 0; i += 1, left -= 1) {
    allocations[byRemainder[i % byRemainder.length].agent] += 1;
  }
  return { allocations, allDown: false };
}
