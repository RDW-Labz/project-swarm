// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import nodeOs from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveConfigPath } from './local-config.mjs';

const execFileAsync = promisify(execFile);
const MEMORY_EXEC_TIMEOUT_MS = 2000;
export const DARWIN_VM_STAT_PATH = '/usr/bin/vm_stat';
export const DARWIN_SYSCTL_PATH = '/usr/sbin/sysctl';

export const DARWIN_MEMORY_PROBE_UNKNOWN_WARNING =
  'darwin memory probe failed; treating pressure as unknown';

/** Production memory probe: fixed argv, no shell. Injectable `exec` overrides for tests. */
export async function defaultMemoryExec(cmd, args = []) {
  if (cmd === 'vm_stat') {
    const { stdout } = await execFileAsync(DARWIN_VM_STAT_PATH, [], { timeout: MEMORY_EXEC_TIMEOUT_MS });
    return stdout;
  }
  if (cmd === 'sysctl') {
    const sysctlArgs = args.length ? args : ['-n', 'vm.swapusage'];
    const { stdout } = await execFileAsync(DARWIN_SYSCTL_PATH, sysctlArgs, { timeout: MEMORY_EXEC_TIMEOUT_MS });
    return stdout;
  }
  if (cmd === 'read' && args[0] === '/proc/meminfo') {
    return fs.readFile('/proc/meminfo', 'utf8');
  }
  throw new Error(`unsupported memory exec: ${cmd}`);
}

const GB = 1024 ** 3;
const TEN_MINUTES_MS = 10 * 60 * 1000;
export const MEMORY_PRESSURE_FLOOR = 2;
export const DEFAULT_JOB_MEMORY_GB = 0.6;

/** Hardware-derived ceiling before the live tuner runs. */
export function defaultLimit({ cores, freeRamGb, totalRamGb }) {
  void totalRamGb;
  const byCores = cores * 2;
  const byRam = Math.floor((freeRamGb - 4) / 0.5);
  const raw = Math.min(byCores, byRam);
  return Math.min(64, Math.max(4, raw));
}

function pageCountFromVmStatLine(line) {
  const m = line.match(/:\s+([\d,]+)/);
  if (!m) return 0;
  return Number(m[1].replace(/,/g, ''));
}

