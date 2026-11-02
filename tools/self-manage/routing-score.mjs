// SPDX-License-Identifier: Apache-2.0
// T-0466 (S11): read-only lane scoring for routing audit logs (not wired into routeJob yet).

/** Penalty per routing-failure unit (same 0–2 scale as routingFailures in lane-pass-routing.mjs). */
const FAILURE_SCORE_PENALTY = 0.25;

/**
 * Scoring formula (auditability over sophistication):
 *   score(lane) = passRate(lane) - FAILURE_SCORE_PENALTY * failureCount(lane)
 * where passRate comes from lanePassRates() ({ rate } per agent) and failureCount from
 * routingFailures / merged failures passed by the caller.
 * Lanes with no measured pass-rate entry score 0 on the rate term.
 *
 * Winner: highest score. Equal scores: lower costOrder index wins (cheaper lane first),
 * then lane name ascending for full determinism.
 */

/**
 * @param {string} lane
 * @param {Record<string, { rate?: number }>} passRates
 * @param {Record<string, number>} failures
 */
export function laneRoutingScore(lane, passRates, failures = {}) {
  const summary = passRates?.[lane];
  const rate = Number(summary?.rate);
  const passRate = Number.isFinite(rate) ? rate : 0;
  const failureUnits = Number(failures?.[lane]);
  const penalty = Number.isFinite(failureUnits) && failureUnits > 0
    ? failureUnits * FAILURE_SCORE_PENALTY
    : 0;
  return passRate - penalty;
}

/**
 * @param {string} lane
 * @param {readonly string[]} costOrder
 */
function costOrderRank(lane, costOrder) {
  if (!Array.isArray(costOrder)) return Number.MAX_SAFE_INTEGER;
  const idx = costOrder.indexOf(lane);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

/**
 * @param {string} score
 */
function formatScore(score) {
  return Number(score).toFixed(3);
}

/**
 * @param {{ winner: { lane: string, score: number } | null, decisionReason: string, scoresByLane: Record<string, number> }}
 */
function formatRoutingScoreLogLine({ winner, decisionReason, scoresByLane }) {
  const parts = [
    'routing-score',
    `winner=${winner?.lane ?? 'none'}`,
    `reason=${decisionReason}`,
  ];
  for (const lane of Object.keys(scoresByLane).sort()) {
    parts.push(`${lane}=${formatScore(scoresByLane[lane])}`);
  }
  return parts.join(' ');
}

/**
 * @param {readonly string[]} lanes Candidate lane agent ids (same names as lanePassRates keys).
 * @param {{ passRates?: Record<string, { rate?: number, total?: number }>, costOrder?: readonly string[], failures?: Record<string, number> }} options
 */
export function scoreLanesForRouting(lanes, options = {}) {
  const passRates = options.passRates ?? {};
  const costOrder = options.costOrder ?? [];
  const failures = options.failures ?? {};
  const laneList = Array.isArray(lanes) ? lanes.slice() : [];

  const scored = laneList.map(lane => ({
    lane,
    score: laneRoutingScore(lane, passRates, failures),
    costRank: costOrderRank(lane, costOrder),
  }));

  const scoresByLane = Object.fromEntries(scored.map(entry => [entry.lane, entry.score]));

  const ranked = scored.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.costRank !== b.costRank) return a.costRank - b.costRank;
    return a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0;
  });

  const top = ranked[0] ?? null;
  let decisionReason = 'score';
  if (top && ranked.length > 1 && ranked[1].score === top.score) {
    decisionReason = 'tie-break-cost';
  }

  const winner = top ? { lane: top.lane, score: top.score, costRank: top.costRank } : null;

  return {
    winner: winner?.lane ?? null,
    decisionReason,
    scores: scoresByLane,
    candidates: ranked,
    line: formatRoutingScoreLogLine({ winner, decisionReason, scoresByLane }),
  };
}
