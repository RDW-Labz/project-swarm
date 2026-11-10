// SPDX-License-Identifier: Apache-2.0
// CLI wiring belongs to a later tools/swarm.mjs change owned elsewhere.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { routeJob } from './router.mjs';
import { FAILURE_STATUSES } from './failure-regression.mjs';
import { projectSwarmHome } from './state-guard.mjs';

// The lane quality check looks at recent runs only: a lane that failed days ago (an outage, a bug since
// fixed) must not stay ruled out forever. Runs before the current install also do not count: installing
// a fix starts the history fresh.
export const PASS_RATE_WINDOW_MS = 48 * 60 * 60 * 1000;

const swarmHome = ({ env = process.env, home = os.homedir() } = {}) => (env?.SWARM_HOME ? path.resolve(env.SWARM_HOME) : projectSwarmHome(home, env ?? {}));

const PASS_STATUS = 'complete';
const IGNORED_STATUSES = new Set(['cancelled', 'held']);
const PROVIDER_LIMIT_RE = /out of credits|quota|usage limit|rate limit|insufficient_quota|credit/i;

function jobFailureText(job) {
  if (typeof job?.agentError === 'string' && job.agentError.trim()) return job.agentError;
  const raw = job?.error;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return String(raw.message ?? raw.reason ?? raw.code ?? '');
  if (typeof job?.reason === 'string') return job.reason;
  return '';
}

export function isProviderLimitFailure(job) {
  const status = typeof job?.status === 'string' ? job.status.trim() : '';
  if (status !== PASS_STATUS && !FAILURE_STATUSES.has(status)) return false;
  if (status === PASS_STATUS) return false;
  return PROVIDER_LIMIT_RE.test(jobFailureText(job));
}

const toMs = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// When a job happened: its own finish or start time, else the run's, else the run folder's epoch-ms prefix.
export function jobTimeMs(job, state, runName) {
  for (const value of [job?.finishedAt, job?.startedAt, state?.finishedAt, state?.startedAt]) {
    const ms = toMs(value);
    if (ms != null) return ms;
  }
  const prefix = /^(\d{12,14})-/.exec(String(runName ?? ''));
  return prefix ? Number(prefix[1]) : null;
}

// since (ms): only jobs at or after it count; a job with no known time does not count then.
export function lanePassRates(runStates, { since = null } = {}) {
  const rates = {};
  if (!runStates || typeof runStates !== 'object' || Array.isArray(runStates)) return rates;

  for (const [runName, state] of Object.entries(runStates)) {
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    for (const job of jobs) {
      if (since != null) {
        const at = jobTimeMs(job, state, runName);
        if (at == null || at < since) continue;
      }
      const agent = typeof job?.agent === 'string' ? job.agent.trim() : '';
      const status = typeof job?.status === 'string' ? job.status.trim() : '';
      if (!agent || IGNORED_STATUSES.has(status)) continue;
      if (status !== PASS_STATUS && !FAILURE_STATUSES.has(status)) continue;
      if (status !== PASS_STATUS && isProviderLimitFailure(job)) continue;

      const rate = rates[agent] ?? { passed: 0, failed: 0, total: 0, rate: 0 };
      if (status === PASS_STATUS) rate.passed += 1;
      else rate.failed += 1;
      rate.total += 1;
      rate.rate = rate.passed / rate.total;
      rates[agent] = rate;
    }
  }

  return rates;
}

export function routingFailures(rates, { minSamples = 5, failBelow = 0.5 } = {}) {
  const failures = {};
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) return failures;

  for (const [agent, summary] of Object.entries(rates)) {
    const total = Number(summary?.total);
    const rate = Number(summary?.rate);
    failures[agent] = Number.isFinite(total) && total >= minSamples && rate < failBelow ? 2 : 0;
  }

  return failures;
}

export function routeWithPassRates(job, routeOptions = {}, runStates, thresholds, { since = null } = {}) {
  const rates = lanePassRates(runStates, { since });
  const passFailures = routingFailures(rates, thresholds);
  return routeWithQualityFallback(failures => routeJob(job, { ...routeOptions, failures }), {
    baseFailures: routeOptions?.failures ?? {}, passFailures, rates,
  }).route;
}

export async function readRunStates(root, { readdir, readFile }) {
  const runsDir = path.join(root, '.swarm', 'runs');
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return {};
  }

  const runStates = {};
  for (const entry of entries ?? []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name || (typeof entry !== 'string' && entry?.isDirectory?.() === false)) continue;
    try {
      const raw = await readFile(path.join(runsDir, name, 'state.json'), 'utf8');
      runStates[name] = JSON.parse(raw);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && !(error instanceof SyntaxError)) {
        console.error('[tools/lane-pass-routing.mjs] readRunStates state.json:', error?.message ?? error);
      }
      // A run may be incomplete or concurrently unavailable; keep the readable runs.
    }
  }
  return runStates;
}

