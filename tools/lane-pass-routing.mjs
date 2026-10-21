// SPDX-License-Identifier: Apache-2.0
// CLI wiring belongs to a later tools/swarm.mjs change owned elsewhere.

import path from 'node:path';
import { routeJob } from './router.mjs';
import { FAILURE_STATUSES } from './failure-regression.mjs';

const PASS_STATUS = 'complete';
const IGNORED_STATUSES = new Set(['cancelled', 'held']);

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
    } catch {
      // A run may be incomplete or concurrently unavailable; keep the readable runs.
    }
  }
  return runStates;
}
