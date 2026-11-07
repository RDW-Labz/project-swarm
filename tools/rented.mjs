// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadLocalConfig, resolveConfigPath } from './local-config.mjs';
import { assertPaidLaneNotPaused } from './paid-lane-pause.mjs';

export const RENTED_DEFAULTS = Object.freeze({ maxHoursPerRun: 4, concurrency: 32, minBillableMinutes: 1, warnAt: 0.8, keyItem: Object.freeze({ service: 'project-swarm', account: 'rented.api_key' }) });

const KEYS = new Set(['name', 'endpoint', 'endpoints', 'auth', 'model', 'keyItem', 'hourlyUsd', 'maxHoursPerRun', 'concurrency', 'dailyUsd', 'trusted', 'bestOf', 'sessionKey']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const plainText = (s) => typeof s === 'string' && s.length > 0 && s.length <= 80 && !/[\u0000-\u001f\u007f]/.test(s);

export function validateRentedConfig(raw, { allowSession = false } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, errors: ['rentedGpu: must be an object'] };
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) errors.push(`rentedGpu.${k}: unknown key`);
  // A session key lives only in the 0600 session file; the machine config may not hold one.
  if (!allowSession && (raw.auth === 'session' || raw.sessionKey !== undefined)) errors.push('rentedGpu.auth session and sessionKey are set only by a running GPU session, never in the config');

  // One endpoint, or a list (one vLLM replica per GPU, reached through ssh tunnels); jobs are spread across them.
  const given = raw.endpoints === undefined ? [raw.endpoint] : raw.endpoints;
  const origins = [];
  if (raw.endpoints !== undefined && (!Array.isArray(raw.endpoints) || raw.endpoints.length < 1 || raw.endpoints.length > 16)) errors.push('rentedGpu.endpoints: must be a list of 1 to 16 URLs');
  else for (const item of given) {
    if (typeof item !== 'string') { errors.push('rentedGpu.endpoint: must be a URL string'); break; }
    try {
      const u = new URL(item);
      const hostOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
      if (!hostOk) errors.push('rentedGpu.endpoint: must be https (http only for loopback)');
      else if (u.username || u.password || u.search || u.hash) errors.push('rentedGpu.endpoint: must not contain credentials, query or hash');
      else if (u.pathname !== '/' && u.pathname !== '/v1') errors.push('rentedGpu.endpoint: path must be / or /v1');
      else origins.push(u.origin);
    } catch {
      errors.push('rentedGpu.endpoint: must be a valid URL');
    }
  }
  const auth = raw.auth ?? 'key';
  if (!['key', 'none', 'session'].includes(auth)) errors.push('rentedGpu.auth: must be "key", "none" or "session"');
  else if (auth !== 'key' && origins.some(origin => !LOOPBACK.has(new URL(origin).hostname))) errors.push('rentedGpu.auth none or session: only for loopback endpoints (an ssh tunnel)');
  if (auth === 'session' && !/^[0-9a-f]{48}$/.test(raw.sessionKey ?? '')) errors.push('rentedGpu.sessionKey: auth session needs the 48-character key of the running GPU session');
  const origin = origins[0] ?? null;

  if (typeof raw.model !== 'string' || !MODEL_RE.test(raw.model)) errors.push('rentedGpu.model: invalid model id');

  const hourlyUsd = raw.hourlyUsd;
  if (!(isNum(hourlyUsd) && hourlyUsd > 0 && hourlyUsd <= 1000)) errors.push('rentedGpu.hourlyUsd: must be a number above 0 and at most 1000');

  const maxHoursPerRun = raw.maxHoursPerRun ?? RENTED_DEFAULTS.maxHoursPerRun;
  if (!(isNum(maxHoursPerRun) && maxHoursPerRun > 0 && maxHoursPerRun <= 168)) errors.push('rentedGpu.maxHoursPerRun: must be a number above 0 and at most 168');

  const concurrency = raw.concurrency ?? RENTED_DEFAULTS.concurrency;
  if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 2048)) errors.push('rentedGpu.concurrency: must be an integer from 1 to 2048');

  let dailyUsd = raw.dailyUsd;
  if (dailyUsd === undefined) dailyUsd = isNum(hourlyUsd) && isNum(maxHoursPerRun) ? r2(hourlyUsd * maxHoursPerRun) : undefined;
  if (!(isNum(dailyUsd) && dailyUsd > 0)) errors.push('rentedGpu.dailyUsd: must be a number above 0');

  const bestOf = raw.bestOf ?? 1;
  if (!(Number.isInteger(bestOf) && bestOf >= 1 && bestOf <= 8)) errors.push('rentedGpu.bestOf: must be a whole number from 1 to 8');

  // Rented hosts only ever run jobs marked sensitive:false; there is no way to trust one.
  if (raw.trusted !== undefined && raw.trusted !== false) errors.push('rentedGpu.trusted: not supported; rented hosts only run jobs marked sensitive: false');

  const name = raw.name ?? 'rented';
  if (typeof name !== 'string' || !NAME_RE.test(name)) errors.push('rentedGpu.name: at most 40 characters of [A-Za-z0-9 ._-]');

  const keyItem = raw.keyItem ?? RENTED_DEFAULTS.keyItem;
  if (!keyItem || typeof keyItem !== 'object' || Array.isArray(keyItem) || !plainText(keyItem.service) || !plainText(keyItem.account)) {
    errors.push('rentedGpu.keyItem: needs non-empty service and account (max 80 characters, no control characters)');
  }

  if (errors.length) return { config: null, errors };
  return {
    config: {
      name,
      endpoint: origin,
      model: raw.model,
      keyItem: { service: keyItem.service, account: keyItem.account },
      hourlyUsd,
      maxHoursPerRun,
      concurrency,
      dailyUsd,
      auth,
      sessionKey: auth === 'session' ? raw.sessionKey : null,
      bestOf,
      endpoints: origins,
      chatUrls: origins.map(item => `${item}/v1/chat/completions`),
      chatUrl: `${origin}/v1/chat/completions`,
      modelsUrl: `${origin}/v1/models`,
      adaptive: { start: Math.min(4, concurrency), min: 1 },
    },
    errors: [],
  };
}

