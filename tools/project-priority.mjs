// SPDX-License-Identifier: Apache-2.0
// Per-project weight for fair sharing of the machine-wide worker limit (`machineConcurrency`).
// Higher priority gets a larger guaranteed share when several projects are active at once.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

export const DEFAULT_MACHINE_SHARE_PRIORITY = 1;
const MAX_MACHINE_SHARE_PRIORITY = 1024;
export const MACHINE_DEMAND_TTL_MS = 5000;

function invalid(source) {
  return Object.assign(new Error(`lanes-invalid: ${source} must be a whole number from 1 to ${MAX_MACHINE_SHARE_PRIORITY} (or left out for the default of ${DEFAULT_MACHINE_SHARE_PRIORITY})`), { code: 'lanes-invalid' });
}

// The weight from a profile object (validated or raw). Missing means the default so equal-priority projects keep even shares.
export function machineSharePriority(profile) {
  const value = profile?.machineSharePriority;
  if (value === undefined) return DEFAULT_MACHINE_SHARE_PRIORITY;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MACHINE_SHARE_PRIORITY) throw invalid('profile.machineSharePriority');
  return value;
}

// Optional machine-config override for this project's repo (same file as `machineConcurrency`); profile wins when both are set.
export function machineSharePriorityFromConfig(config) {
  const value = config?.machineSharePriority;
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MACHINE_SHARE_PRIORITY) throw invalid('machineSharePriority');
  return value;
}

// Resolved priority and where it came from. Profile beats config; otherwise the default.
export function projectMachineSharePriorityInfo({ profile, config } = {}) {
  if (profile?.machineSharePriority !== undefined) {
    return { priority: machineSharePriority(profile), source: 'profile.machineSharePriority' };
  }
  const fromConfig = config === undefined ? null : machineSharePriorityFromConfig(config);
  if (fromConfig !== null) return { priority: fromConfig, source: 'machineSharePriority' };
  return { priority: DEFAULT_MACHINE_SHARE_PRIORITY, source: 'default' };
}

// Reads this repository's priority from `.project-swarm.json` and the local machine config.
export async function readProjectMachineSharePriority(root, { env = process.env } = {}) {
  let profile;
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
    profile = pointer?.profile;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw Object.assign(new Error(`lanes-invalid: .project-swarm.json cannot be read (${error.code ?? 'bad JSON'}); machine share priority cannot be resolved`), { code: 'lanes-invalid' });
    }
  }
  let config;
  try { config = loadLocalConfig({ env }); }
  catch (error) { throw Object.assign(new Error(`lanes-invalid: machine config cannot be read (${error.message}); machine share priority cannot be resolved`), { code: 'lanes-invalid' }); }
  return projectMachineSharePriorityInfo({ profile, config });
}

function slotLive(slot, host, isAlive) {
  return slot.host !== host || isAlive(slot.pid);
}

// Known priorities from held slots and live demand entries (this run's `priority` wins for `project`).
export function machineSharePrioritiesInStore(store, { project, priority, time, host, isAlive, demandTtlMs = MACHINE_DEMAND_TTL_MS } = {}) {
  const priorities = {};
  if (project && priority !== undefined) priorities[project] = priority;
  for (const slots of Object.values(store.slots ?? {})) {
    if (!Array.isArray(slots)) continue;
    for (const slot of slots) {
      if (!slot?.project || slot.machineSharePriority === undefined) continue;
      priorities[slot.project] = slot.machineSharePriority;
    }
  }
  const demand = store.demand && typeof store.demand === 'object' && !Array.isArray(store.demand) ? store.demand : {};
  for (const entry of Object.values(demand)) {
    if (!entry || typeof entry.project !== 'string' || entry.project === '' || entry.machineSharePriority === undefined) continue;
    if (!(Number.isFinite(entry.at) && time - entry.at <= demandTtlMs) || typeof entry.host !== 'string' || !slotLive({ host: entry.host, pid: entry.pid }, host, isAlive)) continue;
    priorities[entry.project] = entry.machineSharePriority;
  }
  return priorities;
}

// Guaranteed share for one active project: proportional to its weight, at least 1.
export function machineShareForProject({ max, activeProjects, project, priorities, priorityOf }) {
  const active = [...activeProjects];
  const weight = key => {
    if (priorityOf) return priorityOf(key);
    return priorities[key] ?? DEFAULT_MACHINE_SHARE_PRIORITY;
  };
  let totalWeight = 0;
  for (const key of active) totalWeight += weight(key);
  if (totalWeight <= 0) return Math.max(1, Math.floor(max / active.length));
  return Math.max(1, Math.floor(max * weight(project) / totalWeight));
}

function waitingByProject(store, { time, host, isAlive, except = null, demandTtlMs = MACHINE_DEMAND_TTL_MS }) {
  const out = {};
  for (const entry of Object.values(store.demand && typeof store.demand === 'object' && !Array.isArray(store.demand) ? store.demand : {})) {
    if (!entry || typeof entry.project !== 'string' || entry.project === '' || entry.project === except || !Number.isInteger(entry.count) || entry.count <= 0) continue;
    if (!(Number.isFinite(entry.at) && time - entry.at <= demandTtlMs) || typeof entry.host !== 'string' || !slotLive({ host: entry.host, pid: entry.pid }, host, isAlive)) continue;
    const have = out[entry.project] ??= { count: 0, since: Infinity };
    have.count += entry.count;
    have.since = Math.min(have.since, Number.isFinite(entry.since) ? entry.since : entry.at);
  }
  return out;
}

// Fair sharing of `machineConcurrency` between projects, weighted by `machineSharePriority`.
export function machineAllowance({
  store,
  project,
  count,
  max,
  isAlive,
  time = Date.now(),
  host = os.hostname(),
  priority,
  demandTtlMs = MACHINE_DEMAND_TTL_MS,
} = {}) {
  const held = {};
  let total = 0;
  for (const slots of Object.values(store.slots)) for (const slot of slots) { const key = slot.project ?? ''; held[key] = (held[key] ?? 0) + 1; total += 1; }
  const waiting = waitingByProject(store, { time, host, isAlive, except: project, demandTtlMs });
  const mine = waitingByProject(store, { time, host, isAlive, demandTtlMs })[project];
  const active = new Set([project, ...Object.keys(held).filter(key => key !== '' && held[key] > 0), ...Object.keys(waiting)]);
  const priorities = machineSharePrioritiesInStore(store, { project, priority, time, host, isAlive, demandTtlMs });
  const priorityOf = key => (key === project && priority !== undefined ? priority : priorities[key] ?? DEFAULT_MACHINE_SHARE_PRIORITY);
  const shareFor = key => machineShareForProject({ max, activeProjects: active, project: key, priorityOf });
  const entitled = key => Math.min(Math.max(0, shareFor(key) - (held[key] ?? 0)), waiting[key]?.count ?? 0);
  const mySince = mine?.since ?? time;
  let reserved = 0, reservedAhead = 0;
  for (const key of Object.keys(waiting)) {
    reserved += entitled(key);
    if (waiting[key].since < mySince || (waiting[key].since === mySince && key < project)) reservedAhead += entitled(key);
  }
  const free = Math.max(0, max - total);
  const share = shareFor(project);
  const guaranteed = Math.min(count, Math.max(0, share - (held[project] ?? 0)), Math.max(0, free - reservedAhead));
  const borrowed = Math.min(count, Math.max(0, free - reserved));
  return { allowed: Math.max(guaranteed, borrowed), share, held, total, free, reserved };
}
