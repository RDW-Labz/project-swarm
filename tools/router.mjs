// SPDX-License-Identifier: Apache-2.0

export const CHEAP_ORDER = Object.freeze(['hermes', 'cursor', 'codex', 'openrouter']);
export const ROUTE_ORDER = Object.freeze(['hermes', 'cursor', 'codex', 'openrouter', 'claude']);

export function routeJob(job, { lanes = {}, health = () => ({ state: 'ok' }), failures = {}, accepts = () => true } = {}) {
  if (job?.agent !== 'auto') {
    const error = new Error('route-invalid: job.agent must be auto');
    error.code = 'route-invalid';
    throw error;
  }

  const configured = agent => typeof lanes[agent]?.model === 'string';
  const accepted = agent => accepts({ ...job, agent, model: lanes[agent].model }) !== false;
  const order = [...new Set([...(Array.isArray(job.typeRoute) ? job.typeRoute : []).filter(agent => agent !== 'claude'), ...CHEAP_ORDER])];
  let reason = 'cheapest healthy lane';
  let candidates;
  if (job.tier === 'expensive') {
    reason = 'tier expensive';
    candidates = configured('claude') && !(failures.claude >= 2) && accepted('claude') ? ['claude'] : [];
  } else {
    candidates = order.filter(agent => configured(agent)
      && (agent !== 'openrouter' || job.sensitive === false)
      && accepted(agent));
    const failed = candidates.filter(agent => failures[agent] >= 2);
    if (failed.length) reason = `fallback after 2 failures on ${failed.join(', ')}`;
    candidates = candidates.filter(agent => !(failures[agent] >= 2));
    const totalFailures = CHEAP_ORDER.reduce((sum, agent) => sum + (failures[agent] ?? 0), 0);
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