export function createRentalMeter({ hourlyUsd, maxHours, minBillableMinutes = RENTED_DEFAULTS.minBillableMinutes, now = Date.now } = {}) {
  let startMs = null;
  let endMs = null;
  const elapsedHours = () => {
    if (startMs === null) return 0;
    const end = endMs ?? now();
    return Math.max(0, (end - startMs) / 3600000);
  };
  const usd = () => {
    if (startMs === null) return 0;
    return r4(hourlyUsd * Math.max(elapsedHours(), minBillableMinutes / 60));
  };
  return {
    open() { if (startMs === null) startMs = now(); },
    close() { if (startMs !== null && endMs === null) endMs = now(); },
    isOpen() { return startMs !== null && endMs === null; },
    usd,
    hours() { return elapsedHours(); },
    snapshot() {
      return {
        open: startMs !== null && endMs === null,
        startedAt: startMs === null ? null : new Date(startMs).toISOString(),
        endedAt: endMs === null ? null : new Date(endMs).toISOString(),
        hours: elapsedHours(),
        usd: usd(),
      };
    },
  };
}

export function rentalDecision({ meter, config, budget, runUsd, laneTodayUsd, warnAt = RENTED_DEFAULTS.warnAt }) {
  const maxUsd = budget?.maxUsd;
  if (maxUsd === null || maxUsd === undefined) {
    return { decision: { reason: 'run-cap', message: 'spend-cap: the rented lane needs a run USD cap (--max-usd)', spent: 0, cap: null }, warning: null };
  }
  const rental = meter.usd();
  const hours = meter.hours();
  const dailyUsd = budget?.lanes?.rented?.dailyUsd ?? config.dailyUsd;
  const runSpent = runUsd + rental;
  const laneSpent = laneTodayUsd + rental;

  if (hours >= config.maxHoursPerRun) {
    return { decision: { reason: 'rental-hours', message: `spend-cap: rented lane open for ${hours.toFixed(2)} of ${config.maxHoursPerRun} hours (maxHoursPerRun)`, spent: hours, cap: config.maxHoursPerRun }, warning: null };
  }
  if (runSpent >= maxUsd) {
    return { decision: { reason: 'run-cap', message: `spend-cap: run spent $${runSpent.toFixed(2)} >= maxUsd $${maxUsd.toFixed(2)}`, spent: runSpent, cap: maxUsd }, warning: null };
  }
  if (laneSpent >= dailyUsd) {
    return { decision: { reason: 'lane-cap', message: `spend-cap: lane rented spent $${laneSpent.toFixed(2)} today >= dailyUsd $${dailyUsd.toFixed(2)}`, spent: laneSpent, cap: dailyUsd }, warning: null };
  }

  const ratios = [
    { r: runSpent / maxUsd, label: 'run cap', detail: `$${runSpent.toFixed(2)} of $${maxUsd.toFixed(2)}` },
    { r: laneSpent / dailyUsd, label: 'lane day cap', detail: `$${laneSpent.toFixed(2)} of $${dailyUsd.toFixed(2)}` },
    { r: hours / config.maxHoursPerRun, label: 'hours limit', detail: `${hours.toFixed(2)} of ${config.maxHoursPerRun} h` },
  ];
  const top = ratios.reduce((a, b) => (b.r > a.r ? b : a));
  const warning = top.r >= warnAt ? `rented lane at ${Math.floor(top.r * 100)}% of the ${top.label} (${top.detail})` : null;
  return { decision: null, warning };
}

