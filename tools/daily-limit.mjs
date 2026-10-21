// SPDX-License-Identifier: Apache-2.0
import { PAID_LANES } from './spend.mjs';

export const DEFAULT_DAILY_LIMIT_USD = 5;

const MODES = new Set(['stop', 'notify']);
const CHICAGO = 'America/Chicago';
const NOTIFY_LEVEL_CAP = 3;

const chicagoFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CHICAGO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function chicagoParts(ms) {
  const parts = {};
  for (const { type, value } of chicagoFormatter.formatToParts(new Date(ms))) {
    if (type !== 'literal') parts[type] = value;
  }
  return parts;
}

export function centralDayKey(now = Date.now) {
  const ms = typeof now === 'function' ? now() : now;
  const { year, month, day } = chicagoParts(ms);
  return `${year}-${month}-${day}`;
}

export function centralMidnightAfter(now = Date.now) {
  const start = typeof now === 'function' ? now() : now;
  const today = centralDayKey(() => start);
  let lo = start;
  let hi = start + 28 * 3600 * 1000;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (centralDayKey(() => mid) === today) lo = mid;
    else hi = mid;
  }
  return hi;
}

function normalizeSettings(layer) {
  if (layer === null || layer === undefined) return null;
  if (typeof layer !== 'object' || Array.isArray(layer)) return null;
  const { usd, mode, ceilingUsd } = layer;
  const out = {};
  if (usd !== undefined) out.usd = usd;
  if (mode !== undefined) out.mode = mode;
  if (ceilingUsd !== undefined) out.ceilingUsd = ceilingUsd;
  return Object.keys(out).length ? out : null;
}

export function validateDailyLimit({ usd, mode, ceilingUsd } = {}) {
  const errors = [];
  if (usd !== undefined) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) errors.push('usd must be a positive finite number');
  }
  if (mode !== undefined) {
    if (!MODES.has(mode)) errors.push('mode must be stop or notify');
  }
  if (ceilingUsd !== undefined) {
    if (typeof ceilingUsd !== 'number' || !Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
      errors.push('ceilingUsd must be a positive finite number');
    } else if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0 && ceilingUsd < usd) {
      errors.push('ceilingUsd must be at least usd');
    }
  }
  return errors;
}

function validUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function validMode(value) {
  return MODES.has(value) ? value : null;
}

function validCeiling(value, usd) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (usd !== null && value < usd) return null;
  return value;
}

/** Coerce one settings layer; invalid fields are dropped and described in reports. */
export function sanitizeDailyLimitLayer(layer, { label = 'layer' } = {}) {
  const reports = [];
  const raw = normalizeSettings(layer);
  if (layer !== null && layer !== undefined && raw === null) {
    reports.push(`${label}: ignored (not an object)`);
    return { layer: null, reports };
  }
  if (!raw) return { layer: null, reports };

  const out = {};
  if (raw.usd !== undefined) {
    const usd = validUsd(raw.usd);
    if (usd === null) {
      reports.push(`${label}.usd: invalid, using default $${DEFAULT_DAILY_LIMIT_USD.toFixed(2)}`);
    } else out.usd = usd;
  }
  if (raw.mode !== undefined) {
    const mode = validMode(raw.mode);
    if (mode === null) {
      reports.push(`${label}.mode: invalid, using default stop`);
    } else out.mode = mode;
  }
  if (raw.ceilingUsd !== undefined) {
    const ceiling = validCeiling(raw.ceilingUsd, out.usd ?? null);
    if (ceiling === null) {
      reports.push(`${label}.ceilingUsd: invalid, using default 3× daily limit`);
    } else out.ceilingUsd = ceiling;
  }
  return { layer: Object.keys(out).length ? out : null, reports };
}

