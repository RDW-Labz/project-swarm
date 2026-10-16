// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { loadLocalConfig } from './local-config.mjs';

export const RENTED_DEFAULTS = Object.freeze({ maxHoursPerRun: 4, concurrency: 32, minBillableMinutes: 1, warnAt: 0.8, trusted: false, keyItem: Object.freeze({ service: 'project-swarm', account: 'rented.api_key' }) });

const KEYS = new Set(['name', 'endpoint', 'model', 'keyItem', 'hourlyUsd', 'maxHoursPerRun', 'concurrency', 'dailyUsd', 'trusted']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,40}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const plainText = (s) => typeof s === 'string' && s.length > 0 && s.length <= 80 && !/[\u0000-\u001f\u007f]/.test(s);

export function validateRentedConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, errors: ['rentedGpu: must be an object'] };
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) errors.push(`rentedGpu.${k}: unknown key`);

  let origin = null;
  if (typeof raw.endpoint !== 'string') errors.push('rentedGpu.endpoint: must be a URL string');
  else {
    try {
      const u = new URL(raw.endpoint);
      const hostOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
      if (!hostOk) errors.push('rentedGpu.endpoint: must be https (http only for loopback)');
      else if (u.username || u.password || u.search || u.hash) errors.push('rentedGpu.endpoint: must not contain credentials, query or hash');
      else if (u.pathname !== '/' && u.pathname !== '/v1') errors.push('rentedGpu.endpoint: path must be / or /v1');
      else origin = u.origin;
    } catch {
      errors.push('rentedGpu.endpoint: must be a valid URL');
    }
  }

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

  const trusted = raw.trusted === undefined ? RENTED_DEFAULTS.trusted : raw.trusted;
  if (typeof trusted !== 'boolean') errors.push('rentedGpu.trusted: must be a boolean');

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
      trusted,
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
  if (job && job.sensitive === false) return true;
  return config.trusted === true;
}

export function formatRentalSummary(meter, config) {
  const snap = meter.snapshot();
  if (!snap.startedAt) return `rented ${config.name}: not used`;
  return `rented ${config.name}: ${snap.hours.toFixed(2)} h, $${snap.usd.toFixed(2)} (limit ${config.maxHoursPerRun} h)`;
}

// The rented server's API key: SWARM_RENTED_API_KEY, else the Keychain item named in the config (macOS), else null.
export function readRentedKey(env = process.env, keyItem = RENTED_DEFAULTS.keyItem, { platform = process.platform, exec = execFileSync } = {}) {
  const fromEnv = env.SWARM_RENTED_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.length) return fromEnv;
  if (env.SWARM_RENTED_NO_KEYCHAIN === '1' || platform !== 'darwin') return null;
  try {
    const out = exec('/usr/bin/security', ['find-generic-password', '-s', keyItem.service, '-a', keyItem.account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const key = String(out).trim();
    return key.length ? key : null;
  } catch { return null; }
}

// The machine config's rentedGpu block, validated: { config, errors } (config null when absent or invalid).
export function loadRentedConfig(env = process.env) {
  let raw;
  try { raw = loadLocalConfig({ env }).rentedGpu; } catch { raw = undefined; }
  if (raw === undefined) return { config: null, errors: [] };
  return validateRentedConfig(raw);
}
