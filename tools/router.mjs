// SPDX-License-Identifier: Apache-2.0

import { isBookkeepingJob } from './openrouter.mjs';

// Code jobs: Haiku first, then Cursor, then Codex; the Claude subscription only after 2 failures.
// Hermes is not in this order: it runs only where a job type names it (research). OpenRouter runs
// only bookkeeping jobs (PR payloads, changelogs, metrics) that are not sensitive. The order comes
// from the lane benchmark (docs/state/lane-benchmark.md).
export const CHEAP_ORDER = Object.freeze(['anthropic', 'cursor', 'codex', 'openrouter']);
export const ROUTE_ORDER = Object.freeze([...CHEAP_ORDER, 'claude']);

// The Anthropic lane's model follows the job's tier: the lane model (Haiku) by default, Sonnet for
// tier "mid". Opus is never picked here; it needs an explicit anthropic job with tier "expensive".
const ANTHROPIC_MID_MODEL = 'claude-sonnet-5-5';
const laneModel = (job, agent, lanes) => (agent === 'anthropic' && job.tier === 'mid' ? ANTHROPIC_MID_MODEL : lanes[agent].model);

export function routeJob(job, { lanes = {}, health = () => ({ state: 'ok' }), failures = {}, accepts = () => true } = {}) {
  if (job?.agent !== 'auto') {
    const error = new Error('route-invalid: job.agent must be auto');
    error.code = 'route-invalid';
    throw error;
  }

  const configured = agent => typeof lanes[agent]?.model === 'string';
  const accepted = agent => accepts({ ...job, agent, model: laneModel(job, agent, lanes) }) !== false;
  const order = [...new Set([...(Array.isArray(job.typeRoute) ? job.typeRoute : []).filter(agent => agent !== 'claude'), ...CHEAP_ORDER])];
  let reason = 'cheapest healthy lane';
  let candidates;
  if (job.tier === 'expensive') {
    reason = 'tier expensive';
    candidates = configured('claude') && !(failures.claude >= 2) && accepted('claude') ? ['claude'] : [];
  } else {
    candidates = order.filter(agent => configured(agent)
      && (agent !== 'openrouter' || (job.sensitive === false && isBookkeepingJob(job.outputs)))
      && accepted(agent));
    const failed = candidates.filter(agent => failures[agent] >= 2);
    if (failed.length) reason = `fallback after 2 failures on ${failed.join(', ')}`;
    candidates = candidates.filter(agent => !(failures[agent] >= 2));
    const totalFailures = order.reduce((sum, agent) => sum + (failures[agent] ?? 0), 0);
    if (!candidates.length && totalFailures >= 2 && configured('claude')
      && !(failures.claude >= 2) && accepted('claude')) {
      candidates = ['claude'];
      reason = `fallback after 2 failures on ${order.filter(agent => failures[agent] > 0).join(', ')}`;
    }
    if (!candidates.length && !order.some(configured) && totalFailures === 0) {
      throw Object.assign(new Error(`route-exhausted: no cheap lane available for job ${job.id}; Claude needs 2 real failures first or tier "expensive"`), { code: 'route-exhausted' });
    }
  }
  for (const agent of candidates) {
    if (health(agent).state !== 'paused') return { agent, model: laneModel(job, agent, lanes), reason };
  }
  if (candidates.length > 0) {
    const agent = candidates[0];
    return { agent, model: laneModel(job, agent, lanes), reason: `${reason}; lane ${agent} paused` };
  }

  const error = new Error(`route-exhausted: no lane left for job ${job.id} (${reason})`);
  error.code = 'route-exhausted';
  throw error;
}
