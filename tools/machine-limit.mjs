// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import {
  createLaneCaps,
  createTuner,
  defaultLimit,
  describe,
} from './autotune.mjs';

export const MAX_MACHINE_CONCURRENCY = 256;
const TUNER_MIN = 4;
const TUNER_MAX = 64;
const STATE_VERSION = 1;

function parseEnvLimit(env) {
  const raw = env?.SWARM_MACHINE_CONCURRENCY;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MACHINE_CONCURRENCY) return null;
  return n;
}

function isAutoMode(config) {
  const value = config?.machineConcurrency;
  if (value === 'auto') return true;
  if (value === undefined && config?.machineConcurrencyAuto === true) return true;
  return false;
}

function stateLimitInBounds(state) {
  const limit = state?.limit;
  return Number.isInteger(limit) && limit >= TUNER_MIN && limit <= TUNER_MAX;
}

/** @returns {string[]} */
export function validateMachineLimitConfig(config = {}) {
  const errors = [];
  const value = config.machineConcurrency;
  if (value === undefined || value === 'auto') return errors;
  if (Number.isInteger(value) && value >= 1 && value <= MAX_MACHINE_CONCURRENCY) return errors;
  if (typeof value === 'string' || !Number.isInteger(value) || value < 1) {
    errors.push('machineConcurrency must be a positive integer or auto');
  } else if (value > MAX_MACHINE_CONCURRENCY) {
    errors.push(`machineConcurrency must be at most ${MAX_MACHINE_CONCURRENCY}`);
  } else {
    errors.push('machineConcurrency must be a positive integer or auto');
  }
  return errors;
}

export function resolveMachineLimit({ config = {}, state = null, machine = {}, env = {} } = {}) {
  const fromEnv = parseEnvLimit(env);
  if (fromEnv !== null) {
    return { limit: fromEnv, source: 'env', reason: 'env' };
  }
  const value = config.machineConcurrency;
  if (Number.isInteger(value)) {
    return { limit: value, source: 'config', reason: 'fixed' };
  }
  if (isAutoMode(config)) {
    if (state && stateLimitInBounds(state)) {
      return { limit: state.limit, source: 'auto-state', reason: 'auto-state' };
    }
    const limit = defaultLimit(machine);
    return { limit, source: 'auto-default', reason: 'auto-default' };
  }
  return { limit: null, source: 'none', reason: 'none' };
}

function validPersistedState(data) {
  return data
    && typeof data === 'object'
    && !Array.isArray(data)
    && data.version === STATE_VERSION
    && Number.isInteger(data.limit)
    && data.limit >= TUNER_MIN
    && data.limit <= TUNER_MAX;
}

export async function loadTunerState(filePath, fs) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!validPersistedState(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveTunerState(filePath, state, fs) {
  const payload = { ...state, version: STATE_VERSION };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function laneCapsFromState(state, { now }) {
  if (state?.laneCaps) {
    try {
      return createLaneCaps.fromJSON(state.laneCaps, { now: () => now });
    } catch {
      /* fall through */
    }
  }
  const initial = stateLimitInBounds(state) ? state.limit : TUNER_MAX;
  return createLaneCaps({ initial, now: () => now });
}

export function tickAutotune({
  state = null,
  machine = {},
  inUse = 0,
  waiting = 0,
  rateLimitedLanes = [],
  now = Date.now(),
} = {}) {
  const lanes = Array.isArray(rateLimitedLanes) ? rateLimitedLanes : [];
  const baseLimit = stateLimitInBounds(state)
    ? state.limit
    : defaultLimit(machine);
  const laneCaps = laneCapsFromState(state, { now });
  for (const lane of lanes) laneCaps.onRateLimit(lane);

  const tuner = createTuner({ limit: baseLimit, min: TUNER_MIN, max: TUNER_MAX });
  const { limit, reason, capped } = tuner.tune({
    cpuPercent: machine.cpuPercent ?? 0,
    freeRamGb: machine.freeRamGb ?? 0,
    inUse,
    waiting,
    rateLimitedLanes: lanes,
  });

  const nextState = {
    version: STATE_VERSION,
    limit,
    laneCaps: laneCaps.toJSON(),
  };

  return {
    state: nextState,
    limit,
    reason,
    capped,
    laneCaps,
    inUse,
    cpuPercent: machine.cpuPercent,
    freeRamGb: machine.freeRamGb,
  };
}

export function boardLine(result) {
  return describe({
    limit: result.limit,
    inUse: result.inUse ?? 0,
    capped: result.capped ?? 'none',
    cpuPercent: result.cpuPercent ?? 0,
    freeRamGb: result.freeRamGb ?? 0,
  });
}
