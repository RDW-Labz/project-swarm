// SPDX-License-Identifier: Apache-2.0

const VALID_STATES = new Set(['healthy', 'degraded', 'down', 'paused']);
const DEFAULT_PROBE_MS = 3000;

/** @type {Map<string, { name: string, kind: string, health: Function }>} */
const registry = new Map();

export function registerLaneAdapter(adapter) {
  const problems = validateLaneAdapter(adapter);
  if (problems.length) {
    throw Object.assign(new Error(`lane-adapter-invalid: ${problems.join('; ')}`), { code: 'lane-adapter-invalid', problems });
  }
  registry.set(adapter.name, { name: adapter.name, kind: adapter.kind, health: adapter.health });
}

export function listLaneAdapters() {
  return [...registry.values()];
}

export function getLaneAdapter(name) {
  return registry.get(name) ?? null;
}

export function validateLaneAdapter(adapter) {
  const problems = [];
  if (!adapter || typeof adapter !== 'object') {
    problems.push('adapter must be an object');
    return problems;
  }
  if (typeof adapter.name !== 'string' || !adapter.name.trim()) problems.push('missing name');
  if (typeof adapter.kind !== 'string' || !adapter.kind.trim()) problems.push('missing kind');
  if (typeof adapter.health !== 'function') problems.push('missing health function');
  return problems;
}

function modelsUrl(baseUrl) {
  const base = String(baseUrl).replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

function laneConfigFor(config, lane) {
  if (typeof lane === 'string' && lane.startsWith('local:')) {
    const name = lane.slice('local:'.length);
    const endpoints = config?.lanes?.local?.endpoints;
    if (!Array.isArray(endpoints)) return null;
    return endpoints.find(ep => ep?.name === name) ?? null;
  }
  return config?.lanes?.[lane] ?? null;
}

function jobFailureStreak(lastResult) {
  if (!lastResult || typeof lastResult !== 'object') return 0;
  if (Number.isInteger(lastResult.consecutiveBad) && lastResult.consecutiveBad >= 0) {
    return lastResult.consecutiveBad;
  }
  return lastResult.ok === false ? 1 : 0;
}

async function probeBaseUrl(baseUrl, fetchImpl, timeoutMs) {
  const url = modelsUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal });
    await response.body?.cancel?.();
    if (response.ok) return { reachable: true };
    if (response.status === 401 || response.status === 403) return { reachable: true };
    return { reachable: false, httpStatus: response.status };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCommand(command, execImpl, timeoutMs) {
  try {
    await execImpl(command, ['--version'], { timeout: timeoutMs });
    return { reachable: true };
  } catch {
    return { reachable: false };
  }
}

/**
 * Default health: GET /v1/models or CLI --version (3s), plus recent job outcomes on the lane.
 */
export async function defaultLaneHealth({
  lane,
  config = {},
  env = {},
  exec,
  fetch,
  now = Date.now,
  lastResult = null,
} = {}) {
  const laneCfg = laneConfigFor(config, lane);
  const baseUrl = laneCfg?.baseUrl;
  const command = laneCfg?.command;

  if (!baseUrl && !command) {
    return { state: 'paused', reason: 'no health check configured' };
  }

  const fetchImpl = fetch ?? globalThis.fetch;
  const execImpl = exec;
  const timeoutMs = DEFAULT_PROBE_MS;

  let reachable = false;
  if (baseUrl) {
    const probe = await probeBaseUrl(baseUrl, fetchImpl, timeoutMs);
    reachable = probe.reachable === true;
  } else if (command && execImpl) {
    const probe = await probeCommand(command, execImpl, timeoutMs);
    reachable = probe.reachable === true;
  }

  if (!reachable) {
    return { state: 'down', reason: 'health check failed' };
  }

  const fails = jobFailureStreak(lastResult);
  if (fails >= 2) return { state: 'down', reason: 'two consecutive job failures' };
  if (fails === 1 || lastResult?.ok === false) {
    return { state: 'degraded', reason: 'last job failed' };
  }

  return { state: 'healthy', reason: 'reachable' };
}

function validateHealthResult(result) {
  const problems = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    problems.push('health must return an object');
    return problems;
  }
  if (!VALID_STATES.has(result.state)) problems.push('health state must be healthy|degraded|down|paused');
  if (typeof result.reason !== 'string') problems.push('health reason must be a string');
  if (result.detail !== undefined && (result.detail === null || typeof result.detail !== 'object' || Array.isArray(result.detail))) {
    problems.push('health detail must be an object when present');
  }
  return problems;
}

export async function runLaneHealthCheck({
  lane,
  config,
  env,
  exec,
  fetch,
  now,
  lastResult,
  adapters = listLaneAdapters(),
} = {}) {
  const adapter = adapters.find(item => item.name === lane) ?? getLaneAdapter(lane);
  const healthFn = adapter?.health ?? defaultLaneHealth;
  const result = await healthFn({ lane, config, env, exec, fetch, now, lastResult });
  const shapeProblems = validateHealthResult(result);
  if (shapeProblems.length) {
    return { state: 'down', reason: `invalid health result: ${shapeProblems.join('; ')}` };
  }
  return result;
}

/**
 * Every config lane key, each local endpoint as local:<name>, and each registered adapter name.
 */
export function discoverLanes({ config = {}, adapters = listLaneAdapters() } = {}) {
  const names = new Set();
  const lanes = config?.lanes;
  if (lanes && typeof lanes === 'object' && !Array.isArray(lanes)) {
    for (const key of Object.keys(lanes)) {
      names.add(key);
      if (key === 'local') {
        const endpoints = lanes.local?.endpoints;
        if (Array.isArray(endpoints)) {
          for (const ep of endpoints) {
            if (ep && typeof ep.name === 'string' && ep.name) names.add(`local:${ep.name}`);
          }
        }
      }
    }
  }
  for (const adapter of adapters) {
    if (adapter?.name) names.add(adapter.name);
  }
  return [...names].sort();
}

export { validateHealthResult, laneConfigFor, DEFAULT_PROBE_MS };
