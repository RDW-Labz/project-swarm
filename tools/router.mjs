// SPDX-License-Identifier: Apache-2.0

import { isBookkeepingJob } from './openrouter.mjs';
import { prefersLocalLane } from './job-types.mjs';
import { LANE_AGENTS } from './lanes.mjs';
import {
  LOCAL_MODEL_PREFIX,
  parseLocalModel,
  localEndpointsForJob,
  createLocalEndpointPauseTracker,
  gateLocalEndpointsBeforeRoute,
  mergeLocalEndpointHealth,
} from './local-lane.mjs';

// Lanes that only ever get jobs marked `sensitive: false`. validateManifest also refuses a sensitive job
// on these; the router checks too, so a sensitive job is never even a candidate.
const NON_SENSITIVE_ONLY = Object.freeze(['openrouter', 'openai', 'gemini', 'lambda', 'rented']);

// The rented GPU lane (small fast models, one replica per GPU) takes a job only when a GPU session is running (its model is set), the job is
// not sensitive, the run has enough ready auto jobs and the job carries the full contract. One failure there sends the job to Haiku, then Codex.
export const RENTED_MIN_READY = 700;
export const RENTED_ESCALATION = Object.freeze(['rented', 'anthropic', 'codex']);
const RENTED_FIRST = Object.freeze(['rented']);
const RENTED_AFTER = Object.freeze(['anthropic', 'codex']);
const failureLimit = agent => (agent === 'rented' ? 1 : 2);
// `contract` is the manifest's shared contract file (a job-level one is lifted to the manifest); the job must have it in context.
export function rentedContractProblem(job, contract = job?.contract) {
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(job?.outputs) || !job.outputs.length) return 'name the exact output files (outputs)';
  if (!Array.isArray(job?.context) || !job.context.length) return 'name the exact files to read (context)';
  if (!text(contract) || !job.context.includes(contract)) return 'name its contract file (contract: a file that is also in context)';
  if (!Array.isArray(job.acceptance) || !job.acceptance.length || !job.acceptance.every(text)) return 'list the acceptance tests (acceptance: test files or commands that must pass)';
  return null;
}

// Code jobs: Cursor stays in the mix, then paid Anthropic (Haiku or Sonnet); Codex is paused by default in lane config.
// Hermes is not in this order: it runs only where a job type names it (research). OpenRouter runs
// only bookkeeping jobs (PR payloads, changelogs, metrics) that are not sensitive.
export const CHEAP_ORDER = Object.freeze(['cursor', 'codex', 'anthropic', 'openrouter']);
export const ROUTE_ORDER = Object.freeze([...CHEAP_ORDER, 'claude']);

const ANTHROPIC_MID_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_OPUS_MODEL = 'claude-opus-5-5';

function knownLane(agent) {
  return agent === 'local' || LANE_AGENTS.includes(agent);
}

function localConfigured(lanes, job, endpointHealth) {
  const endpoints = localEndpointsForJob(lanes, job);
  if ((lanes.local?.endpoints ?? []).length > 0) {
    return laneModel(job, 'local', lanes, {}, endpointHealth, endpoints) !== null;
  }
  return typeof lanes.local?.model === 'string';
}

function laneConfigured(agent, lanes, job, endpointHealth) {
  if (agent === 'local') return localConfigured(lanes, job, endpointHealth);
  return typeof lanes[agent]?.model === 'string';
}

function laneConfigPaused(agent, lanes) {
  return lanes[agent]?.paused === true;
}

function needsAnthropicOpus(job) {
  return job?.type === 'review' && (job.sensitive === true || job.securityReview === true || job.tier === 'expensive');
}

function needsAnthropicSonnet(job, failures = {}) {
  if (job?.type === 'review' && !needsAnthropicOpus(job)) return true;
  if (job?.type !== 'build' && job?.type !== 'fix') return false;
  if (job.risk === 'high' || job.size === 'large') return true;
  return (failures.anthropic ?? 0) >= 1;
}

const laneModel = (job, agent, lanes, failures = {}, endpointHealth = () => ({ state: 'ok' }), localEndpoints = null) => {
  if (agent === 'local') {
    const configured = lanes.local?.endpoints ?? [];
    const endpoints = localEndpoints ?? localEndpointsForJob(lanes, job);
    if (configured.length > 0) {
      if (!endpoints.length) return null;
      const wanted = parseLocalModel(job.model);
      if (wanted) {
        const exact = endpoints.find(ep => ep.name === wanted && endpointHealth(ep.name).state !== 'paused');
        return exact ? `${LOCAL_MODEL_PREFIX}${exact.name}` : null;
      }
      const pick = endpoints.find(ep => endpointHealth(ep.name).state !== 'paused');
      return pick ? `${LOCAL_MODEL_PREFIX}${pick.name}` : null;
    }
    return typeof lanes.local?.model === 'string' ? lanes.local.model : null;
  }
  if (agent === 'anthropic') {
    if (needsAnthropicOpus(job)) return ANTHROPIC_OPUS_MODEL;
    if (needsAnthropicSonnet(job, failures) || job.tier === 'mid') return ANTHROPIC_MID_MODEL;
    return lanes.anthropic.model;
  }
  if (agent === 'claude') {
    if (job.tier === 'expensive') return lanes.claude.expensiveModel ?? lanes.claude.model;
    if (job.tier === 'mid' && lanes.claude.midModel) return lanes.claude.midModel;
  }
  return lanes[agent].model;
};

