// SPDX-License-Identifier: Apache-2.0
// This project's own local, machine-specific config: a public repo names no private package or
// service, so anything project-specific (keychain service name, rig port file, cheap-tier
// override, extra denied home directories, a private-names list) arrives here instead of as a
// source literal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Field lesson 112: the old default, `<home>/.project-swarm/config.json`, sits inside the shared
// install clone itself (the same directory `git pull`/`swarm update` operate on) — a machine-local
// file living inside a git checkout is neither private nor safe from being overwritten. The default
// now lives under XDG (or `~/.config` when XDG_CONFIG_HOME is unset or relative); `SWARM_CONFIG`
// still wins over either.
// `home` defaults from the same `env` every other part of the path resolves from (env.HOME, same
// as env.XDG_CONFIG_HOME just below), never straight from the live process's os.homedir() — a
// caller that passes an isolated env (a test harness, a sandboxed job) gets an isolated home too,
// instead of the resolution silently reading past it to the real machine.
export function defaultConfigPath({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, 'project-swarm', 'config.json');
  return path.join(home, '.config', 'project-swarm', 'config.json');
}

function oldInstallConfigPath(home) {
  return path.join(home, '.project-swarm', 'config.json');
}

// Walks up from `dir` looking for a `.git` entry (file, in a worktree, or dir, in a normal
// checkout), stopping at the filesystem root. Returns the directory it was found in, or null.
function gitWorkTreeTop(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// The file loadLocalConfig actually reads, without its side effects (the old-install-path throw,
// the parse). A caller that only needs to name the path in a message — never a second, drifting
// copy of the same `env.SWARM_CONFIG || defaultConfigPath(...)` logic — uses this instead.
export function resolveConfigPath({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_CONFIG || defaultConfigPath({ env, home });
}

export function loadLocalConfig({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  let file = env.SWARM_CONFIG;
  if (!file) {
    const oldPath = oldInstallConfigPath(home);
    if (fs.existsSync(oldPath)) {
      throw Error(`config-inside-install: ${oldPath} sits in the install checkout; move it to ${defaultConfigPath({ home, env })}`);
    }
    file = defaultConfigPath({ home, env });
  }
  const top = gitWorkTreeTop(path.dirname(file));
  // Sandbox-local config is allowed only under the work tree's designated scratch directories.
  const sandboxConfig = top && ['.swarm-tmp', '.swarm'].some(dir => path.relative(top, path.resolve(file)).startsWith(dir + path.sep));
  if (top && !sandboxConfig) throw Error(`config-inside-repo: ${file} is inside the git work tree ${top}`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return {}; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw Error(`invalid swarm config: ${file}`); }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.autopilot !== undefined) {
    const errors = validateAutopilotBlock(parsed.autopilot, { label: 'autopilot' });
    if (errors.length) throw Error(`invalid swarm config: ${file}: ${errors.join('; ')}`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/** Hard ceiling for autopilot `maxJobs` (matches go --scope batch size). */
export const AUTOPILOT_MAX_JOBS_CEILING = 64;

const AUTOPILOT_KEYS = new Set(['skipSkeleton', 'maxJobs']);

export function validateAutopilotBlock(raw, { label = 'autopilot' } = {}) {
  const errors = [];
  if (raw === undefined) return errors;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label}: must be an object`);
    return errors;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTOPILOT_KEYS.has(key)) errors.push(`${label}.${key}: unknown key`);
  }
  if (raw.skipSkeleton !== undefined) {
    const v = raw.skipSkeleton;
    if (v !== true && v !== false && v !== 'auto') {
      errors.push(`${label}.skipSkeleton: must be true, false, or "auto"`);
    }
  }
  if (raw.maxJobs !== undefined) {
    const n = Number(raw.maxJobs);
    if (!Number.isInteger(n) || n < 1) errors.push(`${label}.maxJobs: must be a positive integer`);
    else if (n > AUTOPILOT_MAX_JOBS_CEILING) {
      errors.push(`${label}.maxJobs: must be at most ${AUTOPILOT_MAX_JOBS_CEILING}`);
    }
  }
  return errors;
}

function sanitizeAutopilotLayer(layer, { label = 'autopilot' } = {}) {
  if (layer === undefined || layer === null) return null;
  const errors = validateAutopilotBlock(layer, { label });
  if (errors.length) return { layer: null, errors };
  const out = {};
  if (layer.skipSkeleton !== undefined) out.skipSkeleton = layer.skipSkeleton;
  if (layer.maxJobs !== undefined) out.maxJobs = layer.maxJobs;
  return { layer: Object.keys(out).length ? out : null, errors: [] };
}

/**
 * Resolved start-ready wave settings from machine and project `autopilot` blocks.
 * `skipSkeleton` is the flag to pass to go --scope; `maxJobs` is capped at 64 and at `freeSlots` when set.
 */
export function resolveAutopilotStartReady({
  machine = null,
  project = null,
  freeSlots = null,
  doneTicketCount = 0,
} = {}) {
  const machineSan = sanitizeAutopilotLayer(machine, { label: 'machine.autopilot' });
  const projectSan = sanitizeAutopilotLayer(project, { label: 'project.autopilot' });
  const m = machineSan?.layer;
  const p = projectSan?.layer;
  const skipMode = p?.skipSkeleton ?? m?.skipSkeleton ?? 'auto';
  let skipSkeleton = false;
  if (skipMode === true) skipSkeleton = true;
  else if (skipMode === 'auto') skipSkeleton = Number(doneTicketCount) >= 10;
  let maxJobs = p?.maxJobs ?? m?.maxJobs;
  if (maxJobs === undefined) maxJobs = Number.isInteger(freeSlots) && freeSlots > 0 ? freeSlots : 1;
  if (!Number.isInteger(maxJobs) || maxJobs < 1) maxJobs = 1;
  maxJobs = Math.min(AUTOPILOT_MAX_JOBS_CEILING, maxJobs);
  if (Number.isInteger(freeSlots) && freeSlots > 0) maxJobs = Math.min(maxJobs, freeSlots);
  return { skipSkeleton, maxJobs };
}
