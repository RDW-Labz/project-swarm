// SPDX-License-Identifier: Apache-2.0
// Per-project swarm autopilot: argv, lock status, and detached start for orchestrator seats.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { listProjects, projectsFile } from './projects.mjs';

const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'swarm.mjs');

/** Default autopilot poll interval (seconds) for long-running project loops. */
export const DEFAULT_PROJECT_AUTOPILOT_INTERVAL_SEC = 600;

export function autopilotLockPath(projectRoot) {
  return path.join(path.resolve(String(projectRoot ?? '')), '.swarm', 'project', 'autopilot.lock');
}

export function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function readAutopilotLockOwner(projectRoot) {
  const file = autopilotLockPath(projectRoot);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const pid = data?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startedAt: typeof data?.startedAt === 'string' ? data.startedAt : null };
}

/** Whether a project's autopilot lock is held by a live process. */
export async function projectAutopilotStatus(projectRoot, { isAlive = defaultIsAlive } = {}) {
  const owner = await readAutopilotLockOwner(projectRoot);
  if (!owner) return { status: 'not-running', pid: null, startedAt: null };
  if (!isAlive(owner.pid)) {
    return { status: 'stale', pid: owner.pid, startedAt: owner.startedAt };
  }
  return { status: 'running', pid: owner.pid, startedAt: owner.startedAt };
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * argv for `spawn(execPath, argv, { cwd: projectRoot })` to run swarm autopilot for one project.
 * `--root` is passed before the subcommand (global swarm flag).
 */
export function projectAutopilotArgv(projectRoot, {
  swarmEntryPath = swarmEntry,
  intervalSec = DEFAULT_PROJECT_AUTOPILOT_INTERVAL_SEC,
  once = false,
  maxSteps,
  legacyPlan = false,
} = {}) {
  const root = path.resolve(String(projectRoot ?? ''));
  const interval = positiveInt(intervalSec) ?? DEFAULT_PROJECT_AUTOPILOT_INTERVAL_SEC;
  const argv = [swarmEntryPath, '--root', root, 'autopilot', '--interval', String(interval)];
  if (once) argv.push('--once');
  if (maxSteps != null) {
    const steps = positiveInt(maxSteps);
    if (steps) argv.push('--max-steps', String(steps));
  }
  if (legacyPlan) argv.push('--legacy-plan');
  return argv;
}

export function projectAutopilotProgramArguments(projectRoot, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  return [execPath, ...projectAutopilotArgv(projectRoot, options)];
}

/** Registered owner projects (scratch rows hidden), roots that still exist on disk. */
export async function listActiveOwnerProjects({
  file = projectsFile(),
  env = process.env,
  home = os.homedir(),
  installRoot,
} = {}) {
  return listProjects({ file, forOwner: true, pruneGone: true, env, home, installRoot });
}

/**
 * Start swarm autopilot for `projectRoot` when no live lock holder exists.
 * The child runs `swarm autopilot` (start-ready inside uses readyAutopilotDeps / go --scope).
 */
export async function startProjectAutopilot(projectRoot, {
  env = process.env,
  spawnImpl,
  execPath = process.execPath,
  swarmEntryPath = swarmEntry,
  intervalSec = DEFAULT_PROJECT_AUTOPILOT_INTERVAL_SEC,
  once = false,
  maxSteps,
  legacyPlan = false,
  isAlive = defaultIsAlive,
  cwd,
} = {}) {
  const root = path.resolve(String(projectRoot ?? ''));
  const status = await projectAutopilotStatus(root, { isAlive });
  if (status.status === 'running') {
    return {
      ok: true,
      status: 'running',
      pid: status.pid,
      skipped: true,
      result: `autopilot already running (pid ${status.pid})`,
    };
  }

  const spawn = spawnImpl;
  if (typeof spawn !== 'function') {
    return { ok: false, status: 'error', result: 'spawnImpl is required' };
  }

  const argv = projectAutopilotArgv(root, {
    swarmEntryPath,
    intervalSec,
    once,
    maxSteps,
    legacyPlan,
  });
  const workdir = cwd ?? root;

  try {
    const child = spawn(execPath, argv, {
      detached: true,
      stdio: 'ignore',
      env,
      cwd: workdir,
    });
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (out) => {
        if (settled) return;
        settled = true;
        resolve(out);
      };
      child.once('error', (error) => finish({
        ok: false,
        status: 'error',
        result: String(error?.message ?? error),
      }));
      queueMicrotask(() => {
        if (settled) return;
        child.unref();
        finish({
          ok: true,
          status: 'started',
          pid: child.pid ?? null,
          skipped: false,
          result: `started swarm autopilot (pid ${child.pid})`,
        });
      });
    });
  } catch (error) {
    return { ok: false, status: 'error', result: String(error?.message ?? error) };
  }
}
