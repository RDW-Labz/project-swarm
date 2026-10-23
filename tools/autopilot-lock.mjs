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

function staleTakeoverJudgment(owner) {
  if (Number.isInteger(owner?.pid) && owner.pid > 0) return { type: 'dead_pid', pid: owner.pid };
  return { type: 'unparseable' };
}

function quarantinedContentStillStale(raw, judgment, isAlive) {
  let owner = null;
  try { owner = JSON.parse(raw); } catch { owner = null; }
  if (judgment.type === 'dead_pid') {
    if (owner?.pid !== judgment.pid) return false;
    return !isAlive(owner.pid);
  }
  if (!raw || String(raw).trim() === '') return true;
  if (owner === null) return true;
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return true;
  return !isAlive(owner.pid);
}

/** @returns {'restored' | 'file_reclaimed'} */
async function restoreQuarantineLink(quarantinePath, file) {
  await fs.chmod(quarantinePath, 0o600).catch(() => {});
  try {
    await fs.link(quarantinePath, file);
    await fs.unlink(quarantinePath);
    return 'restored';
  } catch (error) {
    if (error.code === 'EEXIST') {
      await fs.rm(quarantinePath, { force: true }).catch(() => {});
      return 'file_reclaimed';
    }
    throw error;
  }
}

async function quarantineStaleTakeover(file, judgment, isAlive, hooks) {
  await hooks?.afterStaleJudgmentBeforeQuarantine?.();
  const quarantinePath = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.quarantine`;
  try {
    await fs.rename(file, quarantinePath);
  } catch (renameError) {
    if (renameError.code === 'ENOENT') return 'retry';
    throw renameError;
  }
  await hooks?.afterQuarantineRename?.(quarantinePath);
  let quarantinedRaw = '';
  let readOk = false;
  try {
    quarantinedRaw = await fs.readFile(quarantinePath, 'utf8');
    readOk = true;
  } catch {
    readOk = false;
  }
  if (!readOk) {
    const restore = await restoreQuarantineLink(quarantinePath, file);
    return restore === 'file_reclaimed' ? 'live_stolen_backoff' : 'retry';
  }
  if (!quarantinedContentStillStale(quarantinedRaw, judgment, isAlive)) {
    await restoreQuarantineLink(quarantinePath, file);
    return 'live_stolen_backoff';
  }
  await fs.rm(quarantinePath, { force: true });
  return 'cleared';
}

function defaultContentionBackoffMs() {
  return 20 + Math.floor(Math.random() * 61);
}

const LOCK_ACQUIRE_ATTEMPTS = 10;

export async function acquireAutopilotLock(root, {
  pid = process.pid,
  isAlive = alive,
  name = 'autopilot',
  afterStaleJudgmentBeforeQuarantine,
  afterQuarantineRename,
  contentionBackoff = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const token = randomBytes(16).toString('hex');
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, `${name}.lock`);
  const quarantineHooks = { afterStaleJudgmentBeforeQuarantine, afterQuarantineRename };
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
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
        const takeover = await quarantineStaleTakeover(
          file,
          staleTakeoverJudgment(owner),
          isAlive,
          quarantineHooks,
        );
        if (takeover === 'live_stolen_backoff') {
          await contentionBackoff(defaultContentionBackoffMs());
        }
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
