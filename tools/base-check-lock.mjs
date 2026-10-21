// SPDX-License-Identifier: Apache-2.0
// One base-check run at a time per git checkout (worktree root). Parallel `run` base gates in the
// same tree queue here instead of racing spawns and `.swarm/base-checks/` cache writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

const LOCK_FILE = 'base-check.lock';
const STALE_MS = 60000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function readOwner(file) {
  try {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (owner && typeof owner === 'object' && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string') return owner;
  } catch { /* unreadable or missing */ }
  return null;
}

async function tryTakeLock(file, { pid, startedAt }) {
  await assertRegularOrMissing(file);
  try {
    const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ pid, host: os.hostname(), startedAt })}\n`);
    } finally {
      await handle.close();
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        const owner = await readOwner(file);
        if (owner?.pid === pid && owner.host === os.hostname()) await fs.rm(file, { force: true });
      } catch { /* already gone */ }
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return null;
  }
}

function lockBusyError(owner) {
  const pid = owner?.pid ?? 'unknown';
  const started = owner?.startedAt ?? 'unknown';
  return Object.assign(new Error(`base-check-locked: another base check is running in this checkout (pid ${pid}, started ${started})`), { code: 'base-check-locked' });
}

export async function acquireBaseCheckLock(root, { pid = process.pid, isAlive = pidAlive, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitMs = null } = {}) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, LOCK_FILE);
  const started = now();
  for (;;) {
    const release = await tryTakeLock(file, { pid, startedAt: new Date(now()).toISOString() });
    if (release) return release;
    const owner = await readOwner(file);
    const stat = await fs.stat(file).catch(() => null);
    const stale = !owner
      || (owner.host === os.hostname() && !isAlive(owner.pid))
      || (stat && now() - stat.mtimeMs > STALE_MS);
    if (stale) {
      await fs.rm(file, { force: true });
      continue;
    }
    if (waitMs !== null && now() - started > waitMs) throw lockBusyError(owner);
    await sleep(Math.min(250, 40 + Math.floor((now() - started) / 80)));
  }
}

export async function withBaseCheckLock(root, fn, options) {
  const release = await acquireBaseCheckLock(root, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
