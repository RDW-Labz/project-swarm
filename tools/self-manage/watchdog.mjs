// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';
import {
  effectiveMachineLimit,
  memoryPressureHoldLine,
  memoryPressureLevel,
  projectedMemoryJobCap,
} from '../machine-limit.mjs';
import { readMachine } from '../autotune.mjs';

const DEFAULT_AGE_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_REPROBE_DELAY_MS = 250;

/**
 * @typedef {Object} ProcessRecord
 * @property {number} pid
 * @property {number} ppid
 * @property {string[] | string} [argv]
 * @property {string} [cmd]
 * @property {number} [pgid] Process group id; defaults to pid when terminating.
 * @property {number} [startTimeMs] Epoch ms when the process started.
 * @property {number} [ageMs] Age in ms (alternative to startTimeMs).
 */

/**
 * True when argv/cmd references a swarm scratch or temp workspace (path gate only).
 *
 * @param {string[] | string} argvOrCmd
 * @param {{ osTmpDir?: string }} [options]
 */
export function isSwarmScratchProcessPath(argvOrCmd, { osTmpDir = os.tmpdir() } = {}) {
  const text = Array.isArray(argvOrCmd) ? argvOrCmd.join('\0') : String(argvOrCmd ?? '');
  if (text.includes('.project-swarm-scratch')) return true;
  if (text.includes('.swarm')) return true;
  const normalizedTmp = path.normalize(osTmpDir);
  if (normalizedTmp && text.includes(normalizedTmp) && /\bswarm\b/i.test(text)) return true;
  return false;
}

/**
 * @param {ProcessRecord} proc
 * @param {{ ageThresholdMs: number, now: number, osTmpDir?: string }} options
 */
export function isOrphanedSwarmLeakCandidate(proc, { ageThresholdMs, now, osTmpDir }) {
  if (proc.ppid !== 1) return false;
  const argv = proc.argv ?? proc.cmd ?? '';
  if (!isSwarmScratchProcessPath(argv, { osTmpDir })) return false;
  const ageMs = proc.ageMs ?? (proc.startTimeMs != null ? now - proc.startTimeMs : null);
  if (ageMs == null || ageMs < ageThresholdMs) return false;
  return true;
}

/**
 * @param {ProcessRecord[]} processes
 * @param {{ ageThresholdMs?: number, now?: number, osTmpDir?: string }} [options]
 * @returns {ProcessRecord[]}
 */
export function selectOrphanedSwarmLeakCandidates(
  processes,
  {
    ageThresholdMs = DEFAULT_AGE_THRESHOLD_MS,
    now = Date.now(),
    osTmpDir = os.tmpdir(),
  } = {},
) {
  if (!Array.isArray(processes)) return [];
  return processes.filter(p =>
    isOrphanedSwarmLeakCandidate(p, { ageThresholdMs, now, osTmpDir }),
  );
}

/**
 * Orphaned processes whose argv touches swarm scratch paths (for reporting; may not be leak-safe).
 *
 * @param {ProcessRecord[]} processes
 * @param {{ osTmpDir?: string }} [options]
 */
export function listOrphanedSwarmPathProcesses(processes, { osTmpDir = os.tmpdir() } = {}) {
  if (!Array.isArray(processes)) return [];
  return processes.filter(p => {
    if (p.ppid !== 1) return false;
    const argv = p.argv ?? p.cmd ?? '';
    return isSwarmScratchProcessPath(argv, { osTmpDir });
  });
}

/**
 * Under resource pressure, never zero out cloud lanes — leave a thin narrow-wave allowance.
 *
 * @param {object} machine
 * @param {{ limit?: number, config?: object }} [options]
 */
export function narrowWaveCloudLaneAllowance(machine, { limit = 64, config = {} } = {}) {
  const pressure = memoryPressureLevel(machine);
  if (pressure === 'hard') {
    return {
      cloudLaneJobs: 1,
      pressure,
      holdLine: memoryPressureHoldLine(machine),
      projectionCap: projectedMemoryJobCap(machine),
    };
  }
  if (pressure === 'soft') {
    return {
      cloudLaneJobs: 2,
      pressure,
      holdLine: memoryPressureHoldLine(machine),
      projectionCap: projectedMemoryJobCap(machine),
    };
  }
  const { effective, projectionCap } = effectiveMachineLimit({ limit, machine, config });
  const cloudLaneJobs = Math.max(2, effective);
  return {
    cloudLaneJobs,
    pressure,
    holdLine: null,
    projectionCap,
  };
}

/**
 * @param {object} machine
 * @param {object | null} disk Injected disk stats (e.g. usedGb, totalGb).
 */
export function buildResourceSnapshot(machine, disk = null) {
  const pressure = memoryPressureLevel(machine);
  const allowance = narrowWaveCloudLaneAllowance(machine);
  return {
    pressure,
    availRamGb: machine?.availRamGb ?? machine?.freeRamGb ?? null,
    swapUsedGb: machine?.swapUsedGb ?? 0,
    swapTotalGb: machine?.swapTotalGb ?? 0,
    projectionCap: projectedMemoryJobCap(machine),
    cloudLaneAllowance: allowance.cloudLaneJobs,
    disk,
  };
}

