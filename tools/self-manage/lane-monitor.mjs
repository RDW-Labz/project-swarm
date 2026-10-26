// SPDX-License-Identifier: Apache-2.0
// Lane monitor (T-0452): probes every discovered lane on a timer using free checks only.
// No model call and no POST is made here; probes are supplied by the caller and must be free checks.

export const LANE_MONITOR_INTERVAL_MS = 120000;
export const LANE_STATUSES = ['healthy', 'degraded', 'down', 'paused'];
const MIN_INTERVAL_MS = 1000;
const REASON_LIMIT = 200;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Lanes from config.lanes, config.localEndpoints and the adapter registry, de-duplicated by id. */
export function discoverLanes({ config, registry } = {}) {
  const found = new Map();
  const add = (id, source, extra = {}) => {
    if (typeof id !== 'string' || !id || found.has(id)) return;
    found.set(id, { id, source, ...extra });
  };
  if (isPlainObject(config?.lanes)) {
    for (const [key, value] of Object.entries(config.lanes)) {
      add(key, 'config.lanes', {
        endpoint: typeof value?.endpoint === 'string' ? value.endpoint : null,
        cli: typeof value?.cli === 'string' ? value.cli : null,
      });
    }
  }
  const endpoints = config?.localEndpoints;
  const endpointList = Array.isArray(endpoints)
    ? endpoints
    : (isPlainObject(endpoints)
      ? Object.entries(endpoints).map(([name, value]) => ({ name, ...(typeof value === 'string' ? { url: value } : (value ?? {})) }))
      : []);
  for (const endpoint of endpointList) {
    if (!isPlainObject(endpoint)) continue;
    add(endpoint.name ?? endpoint.id, 'config.localEndpoints', {
      endpoint: typeof endpoint.url === 'string' ? endpoint.url : null,
      cli: null,
    });
  }
  const adapters = Array.isArray(registry)
    ? registry
    : (isPlainObject(registry) ? Object.entries(registry).map(([name, value]) => ({ name, ...(value ?? {}) })) : []);
  for (const adapter of adapters) {
    if (!isPlainObject(adapter)) continue;
    add(adapter.name ?? adapter.id, 'adapter-registry', {
      endpoint: null,
      cli: typeof adapter.cli === 'string' ? adapter.cli : null,
    });
  }
  return [...found.values()];
}

async function runProbe(name, fn, lane) {
  if (typeof fn !== 'function') return { ok: null, paused: false, reason: `${name}: no probe configured` };
  try {
    const result = await fn(lane);
    const ok = result?.ok === true;
    const fallback = ok ? `${name}: ok` : `${name}: failed`;
    return {
      ok,
      paused: result?.paused === true,
      reason: String(result?.reason ?? fallback).slice(0, REASON_LIMIT),
    };
  } catch (error) {
    return { ok: false, paused: false, reason: `${name}: ${String(error?.message ?? error).slice(0, 160)}` };
  }
}

/**
 * Status for one lane: { id, status, reason, lastChecked }.
 * probes: { reachable(lane), modelsList(lane), cliStatus(lane), rateLimit(lane), spendCap(lane) }, each free and returning { ok, reason?, paused? }.
 */
export async function probeLane(lane, probes = {}, { now = Date.now } = {}) {
  const lastChecked = new Date(now()).toISOString();
  const id = lane.id;
  const spend = await runProbe('spend-cap', probes.spendCap, lane);
  const rate = await runProbe('rate-limit', probes.rateLimit, lane);
  if (spend.paused || rate.paused) {
    const reasons = [spend, rate].filter(p => p.paused).map(p => p.reason);
    return { id, status: 'paused', reason: reasons.join('; ').slice(0, REASON_LIMIT), lastChecked };
  }
  const reach = await runProbe('reachability', probes.reachable, lane);
  if (reach.ok === false) return { id, status: 'down', reason: reach.reason, lastChecked };
  if (reach.ok === null) return { id, status: 'degraded', reason: reach.reason, lastChecked };
  const cli = await runProbe('cli-status', probes.cliStatus, lane);
  if (cli.ok === false) return { id, status: 'degraded', reason: cli.reason, lastChecked };
  const models = await runProbe('models-list', probes.modelsList, lane);
  if (models.ok === false) return { id, status: 'degraded', reason: models.reason, lastChecked };
  const reason = models.ok === null ? 'reachable' : 'reachable and models listed';
  return { id, status: 'healthy', reason, lastChecked };
}

/**
 * Timer-driven monitor. Lanes that leave the config or registry are removed from the status map.
 * A failed config or registry load keeps the previous statuses and records lastError.
 */
export function createLaneMonitor({
  loadConfig,
  loadRegistry,
  probes = {},
  now = Date.now,
  intervalMs = LANE_MONITOR_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const statuses = new Map();
  const period = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || LANE_MONITOR_INTERVAL_MS);
  let timer = null;
  let running = false;
  let lastError = null;

  function snapshot() {
    return {
      lanes: [...statuses.values()].map(s => ({ ...s })).sort((a, b) => a.id.localeCompare(b.id)),
      lastError,
    };
  }

  async function tick() {
    if (running) return snapshot();
    running = true;
    try {
      const config = typeof loadConfig === 'function' ? await loadConfig() : {};
      const registry = typeof loadRegistry === 'function' ? await loadRegistry() : [];
      const lanes = discoverLanes({ config, registry });
      const ids = new Set(lanes.map(lane => lane.id));
      for (const id of [...statuses.keys()]) {
        if (!ids.has(id)) statuses.delete(id);
      }
      for (const lane of lanes) {
        statuses.set(lane.id, await probeLane(lane, probes, { now }));
      }
      lastError = null;
    } catch (error) {
      lastError = String(error?.message ?? error).slice(0, REASON_LIMIT);
    } finally {
      running = false;
    }
    return snapshot();
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(() => { tick().catch(() => {}); }, period);
    timer?.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { tick, start, stop, snapshot, get running() { return timer !== null; } };
}
