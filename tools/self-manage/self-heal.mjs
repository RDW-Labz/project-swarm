// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import {
  isOrphanedSwarmLeakCandidate,
  terminateProcessGroup,
} from './watchdog.mjs';

const DEFAULT_AGE_THRESHOLD_MS = 60 * 60 * 1000;
const DEFAULT_REPROBE_DELAY_MS = 250;

/**
 * @param {import('./watchdog.mjs').ProcessRecord} proc
 * @returns {number[]}
 */
function listeningPortsForProcess(proc) {
  if (proc.listeningPorts != null) {
    const raw = Array.isArray(proc.listeningPorts) ? proc.listeningPorts : [proc.listeningPorts];
    return raw.map(p => Number(p)).filter(n => Number.isFinite(n));
  }
  if (proc.port != null) {
    const n = Number(proc.port);
    return Number.isFinite(n) ? [n] : [];
  }
  return [];
}

/**
 * @param {import('./watchdog.mjs').ProcessRecord} proc
 * @param {number[]} expectedPorts
 */
export function processMatchesExpectedPort(proc, expectedPorts) {
  if (!Array.isArray(expectedPorts) || expectedPorts.length === 0) return false;
  const expected = new Set(
    expectedPorts.map(p => Number(p)).filter(n => Number.isFinite(n)),
  );
  if (expected.size === 0) return false;
  const listening = listeningPortsForProcess(proc);
  return listening.some(p => expected.has(p));
}

/**
 * @param {import('./watchdog.mjs').ProcessRecord} proc
 * @param {{ ageThresholdMs: number, now: number, osTmpDir?: string, expectedPorts: number[] }} options
 */
export function isSelfHealLeakCandidate(proc, { ageThresholdMs, now, osTmpDir, expectedPorts }) {
  if (!isOrphanedSwarmLeakCandidate(proc, { ageThresholdMs, now, osTmpDir })) return false;
  return processMatchesExpectedPort(proc, expectedPorts);
}

/**
 * @param {import('./watchdog.mjs').ProcessRecord[]} processes
 * @param {{ ageThresholdMs?: number, now?: number, osTmpDir?: string, expectedPorts?: number[] }} [options]
 */
export function selfHealCandidates(
  processes,
  {
    ageThresholdMs = DEFAULT_AGE_THRESHOLD_MS,
    now = Date.now(),
    osTmpDir = os.tmpdir(),
    expectedPorts = [],
  } = {},
) {
  if (!Array.isArray(processes)) return [];
  const verify = { ageThresholdMs, now, osTmpDir, expectedPorts };
  return processes.filter(p => isSelfHealLeakCandidate(p, verify));
}

/**
 * @param {import('./watchdog.mjs').ProcessRecord} proc
 * @param {number} now
 * @returns {number | null}
 */
function processStartTimeMs(proc, now) {
  if (proc.startTimeMs != null) return proc.startTimeMs;
  if (proc.ageMs != null) return now - proc.ageMs;
  return null;
}

/**
 * @param {import('./watchdog.mjs').ProcessRecord} original
 * @param {import('./watchdog.mjs').ProcessRecord} fresh
 * @param {number} now
 */
function isSameProcessInstance(original, fresh, now) {
  const oStart = processStartTimeMs(original, now);
  const fStart = processStartTimeMs(fresh, now);
  if (oStart != null && fStart != null) return oStart === fStart;
  if (original.ageMs != null && fresh.ageMs != null) return original.ageMs === fresh.ageMs;
  return false;
}

/**
 * @param {(msg: string, detail?: object) => void} log
 * @param {import('./watchdog.mjs').ProcessRecord} proc
 * @param {string} action
 * @param {string} result
 * @param {object} [extra]
 */
function logFixAttempt(log, proc, action, result, extra = {}) {
  const lane = proc.lane ?? null;
  log('self-heal: fix attempt', { lane, action, result, pid: proc.pid, ...extra });
}

/**
 * Port-aware leak cleanup: reuses watchdog terminateProcessGroup and logs every fix attempt.
 *
 * @param {object} options
 * @param {import('./watchdog.mjs').ProcessRecord[]} options.processes
 * @param {() => import('./watchdog.mjs').ProcessRecord[]} options.getProcesses
 * @param {(pid: number, signal: string) => Promise<void> | void} options.kill
 * @param {number[]} options.expectedPorts
 * @param {(ms: number) => Promise<void>} [options.wait]
 */
export async function selfHealOrphanedLeaks({
  processes,
  getProcesses,
  kill,
  expectedPorts,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  reprobeDelayMs = DEFAULT_REPROBE_DELAY_MS,
  ageThresholdMs = DEFAULT_AGE_THRESHOLD_MS,
  now = Date.now(),
  osTmpDir = os.tmpdir(),
  log = () => {},
  ownPgid,
} = {}) {
  const candidates = selfHealCandidates(processes, {
    ageThresholdMs,
    now,
    osTmpDir,
    expectedPorts,
  });
  const outcomes = [];
  const verifyOptions = { ageThresholdMs, now, osTmpDir, expectedPorts };
  for (const proc of candidates) {
    const freshList = getProcesses();
    const freshProc = freshList.find(p => p.pid === proc.pid);
    if (
      !freshProc ||
      !isSelfHealLeakCandidate(freshProc, verifyOptions) ||
      !isSameProcessInstance(proc, freshProc, now)
    ) {
      logFixAttempt(log, proc, 'skipped-stale', 'skipped-stale', {
        reason: 'stale_candidate',
      });
      outcomes.push({
        pid: proc.pid,
        pgid: proc.pgid ?? proc.pid,
        status: 'skipped',
        reason: 'stale_candidate',
      });
      continue;
    }
    const signaled = await terminateProcessGroup(freshProc, kill, { log, ownPgid });
    if (signaled.status === 'skipped') {
      const isEperm = signaled.reason === 'EPERM';
      logFixAttempt(
        log,
        freshProc,
        isEperm ? 'skipped-eperm' : 'kill-skipped',
        isEperm ? 'skipped-eperm' : String(signaled.reason ?? 'skipped'),
        { reason: signaled.reason },
      );
      outcomes.push(signaled);
      continue;
    }
    await wait(reprobeDelayMs);
    const after = getProcesses();
    const pgid = freshProc.pgid ?? freshProc.pid;
    const stillThere = after.some(
      p =>
        p.pid === freshProc.pid ||
        (p.pgid != null && p.pgid === pgid) ||
        p.pid === pgid,
    );
    const result = stillThere ? 'still_running' : 'terminated';
    logFixAttempt(log, freshProc, 'kill-attempted', result, {
      signal: signaled.signal,
      reprobed: true,
    });
    outcomes.push({
      ...signaled,
      status: result,
      reprobed: true,
    });
  }
  return outcomes;
}
