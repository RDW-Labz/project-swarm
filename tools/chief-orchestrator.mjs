// SPDX-License-Identifier: Apache-2.0
// One chief process per machine (when chief_orchestrator is on) plans work across registered projects.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRegularOrMissing } from './journal.mjs';
import { loadLocalConfig, resolveConfigPath } from './local-config.mjs';
import { machineConcurrency } from './lanes.mjs';
import { planCrossProjectWave } from './chief-slots.mjs';

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

export function chiefOrchestratorEnabled(config) {
  return config?.chief_orchestrator === true;
}

export function chiefMachineDir({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return path.dirname(resolveConfigPath({ env, home }));
}

export function chiefLockPath(machineDir, { name = 'chief' } = {}) {
  return path.join(machineDir, `${name}.lock`);
}

async function ensureMachineDir(machineDir) {
  await fs.mkdir(machineDir, { recursive: true, mode: 0o755 });
  const real = await fs.realpath(machineDir);
  const stat = await fs.lstat(real);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`chief-path-unsafe: ${real} is not a writable directory`);
  return real;
}

/** Machine-wide PID lock; same liveness pattern as tools/autopilot-lock.mjs. */
export async function acquireChiefLock(machineDir, { pid = process.pid, isAlive = alive, name = 'chief' } = {}) {
  const dir = await ensureMachineDir(machineDir);
  const file = chiefLockPath(dir, { name });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assertRegularOrMissing(file);
    try {
      const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`); } finally { await handle.close(); }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(await fs.readFile(file, 'utf8'));
          if (owner.pid === pid) await fs.rm(file, { force: true });
        } catch { /* already gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let owner = null;
    try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch { owner = null; }
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && owner.pid !== pid && isAlive(owner.pid)) {
      throw Object.assign(new Error(`${name}-running: pid ${owner.pid} already runs ${name} on this machine`), { code: `${name}-running` });
    }
    await fs.rm(file, { force: true });
  }
  throw Object.assign(new Error(`${name}-lock-busy: could not take the lock`), { code: `${name}-running` });
}

export async function acquireChiefLockIfEnabled(config, { env = process.env, pid = process.pid, isAlive = alive } = {}) {
  if (!chiefOrchestratorEnabled(config)) return async () => {};
  return acquireChiefLock(chiefMachineDir({ env }), { pid, isAlive });
}

/**
 * One chief wave: start ready tickets on every project that has work, within the machine cap.
 * @param {Array<{ project: string, ready: number, start?: (n: number) => Promise<void>|void }>} projects
 */
export async function runChiefWave(projects, { machineCap, plan = planCrossProjectWave } = {}) {
  if (!Number.isInteger(machineCap) || machineCap < 1) {
    throw Object.assign(new Error('machineCap must be a positive integer'), { code: 'bad-cap' });
  }
  const wave = plan(projects, machineCap);
  const byProject = new Map((projects ?? []).map(entry => [entry.project, entry]));
  const started = [];
  for (const { project, starts } of wave) {
    const entry = byProject.get(project);
    if (!entry || !starts) continue;
    if (typeof entry.start === 'function') await entry.start(starts);
    started.push({ project, starts });
  }
  return { wave, started };
}

export async function runChiefOnce({ env = process.env, config, projects, machineCap, plan } = {}) {
  const loaded = config ?? loadLocalConfig({ env });
  const release = await acquireChiefLockIfEnabled(loaded, { env });
  try {
    const cap = machineCap ?? machineConcurrency(loaded) ?? 1;
    return await runChiefWave(projects, { machineCap: cap, plan });
  } finally {
    await release();
  }
}

export const CHIEF_USAGE = 'Usage: node tools/chief-orchestrator.mjs run [--once] [--hold-ms MS]';

export async function runChiefCli(argv, { env = process.env, now = Date.now } = {}) {
  const args = [...argv];
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    throw Object.assign(new Error(CHIEF_USAGE), { code: 'chief-usage' });
  }
  if (args[0] !== 'run') throw Object.assign(new Error(CHIEF_USAGE), { code: 'chief-usage' });
  args.shift();
  let holdMs = 0;
  let once = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--once') { once = true; continue; }
    if (flag === '--hold-ms') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 0) throw Object.assign(new Error(CHIEF_USAGE), { code: 'chief-usage' });
      holdMs = value;
      continue;
    }
    throw Object.assign(new Error(CHIEF_USAGE), { code: 'chief-usage' });
  }
  const config = loadLocalConfig({ env });
  const release = await acquireChiefLockIfEnabled(config, { env });
  try {
    if (holdMs > 0) await new Promise(resolve => setTimeout(resolve, holdMs));
    else if (once) await runChiefOnce({ env, config, projects: [], machineCap: machineConcurrency(config) ?? 1 });
    return { ok: true, at: new Date(now()).toISOString(), heldMs: holdMs };
  } finally {
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runChiefCli(process.argv.slice(2), { env: process.env })
    .then(() => process.exit(0))
    .catch(error => {
      const message = error?.message ?? String(error);
      process.stderr.write(`${message}\n`);
      process.exit(error?.code === 'chief-running' || error?.code === 'chief-usage' ? 1 : 1);
    });
}
