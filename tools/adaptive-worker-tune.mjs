// SPDX-License-Identifier: Apache-2.0
// Ticket T-0097 (R-022, AC1): adaptive worker limit. Pure functions; no I/O.

export const TUNE_DEFAULTS = Object.freeze({
  minWorkers: 1,
  maxWorkers: 2048,
  cpuHighPct: 85,      // above this CPU load the limit does not rise
  cpuBackoffPct: 95,   // above this CPU load the limit backs off
  ramMinFreeRatio: 0.15, // free RAM below this fraction is pressure
  perWorkerRamMb: 512, // assumed RAM cost of one worker
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Default limit from cores and free RAM: whichever resource allows fewer workers wins.
export function defaultWorkerLimit({ cores, freeRamMb }, options = {}) {
  const o = { ...TUNE_DEFAULTS, ...options };
  if (!Number.isInteger(cores) || cores < 1) throw new Error('tune-invalid: cores must be a positive integer');
  if (!Number.isFinite(freeRamMb) || freeRamMb < 0) throw new Error('tune-invalid: freeRamMb must be a non-negative number');
  const byRam = Math.floor(freeRamMb / o.perWorkerRamMb);
  return clamp(Math.min(cores, byRam), o.minWorkers, o.maxWorkers);
}

// One tuning step. Back off on CPU or RAM pressure or any lane rate limit (halving, never below min);
// raise by one only while CPU and RAM both have headroom and no rate limit was seen.
export function nextWorkerLimit({ current, cpuPct, freeRamRatio, rateLimited = false }, options = {}) {
  const o = { ...TUNE_DEFAULTS, ...options };
  if (!Number.isInteger(current) || current < 1) throw new Error('tune-invalid: current must be a positive integer');
  const ramPressure = freeRamRatio < o.ramMinFreeRatio;
  const cpuPressure = cpuPct >= o.cpuBackoffPct;
  if (rateLimited || ramPressure || cpuPressure) {
    return clamp(Math.floor(current / 2), o.minWorkers, o.maxWorkers);
  }
  if (cpuPct < o.cpuHighPct && !ramPressure) {
    return clamp(current + 1, o.minWorkers, o.maxWorkers);
  }
  return current;
}

// Learned per-lane caps are kept per machine: a map keyed by machine id, then by lane agent.
export function learnedCapsFor(store, machineId) {
  if (typeof machineId !== 'string' || !machineId) throw new Error('tune-invalid: machineId must be a non-empty string');
  const byMachine = store && typeof store === 'object' && store.machines && typeof store.machines === 'object' ? store.machines : {};
  const caps = byMachine[machineId];
  return caps && typeof caps === 'object' && !Array.isArray(caps) ? { ...caps } : {};
}

export function withLearnedCap(store, machineId, agent, cap) {
  if (!Number.isInteger(cap) || cap < 1) throw new Error('tune-invalid: cap must be a positive integer');
  const machines = store && typeof store === 'object' && store.machines && typeof store.machines === 'object' ? store.machines : {};
  return { ...store, machines: { ...machines, [machineId]: { ...learnedCapsFor(store, machineId), [agent]: cap } } };
}