function typeRouteAgents(job, lanes, endpointHealth) {
  const route = Array.isArray(job.typeRoute) ? job.typeRoute : [];
  return route.filter(agent => agent !== 'claude' && knownLane(agent) && (agent !== 'local' || laneConfigured('local', lanes, job, endpointHealth)));
}

export function routeJob(job, { lanes = {}, health = () => ({ state: 'ok' }), endpointHealth = () => ({ state: 'ok' }), failures = {}, accepts = () => true, contract, ready = 0 } = {}) {
  if (job?.agent !== 'auto') {
    const error = new Error('route-invalid: job.agent must be auto');
    error.code = 'route-invalid';
    throw error;
  }

  const configured = agent => laneConfigured(agent, lanes, job, endpointHealth);
  const accepted = agent => {
    const model = laneModel(job, agent, lanes, failures, endpointHealth);
    if (agent === 'local' && model === null) return false;
    return accepts({ ...job, agent, model }) !== false;
  };
  const minReady = Number.isFinite(lanes.rented?.minReady) ? lanes.rented.minReady : RENTED_MIN_READY;
  const useRented = configured('rented') && job.sensitive === false && ready >= minReady && rentedContractProblem(job, contract ?? job.contract) === null;
  const codexLive = configured('codex') && lanes.codex?.paused !== true;
  const hardCodex = job.hard === true && job.tier !== 'expensive' && codexLive && accepted('codex');
  const typed = typeRouteAgents(job, lanes, endpointHealth);
  const localFirst = prefersLocalLane(job) && configured('local') ? ['local'] : [];
  const cheapOrder = configured('local')
    ? ['cursor', 'codex', 'local', 'anthropic', 'openrouter']
    : [...CHEAP_ORDER];
  const order = [...new Set([...(hardCodex ? ['codex'] : []), ...(useRented ? RENTED_FIRST : []), ...localFirst, ...typed.filter(agent => !localFirst.includes(agent)), ...(useRented ? RENTED_AFTER : []), ...cheapOrder])];
  let reason = hardCodex ? 'hard ticket: codex first' : 'cheapest healthy lane';
  let candidates;
  if (job.tier === 'expensive' && job.type !== 'review') {
    reason = 'tier expensive';
    candidates = configured('claude') && !(failures.claude >= 2) && accepted('claude') ? ['claude'] : [];
  } else {
    candidates = order.filter(agent => configured(agent)
      && !laneConfigPaused(agent, lanes)
      && (agent !== 'rented' || useRented)
      && (!NON_SENSITIVE_ONLY.includes(agent) || job.sensitive === false)
      && (agent !== 'openrouter' || isBookkeepingJob(job.outputs))
      && accepted(agent));
    const failed = candidates.filter(agent => failures[agent] >= failureLimit(agent));
    if (failed.length) reason = failed.length === 1 && failed[0] === 'rented' ? 'rented lane failed once: Haiku, then Codex' : `fallback after 2 failures on ${failed.join(', ')}`;
    candidates = candidates.filter(agent => !(failures[agent] >= failureLimit(agent)));
    const totalFailures = order.reduce((sum, agent) => sum + (failures[agent] ?? 0), 0);
    if (!candidates.length && totalFailures >= 2 && configured('claude')
      && !(failures.claude >= 2) && accepted('claude')) {
      candidates = ['claude'];
      reason = `fallback after 2 failures on ${order.filter(agent => failures[agent] > 0).join(', ')}`;
    }
    if (!candidates.length && !order.some(agent => configured(agent) && !laneConfigPaused(agent, lanes)) && totalFailures === 0) {
      throw Object.assign(new Error(`route-exhausted: no cheap lane available for job ${job.id}; Claude needs 2 real failures first or tier "expensive"`), { code: 'route-exhausted' });
    }
  }
  for (const agent of candidates) {
    if (health(agent).state !== 'paused') {
      const model = laneModel(job, agent, lanes, failures, endpointHealth);
      if (agent === 'local' && model === null) continue;
      return { agent, model, reason };
    }
  }
  if (candidates.length > 0) {
    const agent = candidates[0];
    return { agent, model: laneModel(job, agent, lanes, failures, endpointHealth), reason: `${reason}; lane ${agent} paused` };
  }

  const error = new Error(`route-exhausted: no lane left for job ${job.id} (${reason})`);
  error.code = 'route-exhausted';
  throw error;
}

export async function routeJobWithLocalHealthGate(job, options = {}) {
  const {
    probeLocalEndpoints = true,
    localHealthTracker,
    fetchImpl,
    now,
    timeoutMs,
    endpointHealth: baseEndpointHealth,
    ...rest
  } = options;
  const tracker = localHealthTracker ?? createLocalEndpointPauseTracker({ now });
  if (probeLocalEndpoints && (rest.lanes?.local?.endpoints ?? []).length) {
    await gateLocalEndpointsBeforeRoute(job, rest.lanes, tracker, { fetchImpl, now, timeoutMs });
  }
  const endpointHealth = mergeLocalEndpointHealth(tracker, baseEndpointHealth);
  const route = routeJob(job, { ...rest, endpointHealth });
  return { ...route, localHealthTracker: tracker };
}