/**
 * @param {ProcessRecord} proc
 * @param {(pid: number, signal: string) => Promise<void> | void} kill
 * @param {{ log?: (msg: string, detail?: object) => void }} [options]
 */
export async function terminateProcessGroup(proc, kill, { log = () => {} } = {}) {
  const pgid = proc.pgid ?? proc.pid;
  const target = -Math.abs(pgid);
  try {
    await kill(target, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'EPERM') {
      log('watchdog: skip kill (EPERM — not ours)', { pid: proc.pid, pgid });
      return { pid: proc.pid, pgid, status: 'skipped', reason: 'EPERM' };
    }
    throw error;
  }
  return { pid: proc.pid, pgid, status: 'signaled', signal: 'SIGTERM', target };
}

/**
 * SIGTERM process groups for leak candidates, re-probe after a short delay.
 *
 * @param {object} options
 * @param {ProcessRecord[]} options.processes
 * @param {() => ProcessRecord[]} options.getProcesses Re-probe after delay.
 * @param {(pid: number, signal: string) => Promise<void> | void} options.kill
 * @param {(ms: number) => Promise<void>} [options.wait]
 * @param {number} [options.reprobeDelayMs]
 */
export async function cleanupOrphanedSwarmLeaks({
  processes,
  getProcesses,
  kill,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  reprobeDelayMs = DEFAULT_REPROBE_DELAY_MS,
  ageThresholdMs = DEFAULT_AGE_THRESHOLD_MS,
  now = Date.now(),
  osTmpDir = os.tmpdir(),
  log = () => {},
} = {}) {
  const candidates = selectOrphanedSwarmLeakCandidates(processes, {
    ageThresholdMs,
    now,
    osTmpDir,
  });
  const outcomes = [];
  for (const proc of candidates) {
    const signaled = await terminateProcessGroup(proc, kill, { log });
    if (signaled.status === 'skipped') {
      outcomes.push(signaled);
      continue;
    }
    await wait(reprobeDelayMs);
    const after = getProcesses();
    const pgid = proc.pgid ?? proc.pid;
    const stillThere = after.some(
      p => p.pid === proc.pid || (p.pgid != null && p.pgid === pgid) || p.pid === pgid,
    );
    outcomes.push({
      ...signaled,
      status: stillThere ? 'still_running' : 'terminated',
      reprobed: true,
    });
  }
  return outcomes;
}

/**
 * @typedef {import('./types.mjs').LaneHealthRecord} LaneHealthRecord
 */

/**
 * @param {object} params
 * @returns {Promise<{
 *   resources: ReturnType<typeof buildResourceSnapshot>,
 *   orphanedSwarmProcesses: ProcessRecord[],
 *   cleanup: Awaited<ReturnType<typeof cleanupOrphanedSwarmLeaks>>,
 *   laneHealth: LaneHealthRecord,
 * }>}
 */
export async function runWatchdog({
  processes = [],
  machine = {},
  disk = null,
  config = {},
  ageThresholdMs = DEFAULT_AGE_THRESHOLD_MS,
  now = Date.now(),
  osTmpDir = os.tmpdir(),
  kill,
  wait,
  reprobeDelayMs = DEFAULT_REPROBE_DELAY_MS,
  getProcesses,
  log = () => {},
} = {}) {
  const resources = buildResourceSnapshot(machine, disk);
  const orphanedSwarmProcesses = listOrphanedSwarmPathProcesses(processes, { osTmpDir });
  const probe = getProcesses ?? (() => processes);
  let cleanup = [];
  if (typeof kill === 'function') {
    cleanup = await cleanupOrphanedSwarmLeaks({
      processes,
      getProcesses: probe,
      kill,
      wait,
      reprobeDelayMs,
      ageThresholdMs,
      now,
      osTmpDir,
      log,
    });
  }
  const lastChecked = new Date(now).toISOString();
  let laneHealth;
  if (resources.pressure === 'hard' || resources.pressure === 'soft') {
    laneHealth = {
      status: 'degraded',
      reason: resources.cloudLaneAllowance >= 1
        ? `narrow-wave cloud allowance ${resources.cloudLaneAllowance} job(s); ${memoryPressureHoldLine(machine)}`
        : memoryPressureHoldLine(machine),
      lastChecked,
    };
  } else {
    laneHealth = {
      status: 'healthy',
      reason: null,
      lastChecked,
    };
  }
  return {
    resources,
    orphanedSwarmProcesses,
    cleanup,
    laneHealth,
  };
}

/** Thin wrapper: live machine probe + watchdog tick (process list still injected). */
export async function runWatchdogWithMachineProbe({
  processes = [],
  disk = null,
  readMachineOptions = {},
  ...rest
} = {}) {
  const machine = await readMachine(readMachineOptions);
  return runWatchdog({ processes, machine, disk, ...rest });
}