export function readRunStatesSync(root, { readdirSync, readFileSync } = fs) {
  const runsDir = path.join(root, '.swarm', 'runs');
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return {};
  }

  const folders = [];
  for (const entry of entries ?? []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name || (typeof entry !== 'string' && entry?.isDirectory?.() === false)) continue;
    folders.push(name);
  }
  folders.sort((a, b) => b < a ? -1 : b > a ? 1 : 0);

  const runStates = {};
  for (const name of folders.slice(0, 200)) {
    try {
      const state = JSON.parse(readFileSync(path.join(runsDir, name, 'state.json'), 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
      runStates[name] = state;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && !(error instanceof SyntaxError)) {
        console.error('[tools/lane-pass-routing.mjs] readRunStatesSync state.json:', error?.message ?? error);
      }
      // A run may be incomplete or concurrently unavailable; keep the readable runs.
    }
  }
  return runStates;
}

// When this swarm build was installed: `swarm install` and a rollback both re-point
// ~/.project-swarm/current, so the link's own time is the install time. null when unknown.
export function installedAtMs({ env = process.env, home = os.homedir(), lstatSync = fs.lstatSync } = {}) {
  try {
    const ms = lstatSync(path.join(swarmHome({ env, home }), 'current')).mtimeMs;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Start of the counted history: 48 hours ago, or the install time when that is later.
export function passRateSince({ now = Date.now(), installedAt = null, windowMs = PASS_RATE_WINDOW_MS } = {}) {
  const windowStart = now - windowMs;
  return Number.isFinite(installedAt) && installedAt > windowStart ? installedAt : windowStart;
}

const passRateCache = new Map();

// { failures, rates, since } for a project root, read once per process.
export function passRateSummaryFor(root, deps = {}) {
  let resolved;
  try {
    resolved = path.resolve(root ?? process.cwd());
    if (passRateCache.has(resolved)) return passRateCache.get(resolved);
    const fsDeps = deps?.fs ?? deps;
    const states = readRunStatesSync(resolved, {
      readdirSync: fsDeps?.readdirSync ?? fs.readdirSync,
      readFileSync: fsDeps?.readFileSync ?? fs.readFileSync,
    });
    const now = typeof deps?.now === 'function' ? deps.now() : Date.now();
    const installedAt = deps?.installedAt !== undefined ? deps.installedAt : installedAtMs({ env: deps?.env, home: deps?.home });
    const since = passRateSince({ now, installedAt });
    const rates = lanePassRates(states, { since });
    const summary = { failures: routingFailures(rates), rates, since };
    passRateCache.set(resolved, summary);
    return summary;
  } catch {
    const empty = { failures: {}, rates: {}, since: null };
    if (resolved) passRateCache.set(resolved, empty);
    return empty;
  }
}

export function passRateFailuresFor(root, deps = {}) {
  return passRateSummaryFor(root, deps).failures;
}

// Lanes the quality check ruled out, healthiest first (highest pass rate, then most passes).
export function healthiestFirst(passFailures = {}, rates = {}) {
  return Object.keys(passFailures)
    .filter(agent => passFailures[agent] >= 2)
    .sort((a, b) => (rates[b]?.rate ?? 0) - (rates[a]?.rate ?? 0) || (rates[b]?.passed ?? 0) - (rates[a]?.passed ?? 0) || (a < b ? -1 : 1));
}

// When the quality check alone leaves no lane, route to the healthiest ruled-out lane instead of failing.
// route(failures) is the router; baseFailures are this run's real failures (never lifted).
// Returns { route, fallback: { agent, rate, passed, total } | null }; rethrows when no lane can take it.
export function routeWithQualityFallback(route, { baseFailures = {}, passFailures = {}, rates = {} } = {}) {
  const merged = { ...baseFailures };
  for (const [agent, count] of Object.entries(passFailures)) merged[agent] = Math.max(Number(baseFailures[agent]) || 0, count);
  try {
    return { route: route(merged), fallback: null };
  } catch (error) {
    if (error?.code !== 'route-exhausted') throw error;
    for (const agent of healthiestFirst(passFailures, rates)) {
      if ((Number(baseFailures[agent]) || 0) >= 2) continue;
      try {
        const lifted = { ...merged, [agent]: Number(baseFailures[agent]) || 0 };
        const picked = route(lifted);
        const r = rates[picked.agent] ?? {};
        const ratePct = r.rate == null ? '?' : `${Math.round(r.rate * 100)}%`;
        return {
          route: { ...picked, reason: `${picked.reason}; lane-quality fallback: every lane was under the pass-rate bar, using the healthiest (${picked.agent}, ${ratePct} of ${r.total ?? 0} jobs)` },
          fallback: { agent: picked.agent, rate: r.rate ?? null, passed: r.passed ?? 0, total: r.total ?? 0 },
        };
      } catch (inner) {
        if (inner?.code !== 'route-exhausted') throw inner;
      }
    }
    throw error;
  }
}

export function laneQualityAlertsFile({ env = process.env, home = os.homedir() } = {}) {
  return path.join(swarmHome({ env, home }), 'alerts', 'lane-quality.jsonl');
}

// One line per fallback, read by bot-fleet's Fleet health. Never throws.
export function recordLaneQualityAlert(alert, { env = process.env, home = os.homedir(), now = Date.now } = {}) {
  try {
    const file = laneQualityAlertsFile({ env, home });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), kind: 'lane-quality-fallback', ...alert })}\n`);
  } catch {}
}
