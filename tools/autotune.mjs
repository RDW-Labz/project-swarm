// SPDX-License-Identifier: Apache-2.0
import nodeOs from 'node:os';
import path from 'node:path';
import { resolveConfigPath } from './local-config.mjs';

const GB = 1024 ** 3;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Hardware-derived ceiling before the live tuner runs. */
export function defaultLimit({ cores, freeRamGb, totalRamGb }) {
  void totalRamGb;
  const byCores = cores * 2;
  const byRam = Math.floor((freeRamGb - 4) / 0.5);
  const raw = Math.min(byCores, byRam);
  return Math.min(64, Math.max(4, raw));
}

function idleFromCpus(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/** Two `os.cpus()` samples; pass `measureCpu` in tests to avoid sleeping. */
export async function readMachine({
  os = nodeOs,
  now = () => Date.now(),
  delayMs = 100,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  measureCpu = null,
} = {}) {
  const cores = os.cpus().length;
  const freeRamGb = os.freemem() / GB;
  const totalRamGb = os.totalmem() / GB;
  let cpuPercent;
  if (measureCpu) {
    cpuPercent = await measureCpu(os, now);
  } else {
    const a = idleFromCpus(os.cpus());
    await wait(delayMs);
    const b = idleFromCpus(os.cpus());
    const idleDelta = b.idle - a.idle;
    const totalDelta = b.total - a.total;
    cpuPercent = totalDelta > 0
      ? Math.min(100, Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100)))
      : 0;
  }
  return { cores, freeRamGb, totalRamGb, cpuPercent };
}

function stressReason({ cpuPercent, freeRamGb, rateLimitedLanes }) {
  if (cpuPercent >= 80) return 'cpu';
  if (freeRamGb <= 4) return 'ram';
  if (rateLimitedLanes?.length > 0) return 'lane-rate-limit';
  return null;
}

function cappedNow({ cpuPercent, freeRamGb, rateLimitedLanes, waiting, limit, max }) {
  const stress = stressReason({ cpuPercent, freeRamGb, rateLimitedLanes });
  if (stress) return stress;
  if (waiting <= 0) return 'no-ready-tickets';
  if (limit >= max) return 'none';
  return 'none';
}

export function createTuner({
  limit: initialLimit,
  min = 4,
  max = 64,
  stepUp = 1,
  backoffFactor = 0.75,
  now = () => Date.now(),
} = {}) {
  let limit = initialLimit;
  void now;

  function tune({ cpuPercent, freeRamGb, inUse, waiting, rateLimitedLanes = [] }) {
    void inUse;
    const lanes = Array.isArray(rateLimitedLanes) ? rateLimitedLanes : [];
    const stress = stressReason({ cpuPercent, freeRamGb, rateLimitedLanes: lanes });
    let reason = 'none';
    let next = limit;

    if (stress) {
      next = Math.max(min, Math.floor(limit * backoffFactor));
      reason = stress;
    } else if (cpuPercent < 80 && freeRamGb > 4 && waiting > 0 && limit < max) {
      next = Math.min(max, limit + stepUp);
      reason = 'none';
    } else if (waiting <= 0) {
      reason = 'no-ready-tickets';
    }

    limit = next;
    const capped = cappedNow({
      cpuPercent,
      freeRamGb,
      rateLimitedLanes: lanes,
      waiting,
      limit,
      max,
    });
    return { limit, reason, capped };
  }

  return { tune, get limit() { return limit; } };
}

export function createLaneCaps({ initial, min = 1, now = () => Date.now(), lanes: seeded = null } = {}) {
  const lanes = seeded ? structuredClone(seeded) : {};

  function ensure(lane) {
    if (!lanes[lane]) {
      lanes[lane] = {
        initial,
        cap: initial,
        heldUntil: 0,
        cleanSince: 0,
      };
    }
    return lanes[lane];
  }

  function onRateLimit(lane) {
    const rec = ensure(lane);
    rec.cap = Math.max(min, Math.floor(rec.cap * 0.75));
    rec.heldUntil = now() + TEN_MINUTES_MS;
    rec.cleanSince = 0;
  }

  function onClean(lane) {
    const rec = ensure(lane);
    const t = now();
    if (t < rec.heldUntil) return;
    if (!rec.cleanSince) rec.cleanSince = rec.heldUntil;
    if (t - rec.cleanSince < TEN_MINUTES_MS) return;
    rec.cap = Math.min(rec.initial, rec.cap + 1);
    rec.cleanSince += TEN_MINUTES_MS;
  }

  function cap(lane) {
    return ensure(lane).cap;
  }

  function toJSON() {
    return { version: 1, initial, min, lanes };
  }

  return {
    onRateLimit,
    onClean,
    cap,
    toJSON,
  };
}

createLaneCaps.fromJSON = function fromJSON(data, { now = () => Date.now() } = {}) {
  if (!data || typeof data !== 'object') throw new Error('invalid lane caps state');
  const { initial, min = 1, lanes: saved = {} } = data;
  return createLaneCaps({ initial, min, now, lanes: saved });
};

export function stateFilePath(env, home) {
  const configFile = resolveConfigPath({ env, home });
  return path.join(path.dirname(configFile), 'autotune-state.json');
}

const CAPPED_PHRASE = {
  cpu: (s) => `capped by CPU ${s.cpuPercent} percent`,
  ram: (s) => `capped by RAM ${s.freeRamGb} GB free`,
  'lane-rate-limit': () => 'capped by lane rate limit',
  'no-ready-tickets': () => 'capped by no ready tickets',
  none: () => 'not capped',
};

export function describe(state) {
  const { limit, inUse, capped = 'none' } = state;
  const phrase = (CAPPED_PHRASE[capped] ?? CAPPED_PHRASE.none)(state);
  return `limit ${limit}, in use ${inUse}, ${phrase}`;
}
