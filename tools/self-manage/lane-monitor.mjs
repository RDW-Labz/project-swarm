// SPDX-License-Identifier: Apache-2.0
// Lane monitor (T-0452): probes every discovered lane on a timer using free checks only.
// No model call and no POST is made here; probes are supplied by the caller and must be free checks.

import { redactSecrets } from './lane-events.mjs';

export const LANE_MONITOR_INTERVAL_MS = 120000;
export const LANE_PROBE_TIMEOUT_MS = 10000;
export const LANE_STATUSES = ['healthy', 'degraded', 'down', 'paused'];
const MIN_INTERVAL_MS = 1000;
const REASON_LIMIT = 200;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeLaneEntry(existing, source, extra) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(extra)) {
    if (value != null && value !== '') {
      merged[key] = value;
    } else if (merged[key] == null) {
      merged[key] = value;
    }
  }
  if (existing.source !== source) {
    merged.source = `${existing.source}+${source}`;
  }
  return merged;
}

/** Lanes from config.lanes, config.localEndpoints and the adapter registry, de-duplicated by id. */
export function discoverLanes({ config, registry } = {}) {
  const found = new Map();
  const add = (id, source, extra = {}) => {
    if (typeof id !== 'string' || !id) return;
    const existing = found.get(id);
    if (existing) {
      found.set(id, mergeLaneEntry(existing, source, extra));
      return;
    }
    found.set(id, { id, source, ...extra });
  };
  if (isPlainObject(config?.lanes)) {
    for (const [key, value] of Object.entries(config.lanes)) {
      add(key, 'config.lanes', {
        endpoint: typeof value?.endpoint === 'string' ? value.endpoint : null,
        cli: typeof value?.cli === 'string' ? value.cli : null,
        noCap: value?.noCap === true,
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

/** True when lastChecked is older than twice the monitor interval. */
export function isStale(entry, now = Date.now, intervalMs = LANE_MONITOR_INTERVAL_MS) {
  const checkedAt = entry?.lastChecked ? Date.parse(entry.lastChecked) : Number.NaN;
  if (Number.isNaN(checkedAt)) return true;
  const period = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || LANE_MONITOR_INTERVAL_MS);
  const nowMs = typeof now === 'function' ? now() : now;
  return nowMs - checkedAt > 2 * period;
}

/** Probe HTTP fetch wrapper: only GET is allowed. */
export function createProbeFetch(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch implementation required');
  }
  return async (url, options = {}) => {
    const method = String(options.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new Error('probe-method-not-allowed');
    }
    const { signal, ...rest } = options;
    return fetchImpl(url, { ...rest, method: 'GET', signal });
  };
}

function limitReason(reason) {
  return redactSecrets(String(reason ?? '')).slice(0, REASON_LIMIT);
}

function isPolicyProbe(name) {
  return name === 'spend-cap' || name === 'rate-limit';
}

async function runProbe(name, fn, lane, { timeoutMs }) {
  const policy = isPolicyProbe(name);
  if (typeof fn !== 'function') {
    if (policy) {
      return { ok: false, paused: true, reason: limitReason(`${name}: no probe configured`) };
    }
    return { ok: null, paused: false, reason: limitReason(`${name}: no probe configured`) };
  }
  const controller = new AbortController();
  let timer;
  const run = async () => {
    const result = await fn(lane, { signal: controller.signal });
    const ok = result?.ok === true;
    const fallback = ok ? `${name}: ok` : `${name}: failed`;
    return {
      ok,
      paused: result?.paused === true,
      reason: limitReason(result?.reason ?? fallback),
    };
  };
  try {
    const result = await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${name}: probe timeout`));
        }, timeoutMs);
      }),
    ]);
    if (policy && result.ok !== true) {
      return { ...result, paused: true };
    }
    return result;
  } catch (error) {
    const reason = limitReason(`${name}: ${String(error?.message ?? error)}`);
    if (policy) {
      return { ok: false, paused: true, reason };
    }
    return { ok: false, paused: false, reason };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function policyProbeOk(probe) {
  return probe.ok === true && probe.paused !== true;
}

/**
 * Status for one lane: { id, status, reason, lastChecked }.
 * probes: { reachable(lane), modelsList(lane), cliStatus(lane), rateLimit(lane), spendCap(lane) }, each free and returning { ok, reason?, paused? }.
 * Lane option noCap: true skips the spend-cap probe for free local lanes with no spend cap to check; lanes without noCap still pause when spend-cap is missing or failing.
 */
export async function probeLane(lane, probes = {}, { now = Date.now, probeTimeoutMs = LANE_PROBE_TIMEOUT_MS } = {}) {
  const lastChecked = new Date(typeof now === 'function' ? now() : now).toISOString();
  const id = lane.id;
  const timeoutMs = Math.max(1, Number(probeTimeoutMs) || LANE_PROBE_TIMEOUT_MS);
  const probeOpts = { timeoutMs };

  const spend = lane.noCap === true
    ? { ok: true, paused: false, reason: limitReason('spend-cap: skipped (noCap)') }
    : await runProbe('spend-cap', probes.spendCap, lane, probeOpts);
  const rate = await runProbe('rate-limit', probes.rateLimit, lane, probeOpts);
  if (!policyProbeOk(spend) || !policyProbeOk(rate)) {
    const reasons = [spend, rate].filter(p => !policyProbeOk(p)).map(p => p.reason);
    return { id, status: 'paused', reason: limitReason(reasons.join('; ')), lastChecked };
  }
  const reach = await runProbe('reachability', probes.reachable, lane, probeOpts);
  if (reach.ok === false) return { id, status: 'down', reason: reach.reason, lastChecked };
  if (reach.ok === null) return { id, status: 'degraded', reason: reach.reason, lastChecked };
  const cli = await runProbe('cli-status', probes.cliStatus, lane, probeOpts);
  if (cli.ok === false) return { id, status: 'degraded', reason: cli.reason, lastChecked };
  const models = await runProbe('models-list', probes.modelsList, lane, probeOpts);
  if (models.ok === false) return { id, status: 'degraded', reason: models.reason, lastChecked };
  const reason = models.ok === null ? 'reachable' : 'reachable and models listed';
  return { id, status: 'healthy', reason: limitReason(reason), lastChecked };
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
  probeTimeoutMs = LANE_PROBE_TIMEOUT_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const statuses = new Map();
  const period = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || LANE_MONITOR_INTERVAL_MS);
  let timer = null;
  let tickInFlight = false;
  let lastError = null;

  function snapshot() {
    return {
      lanes: [...statuses.values()].map(s => ({ ...s })).sort((a, b) => a.id.localeCompare(b.id)),
      lastError,
    };
  }

  async function tick() {
    if (tickInFlight) return snapshot();
    tickInFlight = true;
    try {
      const config = typeof loadConfig === 'function' ? await loadConfig() : {};
      const registry = typeof loadRegistry === 'function' ? await loadRegistry() : [];
      const lanes = discoverLanes({ config, registry });
      const ids = new Set(lanes.map(lane => lane.id));
      for (const id of [...statuses.keys()]) {
        if (!ids.has(id)) statuses.delete(id);
      }
      const results = await Promise.all(
        lanes.map(lane => probeLane(lane, probes, { now, probeTimeoutMs })),
      );
      for (const entry of results) {
        statuses.set(entry.id, entry);
      }
      lastError = null;
    } catch (error) {
      lastError = limitReason(String(error?.message ?? error));
    } finally {
      tickInFlight = false;
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

  return {
    tick,
    start,
    stop,
    snapshot,
    get started() { return timer !== null; },
    get running() { return tickInFlight; },
  };
}
