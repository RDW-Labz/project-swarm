// SPDX-License-Identifier: Apache-2.0
// T-0468 (S11 R-089): read-only lane daily quota/cap forecast (Claude, Anthropic, OpenRouter).

/** @typedef {import('./types.mjs').RoutingRecord} RoutingRecord */

/** Matches budget manager cap forecast warn threshold (see spend-watch.mjs). */
export const DEFAULT_LANE_WARN_RATIO = 0.85;

/** @typedef {'claude' | 'anthropic' | 'openrouter'} LaneName */

/**
 * @typedef {object} LaneQuotaInput
 * @property {LaneName} name
 * @property {number} spentUsd Billed spend so far in the quota window (USD).
 * @property {number | null | undefined} capUsd Configured daily cap; null/undefined means no cap.
 * @property {number} [burnRatePerHour] Recent average burn (USD/hour).
 * @property {{ at: string, spentUsd: number }[]} [recentSamples] Optional samples to derive burn rate.
 * @property {number} [warnRatio] Warn when projected spend reaches this fraction of cap (default 0.85).
 */

/**
 * @typedef {object} LaneQuotaForecast
 * @property {LaneName} name
 * @property {'ok' | 'warn' | 'at-cap' | 'no-cap' | 'unknown'} phase
 * @property {string | null} projectedRunOutAt ISO-8601 when burn is projected to exhaust cap, or null.
 * @property {number | null} headroomUsd Remaining USD before cap at projection time; null when no cap or unknown.
 * @property {'shift-work' | null} recommendation Advisory: route away from this lane before the cap stall.
 */

/**
 * @typedef {object} LaneQuotaForecastSummary
 * @property {LaneName[]} atRiskSoonest Lanes in warn/at-cap ordered by soonest projected run-out.
 * @property {LaneName | null} healthiestLane Ok lane with the most headroom (shift target), if any.
 * @property {RoutingRecord | null} suggestedReroute When shift is advised, a routing hint toward {@link healthiestLane}.
 */

const roundUsd = value => Math.round(value * 1e6) / 1e6;

/**
 * @param {number} nowMs
 */
function hoursUntilUtcDayEnd(nowMs) {
  const d = new Date(nowMs);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(0, (end - nowMs) / 3_600_000);
}

/**
 * @param {unknown} spentUsd
 */
function isValidSpentUsd(spentUsd) {
  return typeof spentUsd === 'number' && Number.isFinite(spentUsd);
}

/**
 * @param {unknown} capUsd
 */
function isValidCapUsd(capUsd) {
  return typeof capUsd === 'number' && Number.isFinite(capUsd) && capUsd >= 0;
}

/**
 * @param {unknown} warnRatio
 * @returns {number}
 */
function resolveWarnRatio(warnRatio) {
  if (typeof warnRatio === 'number' && Number.isFinite(warnRatio) && warnRatio >= 0 && warnRatio <= 1) {
    return warnRatio;
  }
  return DEFAULT_LANE_WARN_RATIO;
}

/**
 * @param {LaneQuotaInput} lane
 * @returns {number | null}
 */
function resolveBurnRatePerHour(lane) {
  if (typeof lane.burnRatePerHour === 'number' && Number.isFinite(lane.burnRatePerHour) && lane.burnRatePerHour >= 0) {
    return lane.burnRatePerHour;
  }
  const samples = Array.isArray(lane.recentSamples) ? lane.recentSamples : [];
  if (samples.length < 2) return null;
  const sorted = [...samples]
    .filter(s => s && typeof s.at === 'string' && Number.isFinite(Date.parse(s.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sorted.length < 2) return null;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const t0 = Date.parse(first.at);
  const t1 = Date.parse(last.at);
  const deltaUsd = Number(last.spentUsd) - Number(first.spentUsd);
  const deltaHours = (t1 - t0) / 3_600_000;
  if (!Number.isFinite(deltaHours) || deltaHours <= 0 || !Number.isFinite(deltaUsd) || deltaUsd < 0) return null;
  return deltaUsd / deltaHours;
}

/**
 * @param {{ spentUsd: number, projectedUsd: number, capUsd: number | null | undefined, warnRatio?: number }} input
 */
export function laneQuotaPhase({ spentUsd, projectedUsd, capUsd, warnRatio = DEFAULT_LANE_WARN_RATIO }) {
  if (capUsd === null || capUsd === undefined) {
    return { phase: 'no-cap', headroomUsd: null };
  }
  if (!isValidCapUsd(capUsd)) {
    return { phase: 'unknown', headroomUsd: null };
  }
  const cap = capUsd;
  if (!isValidSpentUsd(spentUsd)) {
    return { phase: 'unknown', headroomUsd: null };
  }
  const spent = spentUsd;
  const projected = Number.isFinite(projectedUsd) ? projectedUsd : spent;
  if (spent >= cap || projected >= cap) {
    return { phase: 'at-cap', headroomUsd: 0 };
  }
  const threshold = cap * resolveWarnRatio(warnRatio);
  const headroomUsd = roundUsd(cap - projected);
  if (projected >= threshold) {
    return { phase: 'warn', headroomUsd };
  }
  return { phase: 'ok', headroomUsd: roundUsd(cap - projected) };
}

/**
 * @param {number} nowMs
 * @param {number} spentUsd
 * @param {number} capUsd
 * @param {number | null} burnRatePerHour
 * @returns {string | null}
 */
function projectedRunOutAtIso(nowMs, spentUsd, capUsd, burnRatePerHour) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) return null;
  const headroom = capUsd - spentUsd;
  if (headroom <= 0) return new Date(nowMs).toISOString();
  if (burnRatePerHour === null || !Number.isFinite(burnRatePerHour) || burnRatePerHour <= 0) return null;
  const hours = headroom / burnRatePerHour;
  return new Date(nowMs + hours * 3_600_000).toISOString();
}