export function rentedSensitiveOk(config, job) {
  if (!config) return false;
  return Boolean(job) && job.sensitive === false;
}

export function formatRentalSummary(meter, config) {
  const snap = meter.snapshot();
  if (!snap.startedAt) return `rented ${config.name}: not used`;
  return `rented ${config.name}: ${snap.hours.toFixed(2)} h, $${snap.usd.toFixed(2)} (limit ${config.maxHoursPerRun} h)`;
}

// The rented server's API key: SWARM_RENTED_API_KEY, else the Keychain item named in the config (macOS), else null.
export function readRentedKey(env = process.env, keyItem = RENTED_DEFAULTS.keyItem, { platform = process.platform, exec = execFileSync, config, loadConfig = loadLocalConfig, home } = {}) {
  const resolvedConfig = config ?? loadConfig({ env, home: home ?? env?.HOME });
  assertPaidLaneNotPaused('rented', resolvedConfig);
  const fromEnv = env.SWARM_RENTED_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length) return fromEnv;
  if (env.SWARM_RENTED_NO_KEYCHAIN === '1' || platform !== 'darwin') return null;
  try {
    const out = exec('/usr/bin/security', ['find-generic-password', '-s', keyItem.service, '-a', keyItem.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const key = String(out).trim();
    return key.length ? key : null;
  } catch { return null; }
}

// The running GPU session (written by `swarm gpu up`, removed by `swarm gpu down`) sits next to the machine config.
export function gpuSessionPath(env = process.env) { return path.join(path.dirname(resolveConfigPath({ env })), 'gpu-session.json'); }

export function readGpuSession(env = process.env, { now = Date.now } = {}) {
  try {
    const session = JSON.parse(fs.readFileSync(gpuSessionPath(env), 'utf8'));
    if (!session || !Array.isArray(session.endpoints) || !session.endpoints.length || typeof session.model !== 'string') return null;
    // A missing or unreadable expiry counts as expired: a session must always have an end.
    if (typeof session.expiresAt !== 'string' || !(Date.parse(session.expiresAt) > now())) return null;
    // A session that is still starting (or failed to) is not usable; sessions from before this field existed count as up.
    if (session.state !== undefined && session.state !== 'up') return null;
    return session;
  } catch { return null; }
}

// The machine config's rentedGpu block with the running session laid over it: the session names the replicas, the model, the
// price and the hours; it has no key (the servers listen only on the node's loopback, reached through the ssh tunnel).
export function effectiveRentedRaw(raw, env = process.env, { now = Date.now } = {}) {
  const session = readGpuSession(env, { now });
  if (!session) return { raw, session: null };
  const hours = Number.isFinite(session.maxHours) ? session.maxHours : RENTED_DEFAULTS.maxHoursPerRun;
  // A session made by this version carries a random per-rental API key; an older one has none.
  const sessionAuth = typeof session.apiKey === 'string' ? { auth: 'session', sessionKey: session.apiKey } : { auth: 'none' };
  const merged = { ...(raw ?? {}), endpoints: session.endpoints, ...sessionAuth, model: session.model, hourlyUsd: session.hourlyUsd, maxHoursPerRun: raw?.maxHoursPerRun === undefined ? hours : Math.min(raw.maxHoursPerRun, hours), concurrency: Math.min(2048, session.endpoints.length * (session.perReplica ?? 32)) };
  delete merged.endpoint; delete merged.dailyUsd;
  if (Number.isInteger(session.bestOf)) merged.bestOf = session.bestOf;
  if (Number.isFinite(session.capUsd)) merged.dailyUsd = session.capUsd;
  return { raw: merged, session };
}

// The machine config's rentedGpu block, validated: { config, errors } (config null when absent or invalid).
export function loadRentedConfig(env = process.env) {
  let raw;
  try { raw = loadLocalConfig({ env }).rentedGpu; } catch { raw = undefined; }
  const { raw: effective } = effectiveRentedRaw(raw, env);
  if (effective === undefined) return { config: null, errors: [] };
  return validateRentedConfig(effective, { allowSession: effective !== raw });
}

// --- load balancing across replicas ---------------------------------------------------------------------------------
const balancers = new Map();
export function createBalancer(urls, { now = Date.now, cooldownMs = 30000 } = {}) {
  const state = urls.map(url => ({ url, inflight: 0, badUntil: 0 }));
  let turn = 0;
  return {
    // The healthy replica with the fewest requests in flight (a recently failed one only when none is healthy), skipping `tried`.
    acquire(tried = new Set()) {
      const open = state.filter(item => !tried.has(item.url));
      const healthy = open.filter(item => item.badUntil <= now());
      const pool = healthy.length ? healthy : open;
      if (!pool.length) return null;
      const least = Math.min(...pool.map(item => item.inflight));
      const tied = pool.filter(item => item.inflight === least);
      const pick = tied[turn++ % tied.length];
      pick.inflight += 1;
      let released = false;
      return { url: pick.url, release(ok) { if (released) return; released = true; pick.inflight -= 1; pick.badUntil = ok ? 0 : now() + cooldownMs; } };
    },
    snapshot: () => state.map(item => ({ url: item.url, inflight: item.inflight, healthy: item.badUntil <= now() })),
  };
}
export function balancerFor(urls, options) {
  const key = urls.join('|');
  if (!balancers.has(key)) balancers.set(key, createBalancer(urls, options));
  return balancers.get(key);
}
// One request, sent to the least busy healthy replica; a replica that cannot be reached is skipped (for 30 s) and the next one tried.
export async function balancedFetch(urls, fetchImpl, init, options = {}) {
  const balancer = options.balancer ?? balancerFor(urls, options);
  const tried = new Set();
  let last;
  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const slot = balancer.acquire(tried);
    if (!slot) break;
    tried.add(slot.url);
    try {
      const response = await fetchImpl(slot.url, init);
      slot.release(response.status < 500);
      return response;
    } catch (error) {
      // A local abort (the job's own timeout) says nothing about the replica; only connection failures move on to another one (a
      // request that was already sent is not repeated: the GPU would do the work twice).
      if (init?.signal?.aborted) { slot.release(true); throw error; }
      slot.release(false);
      last = error;
      const code = error?.cause?.code ?? error?.code;
      if (code !== undefined && !['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) throw error;
    }
  }
  throw last ?? new Error('no replica available');
}
