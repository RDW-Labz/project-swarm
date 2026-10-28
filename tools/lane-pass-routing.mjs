// SPDX-License-Identifier: Apache-2.0
// CLI wiring belongs to a later tools/swarm.mjs change owned elsewhere.

import path from 'node:path';
import fs from 'node:fs';
import { routeJob } from './router.mjs';
import { FAILURE_STATUSES } from './failure-regression.mjs';

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

export function lanePassRates(runStates) {
  const rates = {};
  if (!runStates || typeof runStates !== 'object' || Array.isArray(runStates)) return rates;

  for (const state of Object.values(runStates)) {
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    for (const job of jobs) {
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

export function routeWithPassRates(job, routeOptions = {}, runStates, thresholds) {
  const observed = routingFailures(lanePassRates(runStates), thresholds);
  const existing = routeOptions?.failures ?? {};
  const failures = { ...existing };
  for (const [agent, count] of Object.entries(observed)) {
    failures[agent] = Math.max(Number(existing[agent]) || 0, count);
  }
  return routeJob(job, { ...routeOptions, failures });
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
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
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
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        console.error('[tools/lane-pass-routing.mjs] readRunStatesSync state.json:', error?.message ?? error);
      }
      // A run may be incomplete or concurrently unavailable; keep the readable runs.
    }
  }
  return runStates;
}

const passRateFailuresCache = new Map();

export function passRateFailuresFor(root, deps = {}) {
  let resolved;
  try {
    resolved = path.resolve(root ?? process.cwd());
    if (passRateFailuresCache.has(resolved)) return passRateFailuresCache.get(resolved);
    const fsDeps = deps?.fs ?? deps;
    const states = readRunStatesSync(resolved, {
      readdirSync: fsDeps?.readdirSync ?? fs.readdirSync,
      readFileSync: fsDeps?.readFileSync ?? fs.readFileSync,
    });
    const failures = routingFailures(lanePassRates(states));
    passRateFailuresCache.set(resolved, failures);
    return failures;
  } catch {
    if (resolved) passRateFailuresCache.set(resolved, {});
    return {};
  }
}
