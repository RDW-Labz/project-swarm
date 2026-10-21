// SPDX-License-Identifier: Apache-2.0
// Per-project weight for fair sharing of the machine-wide worker limit (`machineConcurrency`).
// Higher priority gets a larger guaranteed share when several projects are active at once.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

export const DEFAULT_MACHINE_SHARE_PRIORITY = 1;
const MAX_MACHINE_SHARE_PRIORITY = 1024;

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
