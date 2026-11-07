// SPDX-License-Identifier: Apache-2.0
// T-0192: cap forecast and warn-cap actions before the project hard stop (budget manager).
import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateWork, laneRates, stageHistory } from '../../estimates.mjs';
import { jobSpend, runTotals } from '../../spend.mjs';
import { wavesOf } from '../../tickets.mjs';
import {
  DEFAULT_WARN_BEFORE_CAP_RATIO,
  WARN_CAP_ACTION,
  capWatchStatus,
  warnCapReason,
  watchProjectDailySpend,
} from './spend-watch.mjs';

/** @typedef {import('../types.mjs').ManagerFinding} ManagerFinding */

/** Finding codes for cap forecast / spend warnings (replay fixtures key off these). */
export const CAP_WARN_FINDING_CODES = Object.freeze(['cap-warn-spend', 'cap-warn-forecast']);

/**
 * @typedef {object} CapWarnWatchItem
 * @property {'cap-warn-spend' | 'cap-warn-forecast'} code
 * @property {'info' | 'warn' | 'needs_you'} severity
 * @property {string} action
 * @property {string} reason
 * @property {string} [recommendation]
 */

/**
 * @typedef {object} ScopeSpendForecast
 * @property {number} remainingTickets
 * @property {number} currentWaveTickets
 * @property {{ low: number, mid: number, high: number } | null} scopeUsd
 * @property {{ low: number, mid: number, high: number } | null} waveUsd
 * @property {number} runningExposureUsd
 * @property {string} basis
 * @property {boolean} learned
 */

const roundUsd = value => Math.round(value * 1e6) / 1e6;

/**
 * @param {string} text
 * @param {number} max
 */