export function resolveDailyLimit({ machine = null, project = null } = {}) {
  const machineSan = sanitizeDailyLimitLayer(machine, { label: 'machine' });
  const projectSan = sanitizeDailyLimitLayer(project, { label: 'project' });
  const reports = [...machineSan.reports, ...projectSan.reports];
  const m = machineSan.layer;
  const p = projectSan.layer;

  let dailyLimitUsd = DEFAULT_DAILY_LIMIT_USD;
  let dailyLimitMode = 'stop';
  let ceilingUsd = null;
  let source = 'default';

  const touchMachine = () => { if (source === 'default') source = 'machine'; };
  const touchProject = () => { source = 'project'; };

  if (m?.usd !== undefined) { dailyLimitUsd = m.usd; touchMachine(); }
  if (m?.mode !== undefined) { dailyLimitMode = m.mode; touchMachine(); }
  if (m?.ceilingUsd !== undefined) { ceilingUsd = m.ceilingUsd; touchMachine(); }

  if (p?.usd !== undefined) { dailyLimitUsd = p.usd; touchProject(); }
  if (p?.mode !== undefined) { dailyLimitMode = p.mode; touchProject(); }
  if (p?.ceilingUsd !== undefined) { ceilingUsd = p.ceilingUsd; touchProject(); }

  if (!Number.isFinite(dailyLimitUsd) || dailyLimitUsd <= 0) {
    reports.push('resolved usd invalid, using default');
    dailyLimitUsd = DEFAULT_DAILY_LIMIT_USD;
  }
  if (!MODES.has(dailyLimitMode)) {
    reports.push('resolved mode invalid, using default stop');
    dailyLimitMode = 'stop';
  }
  const hard = ceilingUsd ?? dailyLimitUsd * 3;
  let hardCeilingUsd = Number.isFinite(hard) && hard >= dailyLimitUsd ? hard : dailyLimitUsd * 3;
  if (hardCeilingUsd !== hard) reports.push('resolved ceiling invalid, using default 3×');

  return {
    dailyLimitUsd,
    dailyLimitMode,
    hardCeilingUsd,
    source,
    reports,
  };
}

export function isPaidLane(lane) {
  return PAID_LANES.includes(lane);
}

function formatCentralReset(ms) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function notifiedHas(notifiedLevels, level) {
  return notifiedLevels.some(entry => entry === level || entry === String(level));
}

export function evaluateDailyLimit({
  settings = {},
  billedTodayUsd = 0,
  reserveUsd = 0,
  lane,
  now = Date.now,
  notifiedLevels = [],
} = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const resetsAt = centralMidnightAfter(() => nowMs);
  const resetLabel = formatCentralReset(resetsAt);

  if (!isPaidLane(lane)) {
    return {
      allow: true,
      action: 'free',
      level: 0,
      ceilingHit: false,
      reason: null,
      resetsAt,
      notify: [],
    };
  }

  const { dailyLimitUsd, dailyLimitMode, hardCeilingUsd } = resolveDailyLimit(settings);
  const billed = Number(billedTodayUsd) || 0;
  const reserve = Number(reserveUsd) || 0;
  const exposure = billed + reserve;
  const level = dailyLimitUsd > 0 ? Math.floor(billed / dailyLimitUsd) : 0;

  const notify = [];
  const notifyLevel = Math.min(level, NOTIFY_LEVEL_CAP);
  for (let l = 1; l <= notifyLevel; l++) {
    if (!notifiedHas(notifiedLevels, l)) notify.push(l);
  }

  const reasonBase = (kind) =>
    `Daily spend limit $${dailyLimitUsd.toFixed(2)} (${kind}): billed $${billed.toFixed(2)} today${reserve > 0 ? ` plus $${reserve.toFixed(2)} reserved` : ''}; resets ${resetLabel}.`;

  if (exposure >= hardCeilingUsd) {
    if (!notifiedHas(notifiedLevels, 'ceiling')) notify.push('ceiling');
    return {
      allow: false,
      action: 'ceiling',
      level,
      ceilingHit: true,
      reason: reasonBase(`hard ceiling $${hardCeilingUsd.toFixed(2)}`),
      resetsAt,
      notify,
    };
  }

  if (dailyLimitMode === 'stop' && exposure >= dailyLimitUsd) {
    return {
      allow: false,
      action: 'stop',
      level,
      ceilingHit: false,
      reason: reasonBase('stop'),
      resetsAt,
      notify,
    };
  }

  const action = dailyLimitMode === 'notify' && level >= 1 ? 'notify' : 'ok';
  return {
    allow: true,
    action,
    level,
    ceilingHit: false,
    reason: null,
    resetsAt,
    notify,
  };
}

export function dailyLimitNotice({ project, level, billedTodayUsd, settings = {}, now = Date.now }) {
  const { dailyLimitUsd, dailyLimitMode, hardCeilingUsd } = resolveDailyLimit(settings);
  const billed = Number(billedTodayUsd) || 0;
  const at = typeof now === 'function' ? now() : now;
  const label =
    level === 'ceiling'
      ? `hard ceiling $${hardCeilingUsd.toFixed(2)}`
      : `×${level} ($${(dailyLimitUsd * (typeof level === 'number' ? level : 1)).toFixed(2)})`;
  const text = `${project}: daily limit ${label}; $${billed.toFixed(2)} billed today (${dailyLimitMode}, cap $${hardCeilingUsd.toFixed(2)}).`;
  return {
    kind: 'daily-limit',
    project,
    level,
    text: text.length > 200 ? `${text.slice(0, 197)}...` : text,
    billedTodayUsd: billed,
    limitUsd: dailyLimitUsd,
    mode: dailyLimitMode,
    ceilingUsd: hardCeilingUsd,
    at,
  };
}
