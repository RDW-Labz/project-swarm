// SPDX-License-Identifier: Apache-2.0
// One autopilot per project: a lock file with the owner's PID and per-acquisition token.
// A lock left by a process that is gone is cleared.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

function lockIsHeldByOther(owner, pid, token, isAlive) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  if (!isAlive(owner.pid)) return false;
  return owner.pid !== pid || owner.token !== token;
}

export async function acquireAutopilotLock(root, { pid = process.pid, isAlive = alive, name = 'autopilot' } = {}) {
  const token = randomBytes(16).toString('hex');
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, `${name}.lock`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assertRegularOrMissing(file);
    const tempFile = path.join(dir, `${name}.lock.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(tempFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        const record = { pid, token, startedAt: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(record)}\n`);
      } finally {
        await handle.close();
      }
      try {
        await fs.link(tempFile, file);
        await fs.unlink(tempFile);
      } catch (linkError) {
        await fs.rm(tempFile, { force: true });
        if (linkError.code !== 'EEXIST') throw linkError;
        let owner = null;
        try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch { owner = null; }
        if (lockIsHeldByOther(owner, pid, token, isAlive)) {
          throw Object.assign(new Error(`${name}-running: pid ${owner.pid} already runs ${name} for this project`), { code: `${name}-running` });
        }
        await fs.rm(file, { force: true });
        continue;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(await fs.readFile(file, 'utf8'));
          if (owner.pid === pid && owner.token === token) await fs.rm(file, { force: true });
        } catch { /* already gone */ }
      };
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      if (error.code === `${name}-running`) throw error;
      if (error.code === 'EEXIST' && error.syscall === 'open') continue;
      throw error;
    }
  }
  throw Object.assign(new Error(`${name}-lock-busy: could not take the lock`), { code: `${name}-running` });
}
