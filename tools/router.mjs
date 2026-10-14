// SPDX-License-Identifier: Apache-2.0

export const ROUTE_ORDER = Object.freeze(['hermes', 'cursor', 'codex', 'openrouter', 'claude']);

export function routeJob(job, { lanes = {}, health = () => ({ state: 'ok' }), failures = {}, accepts = () => true } = {}) {
  if (job?.agent !== 'auto') {
    const error = new Error('route-invalid: job.agent must be auto');
    error.code = 'route-invalid';
    throw error;
  }

  const order = Array.isArray(job.typeRoute) && job.typeRoute.length ? job.typeRoute : ROUTE_ORDER;
  const withFallback = order.includes('claude') ? order : [...order, 'claude'];
  let candidates = withFallback.filter(agent => typeof lanes[agent]?.model === 'string');
  if (job.sensitive === true) candidates = candidates.filter(agent => agent !== 'openrouter');
  if (job.tier === 'expensive') candidates = candidates.filter(agent => agent === 'claude');

  let reason = job.tier === 'expensive' ? 'tier expensive' : 'cheapest healthy lane';
  let failedIndex = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    if (failures[candidates[index]] >= 2) failedIndex = index;
  }
  if (failedIndex >= 0) {
    reason = `fallback after 2 failures on ${candidates[failedIndex]}`;
    candidates = candidates.slice(failedIndex + 1);
  }

  candidates = candidates.filter(agent => accepts({ ...job, agent, model: lanes[agent].model }) !== false);
  for (const agent of candidates) {
    if (health(agent).state !== 'paused') return { agent, model: lanes[agent].model, reason };
  }
  if (candidates.length > 0) {
    const agent = candidates[0];
    return { agent, model: lanes[agent].model, reason: `${reason}; lane ${agent} paused` };
  }

  const error = new Error(`route-exhausted: no lane left for job ${job.id} (${reason})`);
  error.code = 'route-exhausted';
  throw error;
}
