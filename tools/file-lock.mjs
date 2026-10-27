// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

const OPEN_FLAGS = fssync.constants.O_WRONLY
  | fssync.constants.O_CREAT
  | fssync.constants.O_EXCL
  | fssync.constants.O_NOFOLLOW;

/** @type {Map<string, Promise<void>>} */
const pathQueues = new Map();

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function jitteredDelay(pollMs) {
  const min = pollMs;
  const max = pollMs * 4;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tempNamePrefix() {
  return '.file-lock-';
}

function tempNameFor(pid, token) {
  return `${tempNamePrefix()}${pid}-${token}.tmp`;
}

function parseOwner(text) {
  if (!text || !text.trim()) return null;
  try {
    const owner = JSON.parse(text);
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
    if (typeof owner.token !== 'string' || owner.token.length !== 32) return null;
    if (typeof owner.startedAt !== 'string' || !owner.startedAt) return null;
    return owner;
  } catch {
    return null;
  }
}

function lockAgeMs(owner) {
  const started = Date.parse(owner.startedAt);
  if (!Number.isFinite(started)) return Infinity;
  return Date.now() - started;
}

async function assertLockPathAllowed(lockPath) {
  const resolved = path.resolve(lockPath);
  const parent = path.dirname(resolved);
  try {
    const parentStat = await fs.lstat(parent);
    if (parentStat.isSymbolicLink()) {
      throw Object.assign(new Error('file-lock-refused: lock parent is a symlink'), { code: 'file-lock-refused' });
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // parent may be created below; walk up for symlinks on existing segments
      let cur = parent;
      const root = path.parse(cur).root;
      while (cur !== root) {
        try {
          const st = await fs.lstat(cur);
          if (st.isSymbolicLink()) {
            throw Object.assign(new Error('file-lock-refused: lock parent is a symlink'), { code: 'file-lock-refused' });
          }
        } catch (e) {
          if (e.code === 'file-lock-refused') throw e;
          if (e.code !== 'ENOENT') throw e;
        }
        cur = path.dirname(cur);
      }
      return;
    }
    throw error;
  }
  try {
    const lockStat = await fs.lstat(resolved);
    if (lockStat.isSymbolicLink()) {
      throw Object.assign(new Error('file-lock-refused: lock path is a symlink'), { code: 'file-lock-refused' });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readLockSnapshot(lockPath) {
  const stat = await fs.lstat(lockPath);
  if (stat.isSymbolicLink()) {
    throw Object.assign(new Error('file-lock-refused: lock path is a symlink'), { code: 'file-lock-refused' });
  }
  const content = await fs.readFile(lockPath, 'utf8');
  return { inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, content };
}

async function classifyLock(lockPath, graceMs, maxHoldMs) {
  let snapshot;
  try {
    snapshot = await readLockSnapshot(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'absent' };
    if (error.code === 'file-lock-refused') throw error;
    return { kind: 'busy', snapshot: null };
  }

  const owner = parseOwner(snapshot.content);
  if (!owner) {
    const age = Date.now() - snapshot.mtimeMs;
    if (age < graceMs) return { kind: 'busy', snapshot };
    return { kind: 'stale', snapshot };
  }

  const holdAge = lockAgeMs(owner);
  if (isAlive(owner.pid) && holdAge < maxHoldMs) {
    return { kind: 'held', owner, holdAge };
  }
  return { kind: 'stale', snapshot };
}

async function compareAndDeleteStale(lockPath, snapshot) {
  if (!snapshot) return false;
  try {
    const stat = await fs.lstat(lockPath);
    if (stat.ino !== snapshot.inode) return false;
    const content = await fs.readFile(lockPath, 'utf8');
    if (content !== snapshot.content) return false;
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function cleanupDeadTempFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const prefix = tempNamePrefix();
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const rest = name.slice(prefix.length, -4);
    const pidStr = rest.split('-')[0];
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isAlive(pid)) continue;
    await fs.unlink(path.join(dir, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function createLockAtomically(lockPath, owner) {
  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, tempNameFor(owner.pid, owner.token));
  let handle;
  try {
    handle = await fs.open(tempPath, OPEN_FLAGS, 0o600);
    const body = `${JSON.stringify(owner)}\n`;
    await handle.write(body);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(tempPath, lockPath);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw Object.assign(new Error('file-lock-exists'), { code: 'EEXIST' });
      }
      throw error;
    }
    return owner;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function runWithPathMutex(resolvedPath, task) {
  const previous = pathQueues.get(resolvedPath) ?? Promise.resolve();
  let releaseMutex;
  const gate = new Promise(resolve => {
    releaseMutex = resolve;
  });
  const tail = previous.then(() => gate);
  pathQueues.set(resolvedPath, tail.catch(() => {}));
  await previous;
  try {
    return await task(releaseMutex);
  } catch (error) {
    releaseMutex();
    throw error;
  }
}

async function acquireOnDisk(lockPath, options) {
  const { waitMs, graceMs, maxHoldMs, pollMs } = options;
  const dir = path.dirname(lockPath);
  const deadline = Date.now() + waitMs;
  const token = crypto.randomBytes(16).toString('hex');
  const owner = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  while (true) {
    await cleanupDeadTempFiles(dir);

    try {
      await createLockAtomically(lockPath, owner);
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const state = await classifyLock(lockPath, graceMs, maxHoldMs);
    if (state.kind === 'absent') continue;

    if (state.kind === 'held') {
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(
            `file-lock-timeout: held by pid ${state.owner.pid} for ${Math.round(state.holdAge)}ms`,
          ),
          { code: 'file-lock-timeout' },
        );
      }
      await sleep(jitteredDelay(pollMs));
      continue;
    }

    if (state.kind === 'busy') {
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error('file-lock-timeout: lock file busy (unreadable or empty)'),
          { code: 'file-lock-timeout' },
        );
      }
      await sleep(jitteredDelay(pollMs));
      continue;
    }

    if (state.kind === 'stale') {
      const cleared = await compareAndDeleteStale(lockPath, state.snapshot);
      if (cleared) continue;
      await sleep(jitteredDelay(pollMs));
    }
  }
}

async function releaseLock(lockPath, owner) {
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const current = parseOwner(content);
    if (current && current.token === owner.token && current.pid === owner.pid) {
      await fs.unlink(lockPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

/**
 * @param {string} lockPath
 * @param {{ waitMs?: number, graceMs?: number, maxHoldMs?: number, pollMs?: number }} [options]
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireFileLock(lockPath, {
  waitMs = 10_000,
  graceMs = 5000,
  maxHoldMs = 600_000,
  pollMs = 25,
} = {}) {
  const resolved = path.resolve(lockPath);
  await assertLockPathAllowed(resolved);

  return runWithPathMutex(resolved, async releaseMutex => {
    const owner = await acquireOnDisk(resolved, { waitMs, graceMs, maxHoldMs, pollMs });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await releaseLock(resolved, owner);
      } finally {
        releaseMutex();
      }
    };
  });
}

/**
 * @template T
 * @param {string} lockPath
 * @param {() => T | Promise<T>} fn
 * @param {{ waitMs?: number, graceMs?: number, maxHoldMs?: number, pollMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, fn, options) {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