/** @returns {{ availRamGb: number, swapUsedGb: number, swapTotalGb: number } | null} */
export function parseDarwinVmStatAndSwap(vmStatText, swapText) {
  const pageMatch = vmStatText.match(/page size of (\d+) bytes/i);
  if (!pageMatch) return null;
  const pageSize = Number(pageMatch[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const lines = vmStatText.split('\n');
  let free = 0;
  let inactive = 0;
  let speculative = 0;
  let purgeable = 0;
  for (const line of lines) {
    if (line.startsWith('Pages free')) free = pageCountFromVmStatLine(line);
    else if (line.startsWith('Pages inactive')) inactive = pageCountFromVmStatLine(line);
    else if (line.startsWith('Pages speculative')) speculative = pageCountFromVmStatLine(line);
    else if (line.startsWith('Pages purgeable')) purgeable = pageCountFromVmStatLine(line);
  }

  const availBytes = (free + inactive + speculative + purgeable) * pageSize;

  const swapMatch = swapText.match(
    /total\s*=\s*([\d.]+)([MG])\s+used\s*=\s*([\d.]+)([MG])\s+free\s*=\s*([\d.]+)([MG])/i,
  );
  if (!swapMatch) {
    return { availRamGb: availBytes / GB, swapUsedGb: 0, swapTotalGb: 0 };
  }
  const toGb = (value, unit) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (unit.toUpperCase() === 'G') return n;
    return n / 1024;
  };
  const swapTotalGb = toGb(swapMatch[1], swapMatch[2]);
  const swapUsedGb = toGb(swapMatch[3], swapMatch[4]);
  return { availRamGb: availBytes / GB, swapUsedGb, swapTotalGb };
}

function meminfoKb(text, key) {
  const re = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

/** @returns {{ availRamGb: number, swapUsedGb: number, swapTotalGb: number } | null} */
export function parseLinuxMeminfo(meminfoText) {
  const availKb = meminfoKb(meminfoText, 'MemAvailable');
  const swapFreeKb = meminfoKb(meminfoText, 'SwapFree');
  const swapTotalKb = meminfoKb(meminfoText, 'SwapTotal');
  if (availKb === null || swapFreeKb === null || swapTotalKb === null) return null;
  const swapUsedKb = Math.max(0, swapTotalKb - swapFreeKb);
  return {
    availRamGb: availKb / (1024 ** 2),
    swapUsedGb: swapUsedKb / (1024 ** 2),
    swapTotalGb: swapTotalKb / (1024 ** 2),
  };
}

export async function readAvailableMemory({
  platform,
  exec,
  os = nodeOs,
} = {}) {
  const plat = platform ?? (typeof os.platform === 'function' ? os.platform() : undefined);
  const run = typeof exec === 'function' ? exec : defaultMemoryExec;
  if (plat === 'darwin') {
    let vmStatText;
    try {
      vmStatText = await run('vm_stat');
    } catch {
      vmStatText = null;
    }
    if (vmStatText != null) {
      let swapText = '';
      try {
        swapText = typeof exec === 'function'
          ? await run('sysctl', ['vm.swapusage'])
          : await run('sysctl', ['-n', 'vm.swapusage']);
      } catch {
        swapText = '';
      }
      const parsed = parseDarwinVmStatAndSwap(vmStatText, swapText);
      if (parsed) return parsed;
    }
    return {
      availRamGb: 0,
      swapUsedGb: 0,
      swapTotalGb: 0,
      pressureUnknown: true,
      warning: DARWIN_MEMORY_PROBE_UNKNOWN_WARNING,
    };
  }
  if (plat === 'linux') {
    try {
      const meminfoText = await run('read', ['/proc/meminfo']);
      const parsed = parseLinuxMeminfo(meminfoText);
      if (parsed) return parsed;
    } catch {
      /* fall through */
    }
  }
  const free = os.freemem() / GB;
  return { availRamGb: free, swapUsedGb: 0, swapTotalGb: 0 };
}

function memoryPressurePlatform(platform, machine) {
  if (platform != null) return platform;
  if (machine?.platform != null) return machine.platform;
  return nodeOs.platform();
}

export function memoryPressureLevel(machine, platform) {
  if (machine?.pressureUnknown) return 'ok';
  const plat = memoryPressurePlatform(platform, machine);
  const avail = machine.availRamGb ?? machine.freeRamGb ?? 0;
  const swapUsed = machine.swapUsedGb ?? 0;
  const swapTotal = machine.swapTotalGb ?? 0;
  const swapRatio = swapTotal > 0 ? swapUsed / swapTotal : 0;
  if (plat === 'darwin') {
    if (avail < 3) return 'hard';
    if (avail < 6 || swapUsed > 8) return 'soft';
    return 'ok';
  }
  if (avail < 3 || swapUsed > 4 || swapRatio > 0.6) return 'hard';
  if (avail < 6 || swapUsed > 1) return 'soft';
  return 'ok';
}

export function projectedMemoryJobCap(machine, jobMemoryGb = DEFAULT_JOB_MEMORY_GB) {
  const avail = machine.availRamGb ?? machine.freeRamGb ?? 0;
  const perJob = jobMemoryGb > 0 ? jobMemoryGb : DEFAULT_JOB_MEMORY_GB;
  return Math.max(0, Math.floor((avail - 3) / perJob));
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
  platform,
  exec,
  now = () => Date.now(),
  delayMs = 100,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  measureCpu = null,
} = {}) {
  const cores = os.cpus().length;
  const mem = await readAvailableMemory({ platform, exec, os });
  const availRamGb = mem.availRamGb;
  const freeRamGb = availRamGb;
  const totalRamGb = os.totalmem() / GB;
  const swapUsedGb = mem.swapUsedGb;
  const swapTotalGb = mem.swapTotalGb;
  const pressureUnknown = mem.pressureUnknown === true;
  const memoryProbeWarning = mem.warning;
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
  return {
    cores,
    freeRamGb,
    availRamGb,
    totalRamGb,
    swapUsedGb,
    swapTotalGb,
    cpuPercent,
    ...(pressureUnknown ? { pressureUnknown: true } : {}),
    ...(memoryProbeWarning ? { warning: memoryProbeWarning } : {}),
  };
}

function stressReason({ cpuPercent, freeRamGb, rateLimitedLanes, memoryPressure }) {
  if (cpuPercent >= 80) return 'cpu';
  if (memoryPressure === 'hard' || memoryPressure === 'soft') return 'ram';
  if (freeRamGb <= 4) return 'ram';
  if (rateLimitedLanes?.length > 0) return 'lane-rate-limit';
  return null;
}

function cappedNow({ cpuPercent, freeRamGb, rateLimitedLanes, waiting, limit, max, memoryPressure }) {
  const stress = stressReason({ cpuPercent, freeRamGb, rateLimitedLanes, memoryPressure });
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
  memoryFloor = MEMORY_PRESSURE_FLOOR,
  jobMemoryGb = DEFAULT_JOB_MEMORY_GB,
  now = () => Date.now(),
} = {}) {
  let limit = initialLimit;
  void now;

  function tune({
    cpuPercent,
    freeRamGb,
    availRamGb,
    swapUsedGb,
    swapTotalGb,
    inUse,
    waiting,
    rateLimitedLanes = [],
  }) {
    void inUse;
    const lanes = Array.isArray(rateLimitedLanes) ? rateLimitedLanes : [];
    const machine = {
      freeRamGb: availRamGb ?? freeRamGb,
      availRamGb: availRamGb ?? freeRamGb,
      swapUsedGb,
      swapTotalGb,
    };
    const memoryPressure = memoryPressureLevel(machine);
    const projectionCap = projectedMemoryJobCap(machine, jobMemoryGb);
    let workingMax = Math.min(max, projectionCap > 0 ? projectionCap : max);
    if (projectionCap === 0 && (machine.availRamGb ?? 0) < 3) {
      workingMax = Math.min(workingMax, memoryFloor);
    }

    const stress = stressReason({
      cpuPercent,
      freeRamGb: machine.freeRamGb,
      rateLimitedLanes: lanes,
      memoryPressure,
    });
    let reason = 'none';
    let next = limit;

    if (memoryPressure === 'hard') {
      next = memoryFloor;
      reason = 'ram';
    } else if (memoryPressure === 'soft') {
      next = Math.max(memoryFloor, Math.floor(limit * backoffFactor));
      reason = 'ram';
    } else if (stress) {
      next = Math.max(min, Math.floor(limit * backoffFactor));
      reason = stress;
    } else if (
      memoryPressure === 'ok'
      && cpuPercent < 80
      && machine.freeRamGb > 4
      && waiting > 0
      && limit < workingMax
    ) {
      next = Math.min(workingMax, limit + stepUp);
      reason = 'none';
    } else if (waiting <= 0) {
      reason = 'no-ready-tickets';
    }

    if (next > workingMax) next = workingMax;
    limit = next;
    const capped = cappedNow({
      cpuPercent,
      freeRamGb: machine.freeRamGb,
      rateLimitedLanes: lanes,
      waiting,
      limit,
      max: workingMax,
      memoryPressure,
    });
    return { limit, reason, capped, memoryPressure, projectionCap };
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