/**
 * @param {LaneQuotaInput | LaneQuotaInput[]} lanes
 * @returns {LaneQuotaInput[]}
 */
function normalizeLanes(lanes) {
  if (Array.isArray(lanes)) return lanes;
  if (lanes && typeof lanes === 'object') {
    return Object.entries(lanes).map(([name, value]) => ({
      name,
      ...(value && typeof value === 'object' ? value : {}),
    }));
  }
  return [];
}

/** @returns {LaneQuotaForecast} */
function unknownLaneForecast(name) {
  return {
    name,
    phase: 'unknown',
    projectedRunOutAt: null,
    headroomUsd: null,
    recommendation: null,
  };
}

/**
 * Read-only forecast: when each lane hits its configured daily cap given current spend and burn.
 * Does not read files, call the network, or mutate caps/config.
 *
 * @param {{ lanes: LaneQuotaInput | LaneQuotaInput[] | Record<string, Omit<LaneQuotaInput, 'name'>>, now?: string | number | Date }} input
 * @returns {{ lanes: LaneQuotaForecast[], summary: LaneQuotaForecastSummary }}
 */
export function forecastLaneQuotas({ lanes, now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now ?? Date.now());
  const normalized = normalizeLanes(lanes);

  if (!Number.isFinite(nowMs)) {
    const forecasts = normalized.map(lane => unknownLaneForecast(lane.name));
    return {
      lanes: forecasts,
      summary: {
        atRiskSoonest: [],
        healthiestLane: null,
        suggestedReroute: null,
      },
    };
  }

  const horizonHours = hoursUntilUtcDayEnd(nowMs);

  /** @type {LaneQuotaForecast[]} */
  const forecasts = normalized.map(lane => {
    const capUsd = lane.capUsd;
    const warnRatio = resolveWarnRatio(lane.warnRatio);

    if (!isValidSpentUsd(lane.spentUsd)) {
      return unknownLaneForecast(lane.name);
    }
    const spentUsd = lane.spentUsd;

    if (capUsd !== null && capUsd !== undefined && !isValidCapUsd(capUsd)) {
      return unknownLaneForecast(lane.name);
    }

    const burnRatePerHour = resolveBurnRatePerHour(lane);

    if (capUsd !== null && capUsd !== undefined && burnRatePerHour === null) {
      if (spentUsd >= capUsd) {
        return {
          name: lane.name,
          phase: 'at-cap',
          projectedRunOutAt: projectedRunOutAtIso(nowMs, spentUsd, capUsd, burnRatePerHour),
          headroomUsd: 0,
          recommendation: 'shift-work',
        };
      }
      return unknownLaneForecast(lane.name);
    }

    const rateForProjection = burnRatePerHour ?? 0;
    const projectedUsd = roundUsd(spentUsd + rateForProjection * horizonHours);
    const { phase, headroomUsd } = laneQuotaPhase({ spentUsd, projectedUsd, capUsd, warnRatio });
    const projectedRunOutAt =
      capUsd === null || capUsd === undefined
        ? null
        : projectedRunOutAtIso(nowMs, spentUsd, capUsd, burnRatePerHour);

    const recommendation = phase === 'warn' || phase === 'at-cap' ? 'shift-work' : null;

    return {
      name: lane.name,
      phase,
      projectedRunOutAt,
      headroomUsd,
      recommendation,
    };
  });

  const atRisk = forecasts
    .filter(f => f.phase === 'warn' || f.phase === 'at-cap')
    .sort((a, b) => {
      const ta = a.projectedRunOutAt ? Date.parse(a.projectedRunOutAt) : Number.POSITIVE_INFINITY;
      const tb = b.projectedRunOutAt ? Date.parse(b.projectedRunOutAt) : Number.POSITIVE_INFINITY;
      return ta - tb;
    });

  const okLanes = forecasts.filter(f => f.phase === 'ok');
  let healthiestLane = null;
  let bestHeadroom = -1;
  for (const lane of okLanes) {
    const h = lane.headroomUsd ?? 0;
    if (h > bestHeadroom) {
      bestHeadroom = h;
      healthiestLane = lane.name;
    }
  }

  const shiftFrom = atRisk[0]?.name ?? null;
  /** @type {RoutingRecord | null} */
  let suggestedReroute = null;
  if (shiftFrom && healthiestLane && shiftFrom !== healthiestLane) {
    suggestedReroute = {
      agent: healthiestLane,
      model: null,
      reason: `lane-quota-forecast: shift work off ${shiftFrom} before daily cap stall`,
      routeSource: 'quota-forecast',
    };
  }

  return {
    lanes: forecasts,
    summary: {
      atRiskSoonest: atRisk.map(f => f.name),
      healthiestLane,
      suggestedReroute,
    },
  };
}