function clipReason(text, max) {
  const value = String(text ?? '').trim() || 'budget-cap-warn';
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/**
 * @param {unknown} tickets
 */
function liveTickets(tickets) {
  return (Array.isArray(tickets) ? tickets : []).filter(
    t => t && t.status !== 'cancelled' && t.status !== 'proposed' && t.type !== 'human',
  );
}

/**
 * @param {unknown} tickets
 */
function remainingBuildTickets(tickets) {
  return liveTickets(tickets).filter(t => t.status !== 'done');
}

/**
 * @param {readonly string[]} waveIds
 * @param {Set<string>} done
 */
function pendingInWave(waveIds, done) {
  return waveIds.filter(id => !done.has(id));
}

/**
 * Forecast finish cost for the current wave and the remaining scope (tools/estimates.mjs).
 *
 * @param {{ tickets?: unknown[], runs?: { state?: object }[], runningExposureUsd?: number }} input
 * @returns {ScopeSpendForecast}
 */
export function forecastScopeSpend({ tickets = [], runs = [], runningExposureUsd = 0 } = {}) {
  const remaining = remainingBuildTickets(tickets);
  const exposure = Number.isFinite(runningExposureUsd) && runningExposureUsd > 0 ? runningExposureUsd : 0;
  if (!remaining.length) {
    return {
      remainingTickets: 0,
      currentWaveTickets: 0,
      scopeUsd: { low: 0, mid: 0, high: 0 },
      waveUsd: { low: 0, mid: 0, high: 0 },
      runningExposureUsd: roundUsd(exposure),
      basis: 'no remaining tickets',
      learned: false,
    };
  }

  const stages = stageHistory({ tickets, runs });
  const lanes = laneRates({ tickets, runs });
  const scopeWork = estimateWork({ requirements: remaining.length, stages, lanes });
  const scopeUsd = scopeWork.usd
    ? { low: roundUsd(scopeWork.usd.low), mid: roundUsd(scopeWork.usd.mid), high: roundUsd(scopeWork.usd.high) }
    : null;

  const done = new Set(liveTickets(tickets).filter(t => t.status === 'done').map(t => t.id));
  let currentWaveTickets = 0;
  try {
    for (const wave of wavesOf(liveTickets(tickets))) {
      const pending = pendingInWave(wave, done);
      if (pending.length) {
        currentWaveTickets = pending.length;
        break;
      }
    }
  } catch {
    currentWaveTickets = remaining.length;
  }

  const waveWork = estimateWork({ requirements: currentWaveTickets || remaining.length, stages, lanes });
  const waveUsd = waveWork.usd
    ? { low: roundUsd(waveWork.usd.low), mid: roundUsd(waveWork.usd.mid), high: roundUsd(waveWork.usd.high) }
    : null;

  const dear = lanes.lanes?.at(-1)?.usdPerTicket;
  if (waveUsd && dear !== undefined && dear > 0 && currentWaveTickets > 0) {
    const worst = roundUsd(currentWaveTickets * dear * (lanes.jobsPerTicket ?? 1));
    if (worst > waveUsd.high) waveUsd.high = worst;
  }

  return {
    remainingTickets: remaining.length,
    currentWaveTickets,
    scopeUsd,
    waveUsd,
    runningExposureUsd: roundUsd(exposure),
    basis: scopeWork.basis,
    learned: Boolean(scopeWork.learned),
  };
}

/**
 * @param {{ spentUsd: number, projectedUsd: number, capUsd: number|null|undefined, warnRatio?: number }} input
 */
export function capForecastWatchStatus({ spentUsd, projectedUsd, capUsd, warnRatio = DEFAULT_WARN_BEFORE_CAP_RATIO }) {
  if (capUsd === null || capUsd === undefined) {
    return { phase: 'no-cap', spentUsd, projectedUsd, capUsd: null, headroomUsd: null, warnRatio };
  }
  if (projectedUsd >= capUsd) {
    return { phase: 'at-cap', spentUsd, projectedUsd, capUsd, headroomUsd: 0, warnRatio };
  }
  const threshold = capUsd * warnRatio;
  if (projectedUsd >= threshold) {
    return {
      phase: 'warn',
      spentUsd,
      projectedUsd,
      capUsd,
      headroomUsd: roundUsd(capUsd - projectedUsd),
      warnRatio,
    };
  }
  return {
    phase: 'ok',
    spentUsd,
    projectedUsd,
    capUsd,
    headroomUsd: roundUsd(capUsd - projectedUsd),
    warnRatio,
  };
}

/**
 * @param {{ spentUsd: number, projectedUsd: number, capUsd: number, capSource?: string, warnRatio?: number, forecast: ScopeSpendForecast }} input
 */
export function warnCapForecastReason({
  spentUsd,
  projectedUsd,
  capUsd,
  capSource,
  warnRatio = DEFAULT_WARN_BEFORE_CAP_RATIO,
  forecast,
}) {
  const source = capSource ?? 'profile budget.projectMaxUsd';
  const wave = forecast.waveUsd?.high;
  const scope = forecast.scopeUsd?.high;
  const tail = wave != null && scope != null
    ? ` (wave worst case ~$${wave.toFixed(2)}, scope ~$${scope.toFixed(2)}${forecast.runningExposureUsd > 0 ? `, in-flight exposure $${forecast.runningExposureUsd.toFixed(2)}` : ''})`
    : '';
  return clipReason(
    `budget-warn-forecast: billed $${spentUsd.toFixed(2)} today + forecast finish ~$${(projectedUsd - spentUsd).toFixed(2)} => ~$${projectedUsd.toFixed(2)} >= ${Math.round(warnRatio * 100)}% of cap $${capUsd.toFixed(2)} (${source})${tail}; lower wave size or raise the cap before the hard stop`,
    2000,
  );
}

/**
 * @param {{
 *   spentUsd: number,
 *   capUsd: number|null,
 *   capSource?: string|null,
 *   warnRatio?: number,
 *   spendWatch?: ReturnType<typeof capWatchStatus>,
 *   forecastWatch?: ReturnType<typeof capForecastWatchStatus>,
 *   forecast?: ScopeSpendForecast,
 * }} input
 * @returns {CapWarnWatchItem[]}
 */
export function capWarnWatchItems({
  spentUsd,
  capUsd,
  capSource,
  warnRatio,
  spendWatch,
  forecastWatch,
  forecast,
}) {
  if (capUsd === null || capUsd === undefined) return [];
  /** @type {CapWarnWatchItem[]} */
  const items = [];
  const spend = spendWatch ?? capWatchStatus({ spentUsd, capUsd, warnRatio });
  if (spend.phase === 'warn' || spend.phase === 'at-cap') {
    items.push({
      code: 'cap-warn-spend',
      severity: spend.phase === 'at-cap' ? 'needs_you' : 'warn',
      action: WARN_CAP_ACTION,
      reason: warnCapReason({ spentUsd, capUsd, capSource: capSource ?? undefined, warnRatio }),
      recommendation: 'Lower the wave size, pause expensive lanes, or raise budget.projectMaxUsd before new runs are refused',
    });
  }
  if (!forecast || !forecastWatch) return items;
  if (forecastWatch.phase === 'ok' || forecastWatch.phase === 'no-cap') return items;
  if (forecastWatch.phase === 'warn' || forecastWatch.phase === 'at-cap') {
    const projectedUsd = forecastWatch.projectedUsd;
    items.push({
      code: 'cap-warn-forecast',
      severity: forecastWatch.phase === 'at-cap' ? 'needs_you' : 'warn',
      action: WARN_CAP_ACTION,
      reason: warnCapForecastReason({
        spentUsd,
        projectedUsd,
        capUsd,
        capSource: capSource ?? undefined,
        warnRatio,
        forecast,
      }),
      recommendation: forecast.learned
        ? 'Finish or shrink the current wave before starting another; confirm estimates against recent lane costs'
        : 'No reliable ticket cost history yet: treat the forecast as a worst-case bound and lower wave size',
    });
  }
  return items;
}

/**
 * @param {string} root
 */
async function readProjectTickets(root) {
  const file = path.join(root, '.swarm', 'project', 'tickets.json');
  try {
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * @param {string} root
 */
async function readProjectRuns(root) {
  const dir = path.join(root, '.swarm', 'runs');
  /** @type {{ state: object }[]} */
  const runs = [];
  let ids = [];
  try {
    ids = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return runs;
    throw error;
  }
  for (const id of ids) {
    const file = path.join(dir, id, 'state.json');
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state && typeof state === 'object' && !Array.isArray(state)) runs.push({ state });
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }
  return runs;
}

/**
 * In-flight exposure: remaining run budget on jobs still running (matches project-spend exposure).
 *
 * @param {{ state?: object }[]} runs
 */
export function runningExposureUsdFromRuns(runs) {
  let exposure = 0;
  for (const { state } of runs ?? []) {
    if (!state || state.status !== 'running') continue;
    const cap = state.budget?.maxUsd;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) continue;
    const spent = runTotals(state).usd;
    exposure += Math.max(0, cap - spent);
    for (const job of state.jobs ?? []) {
      if (job?.status !== 'running') continue;
      const usd = jobSpend(job).usd;
      if (typeof usd !== 'number' || !(usd > 0)) continue;
      const jobCap = job.budget?.maxUsd ?? job.maxUsd;
      if (typeof jobCap === 'number' && Number.isFinite(jobCap) && jobCap > usd) {
        exposure += Math.max(0, jobCap - usd);
      }
    }
  }
  return roundUsd(exposure);
}

/**
 * Roll up today's spend, forecast remaining wave/scope cost, and emit warn-cap watch items (AC1).
 *
 * @param {string} root
 * @param {{ day?: string, dir?: string, env?: NodeJS.ProcessEnv, now?: () => number, warnRatio?: number, tickets?: unknown[], runs?: { state?: object }[] }} [options]
 */
export async function watchProjectCapForecast(root, options = {}) {
  const spend = await watchProjectDailySpend(root, options);
  const tickets = options.tickets ?? await readProjectTickets(root);
  const runs = options.runs ?? await readProjectRuns(root);
  const runningExposureUsd = runningExposureUsdFromRuns(runs);
  const forecast = forecastScopeSpend({ tickets, runs, runningExposureUsd });

  const spentUsd = spend.usd;
  const capUsd = spend.capUsd;
  const forecastFinishUsd = forecast.waveUsd?.high ?? forecast.scopeUsd?.high ?? 0;
  const projectedUsd = roundUsd(spentUsd + forecastFinishUsd + runningExposureUsd);

  const spendWatch = spend.watch ?? capWatchStatus({ spentUsd, capUsd, warnRatio: options.warnRatio });
  const forecastWatch = capForecastWatchStatus({
    spentUsd,
    projectedUsd,
    capUsd,
    warnRatio: options.warnRatio,
  });

  const items = capWarnWatchItems({
    spentUsd,
    capUsd,
    capSource: spend.capSource,
    warnRatio: options.warnRatio,
    spendWatch,
    forecastWatch,
    forecast,
  });

  return {
    ...spend,
    forecast,
    projectedUsd,
    forecastWatch,
    items,
  };
}

/**
 * Map cap warn items to manager finding shapes (orchestrator supplies ids and modes).
 *
 * @param {readonly CapWarnWatchItem[]} items
 * @returns {Omit<ManagerFinding, 'id'|'managerId'|'mode'>[]}
 */
export function capWarnWatchItemsToFindingInputs(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map(item => ({
    severity: item.severity,
    code: item.code,
    reason: item.reason,
    action: item.action,
    ...(item.recommendation ? { recommendation: item.recommendation } : {}),
  }));
}
