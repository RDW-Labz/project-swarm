// SPDX-License-Identifier: Apache-2.0
// Lane rerouting for T-0455 (R-083). Pure functions: no I/O, no scheduler state.
// A down lane gets no new jobs; its share moves to the next healthy lane in cost order
// (wrapping to the cheapest healthy lane when none follows it). A degraded lane stays routable at a lower weight.

export const LANE_HEALTH = Object.freeze(['up', 'degraded', 'down']);
export const DEGRADED_WEIGHT = 0.5;

function healthOf(health, agent) {
  const state = health?.[agent] ?? 'up';
  if (!LANE_HEALTH.includes(state)) {
    throw Object.assign(new Error(`reroute-invalid: ${agent} health must be one of ${LANE_HEALTH.join(', ')}`), { code: 'reroute-invalid' });
  }
  return state;
}

// costOrder: lane names cheapest first. health: { agent: 'up' | 'degraded' | 'down' } (missing means 'up').
// baseShares: optional { agent: positive number } (missing means 1).
// Returns { agent: effective share } for every lane in costOrder.
export function effectiveShares({ costOrder, health = {}, baseShares = {} } = {}) {
  if (!Array.isArray(costOrder) || costOrder.length === 0) {
    throw Object.assign(new Error('reroute-invalid: costOrder must be a non-empty array'), { code: 'reroute-invalid' });
  }
  const shares = Object.fromEntries(costOrder.map(agent => [agent, 0]));
  const healthy = costOrder.filter(agent => healthOf(health, agent) !== 'down');
  if (healthy.length === 0) return shares;
  for (const agent of costOrder) {
    const base = baseShares[agent] ?? 1;
    const state = healthOf(health, agent);
    if (state === 'down') {
      // Down lane: its share goes to the next healthy lane after it in cost order, else the cheapest healthy lane.
      const index = costOrder.indexOf(agent);
      const target = costOrder.slice(index + 1).find(other => healthOf(health, other) !== 'down') ?? healthy[0];
      shares[target] += base;
    } else {
      shares[agent] += base * (state === 'degraded' ? DEGRADED_WEIGHT : 1);
    }
  }
  return shares;
}

// Splits `count` jobs over the effective shares by largest remainder.
// Ties on the fractional part go to the cheaper lane (earlier in costOrder). Down lanes get 0 jobs.
export function allocateJobs({ count, costOrder, health = {}, baseShares = {} } = {}) {
  if (!Number.isInteger(count) || count < 0) {
    throw Object.assign(new Error('reroute-invalid: count must be a non-negative integer'), { code: 'reroute-invalid' });
  }
  const shares = effectiveShares({ costOrder, health, baseShares });
  const total = costOrder.reduce((sum, agent) => sum + shares[agent], 0);
  const result = Object.fromEntries(costOrder.map(agent => [agent, 0]));
  if (total <= 0 || count === 0) return result;
  const rows = costOrder.map((agent, index) => {
    const exact = (shares[agent] / total) * count;
    return { agent, index, whole: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  for (const row of rows) result[row.agent] = row.whole;
  let left = count - rows.reduce((sum, row) => sum + row.whole, 0);
  const byRemainder = [...rows].filter(row => shares[row.agent] > 0).sort((a, b) => (b.fraction - a.fraction) || (a.index - b.index));
  for (let i = 0; left > 0 && byRemainder.length > 0; i += 1, left -= 1) {
    result[byRemainder[i % byRemainder.length].agent] += 1;
  }
  return result;
}
