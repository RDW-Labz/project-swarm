// SPDX-License-Identifier: Apache-2.0
// One autopilot per project: a lock file with the owner's PID. A lock left by a process that is gone is cleared.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

const alive = isAlive;

function resolveAllowOwnerPid(name, allowOwnerPid, env) {
  if (name !== 'autopilot') return undefined;
  if (allowOwnerPid !== undefined && allowOwnerPid !== null) {
    if (Number.isInteger(allowOwnerPid) && allowOwnerPid > 0) return allowOwnerPid;
  }
  const fromEnv = Number(env?.SWARM_AUTOPILOT_PID);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : undefined;
}

export async function readLockOwner(root, name = 'autopilot') {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, `${name}.lock`);
  try {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
    return { pid: owner.pid, startedAt: owner.startedAt };
  } catch {
    return null;
  }
}

export async function acquireAutopilotLock(root, {
  pid = process.pid,
  isAlive = alive,
  name = 'autopilot',
  allowOwnerPid,
  parentPid = process.ppid,
  env = process.env,
} = {}) {
  const allowedOwnerPid = resolveAllowOwnerPid(name, allowOwnerPid, env);
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, `${name}.lock`);
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
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && isAlive(owner.pid)) {
      if (
        allowedOwnerPid !== undefined
        && owner.pid === allowedOwnerPid
        && parentPid === allowedOwnerPid
      ) {
        let released = false;
        return async () => {
          if (released) return;
          released = true;
        };
      }
      if (owner.pid !== pid) {
        throw Object.assign(new Error(`${name}-running: pid ${owner.pid} already runs ${name} for this project`), { code: `${name}-running` });
      }
    }
    // Dead owner or unreadable lock: clear it and try again.
    await fs.rm(file, { force: true });
  }
  throw Object.assign(new Error(`${name}-lock-busy: could not take the lock`), { code: `${name}-running` });
}
