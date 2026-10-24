// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import {
  createLaneCaps,
  createTuner,
  defaultLimit,
  describe,
  memoryPressureLevel,
  projectedMemoryJobCap,
  DEFAULT_JOB_MEMORY_GB,
  MEMORY_PRESSURE_FLOOR,
} from './autotune.mjs';

export {
  memoryPressureLevel,
  projectedMemoryJobCap,
  DEFAULT_JOB_MEMORY_GB,
  MEMORY_PRESSURE_FLOOR,
} from './autotune.mjs';

export const MAX_MACHINE_CONCURRENCY = 256;
/** Total wait before running node --test under sustained hard memory pressure. */
export const MEMORY_HARD_WAIT_MS = 60 * 1000;
export const MEMORY_POLL_MS = 15_000;
const TUNER_MIN = MEMORY_PRESSURE_FLOOR;
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

function jobMemoryGbFromConfig(config = {}) {
  const raw = config.jobMemoryGb ?? config.machine?.jobMemoryGb;
  if (raw === undefined || raw === '') return DEFAULT_JOB_MEMORY_GB;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_JOB_MEMORY_GB;
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

export function testConcurrencyFor(machine) {
  const level = memoryPressureLevel(machine);
  if (level === 'hard') return 1;
  if (level === 'soft') return 2;
  const cores = machine.cores ?? 1;
  return Math.min(4, Math.floor(cores / 2));
}

export function effectiveMachineLimit({ limit, machine = {}, config = {} } = {}) {
  const jobMemoryGb = jobMemoryGbFromConfig(config);
  const projectionCap = projectedMemoryJobCap(machine, jobMemoryGb);
  const pressure = memoryPressureLevel(machine);
  let effective = limit;
  if (Number.isFinite(projectionCap)) {
    effective = Math.min(effective, projectionCap > 0 ? projectionCap : MEMORY_PRESSURE_FLOOR);
  }
  if (pressure === 'hard') {
    effective = Math.min(effective, MEMORY_PRESSURE_FLOOR);
  }
  return { effective, pressure, projectionCap, jobMemoryGb };
}

export function memoryPressureHoldLine(machine) {
  const avail = machine.availRamGb ?? machine.freeRamGb ?? 0;
  const swapUsed = machine.swapUsedGb ?? 0;
  const swapTotal = machine.swapTotalGb ?? 0;
  return `held by memory pressure: ${avail.toFixed(1)} GB available, swap ${swapUsed.toFixed(1)}/${swapTotal.toFixed(1)} GB used`;
}

/**
 * How many jobs may start in this batch given resolved limit, running count, and live machine stats.
 */
export function jobStartsForBatch({
  limit,
  running = 0,
  machine = {},
  config = {},
  log = () => {},
} = {}) {
  const pressure = memoryPressureLevel(machine);
  if (pressure === 'hard') {
    log(memoryPressureHoldLine(machine));
    return { starts: 0, pressure, effectiveLimit: MEMORY_PRESSURE_FLOOR };
  }
  const { effective, projectionCap } = effectiveMachineLimit({ limit, machine, config });
  const headroom = Math.max(0, effective - running);
  return { starts: headroom, pressure, effectiveLimit: effective, projectionCap };
}

/** True when argv is a `node` invocation that runs the built-in test runner. */
export function isNodeTestCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const bin = String(argv[0]);
  const base = bin.includes('/') ? bin.slice(bin.lastIndexOf('/') + 1) : bin;
  if (base !== 'node') return false;
  return argv.includes('--test');
}

/**
 * Add or replace `--test-concurrency=N` for node --test commands only.
 */
function existingTestConcurrency(argv) {
  const idx = argv.findIndex(arg => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
  if (idx < 0) return null;
  const token = argv[idx];
  if (token.includes('=')) {
    const v = Number(token.slice(token.indexOf('=') + 1));
    return Number.isFinite(v) ? v : null;
  }
  if (idx + 1 < argv.length) {
    const v = Number(argv[idx + 1]);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

export function applyNodeTestConcurrency(argv, concurrency) {
  if (!isNodeTestCommand(argv)) return argv;
  const n = Number(concurrency);
  if (!Number.isInteger(n) || n < 1) return argv;
  const existing = existingTestConcurrency(argv);
  const target = existing != null ? Math.min(existing, n) : n;
  const next = [...argv];
  const idx = next.findIndex(arg => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='));
  if (idx >= 0) {
    if (next[idx].includes('=')) next[idx] = `--test-concurrency=${target}`;
    else if (idx + 1 < next.length) next[idx + 1] = String(target);
    else next.push(String(target));
  } else {
    next.push(`--test-concurrency=${target}`);
  }
  return next;
}

/**
 * Merge-queue / profile verify: resolve limit, read pressure, set test concurrency on node --test only.
 */
export function gateVerifyArgvWithMemory({
  argv,
  config = {},
  state = null,
  machine = {},
  env = {},
} = {}) {
  const resolved = resolveMachineLimit({ config, state, machine, env });
  const limit = resolved.limit ?? defaultLimit(machine);
  const { effective } = effectiveMachineLimit({ limit, machine, config });
  const testConcurrency = testConcurrencyFor(machine);
  void effective;
  return applyNodeTestConcurrency(argv, testConcurrency);
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
  config = {},
  now = Date.now(),
} = {}) {
  const lanes = Array.isArray(rateLimitedLanes) ? rateLimitedLanes : [];
  const baseLimit = stateLimitInBounds(state)
    ? state.limit
    : defaultLimit(machine);
  const laneCaps = laneCapsFromState(state, { now });
  for (const lane of lanes) laneCaps.onRateLimit(lane);

  const jobMemoryGb = jobMemoryGbFromConfig(config);
  const tuner = createTuner({
    limit: baseLimit,
    min: TUNER_MIN,
    max: TUNER_MAX,
    jobMemoryGb,
  });
  const pressureUnknown = machine.pressureUnknown === true;
  const { limit, reason, capped, memoryPressure, projectionCap } = tuner.tune({
    cpuPercent: machine.cpuPercent ?? 0,
    freeRamGb: machine.freeRamGb ?? machine.availRamGb ?? null,
    availRamGb: machine.availRamGb ?? machine.freeRamGb ?? null,
    swapUsedGb: machine.swapUsedGb ?? 0,
    swapTotalGb: machine.swapTotalGb ?? 0,
    inUse,
    waiting,
    rateLimitedLanes: lanes,
    pressureUnknown,
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
    memoryPressure,
    projectionCap,
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
