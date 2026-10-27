// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

const OPEN_FLAGS = fssync.constants.O_WRONLY
  | fssync.constants.O_CREAT
  | fssync.constants.O_EXCL
  | fssync.constants.O_NOFOLLOW;

const BREAK_SUFFIX = '.break';

/** @type {Map<string, Promise<void>>} */
const pathQueues = new Map();

/** Resolved lock paths held by the current async call chain (withFileLock only). */
const heldPaths = new AsyncLocalStorage();

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

function lockError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Best-effort process start time (`ps -o lstart=`); null when unavailable. Never throws. */
function readProcessStartTime(pid) {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      // lstart text depends on the caller's time zone and locale; pin both so holder and waiter agree.
      const env = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env }, (error, stdout) => {
        if (error) return resolve(null);
        const text = String(stdout).trim().replace(/\s+/g, ' ');
        resolve(text || null);
      });
    } catch {
      resolve(null);
    }
  });
}

let ownStartTimePromise = null;
function ownProcessStartTime() {
  ownStartTimePromise ??= readProcessStartTime(process.pid);
  return ownStartTimePromise;
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

function lockAgeMs(owner, now) {
  const started = Date.parse(owner.startedAt);
  if (!Number.isFinite(started)) return Infinity;
  return Math.max(0, now() - started);
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

/** True when the pid is gone, or its start time differs from the recorded one (pid reuse). */
async function ownerIsDead(owner) {
  if (!isAlive(owner.pid)) return true;
  if (typeof owner.ownerStartedAt === 'string' && owner.ownerStartedAt) {
    const current = await readProcessStartTime(owner.pid);
    if (current && current !== owner.ownerStartedAt) return true;
  }
  return false;
}

/**
 * `watch` carries the previous observation between polls: a live owner's lock is stale only when
 * its mtime (heartbeat) is older than maxHoldMs AND was seen unchanged for at least two heartbeat
 * intervals of monotonic time (process.hrtime), so neither a wall-clock jump nor a machine sleep
 * alone breaks a lock that is still being refreshed.
 */
async function classifyLock(lockPath, { graceMs, maxHoldMs, now }, watch) {
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
    watch.last = null;
    const age = now() - snapshot.mtimeMs;
    if (age < graceMs) return { kind: 'busy', snapshot };
    return { kind: 'stale', snapshot };
  }

  if (await ownerIsDead(owner)) {
    watch.last = null;
    return { kind: 'stale', snapshot };
  }

  const prev = watch.last;
  const nowNs = process.hrtime.bigint();
  const unchanged = prev
    && prev.inode === snapshot.inode
    && prev.mtimeMs === snapshot.mtimeMs
    && prev.content === snapshot.content;
  watch.last = {
    inode: snapshot.inode,
    mtimeMs: snapshot.mtimeMs,
    content: snapshot.content,
    firstSeenNs: unchanged ? prev.firstSeenNs : nowNs,
  };
  // hrtime does not advance during machine sleep, so a wake-up never counts as missed heartbeats.
  const heartbeatNs = BigInt(heartbeatIntervalMs(maxHoldMs)) * 1_000_000n;
  const unchangedLongEnough = unchanged && nowNs - watch.last.firstSeenNs >= 2n * heartbeatNs;
  if (unchangedLongEnough && now() - snapshot.mtimeMs > maxHoldMs) {
    return { kind: 'stale', snapshot };
  }
  return { kind: 'held', owner, holdAge: lockAgeMs(owner, now) };
}

/** Remove the file only if it is still exactly the snapshotted one (inode, mtime, content). */
async function removeIfSame(filePath, snapshot) {
  if (!snapshot) return false;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.ino !== snapshot.inode) return false;
    if (stat.mtimeMs !== snapshot.mtimeMs) return false;
    const content = await fs.readFile(filePath, 'utf8');
    if (content !== snapshot.content) return false;
    await fs.unlink(filePath);
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

async function createLockAtomically(lockPath, owner, link = fs.link) {
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
      await link(tempPath, lockPath);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw Object.assign(new Error('file-lock-exists'), { code: 'EEXIST' });
      }
      if (error.code === 'EPERM' || error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP') {
        throw lockError(
          'file-lock-unsupported-fs',
          `file-lock-unsupported-fs: folder ${dir} does not support hard links (${error.code}); file locks need a filesystem with link()`,
        );
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

/** A break lock is stale when its owner is dead or its mtime is older than breakStaleMs. */
async function clearStaleBreakLock(breakPath, { breakStaleMs, now }) {
  let snapshot;
  try {
    snapshot = await readLockSnapshot(breakPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'file-lock-refused') throw error;
    return false;
  }
  const owner = parseOwner(snapshot.content);
  const old = now() - snapshot.mtimeMs > breakStaleMs;
  const stale = owner ? (await ownerIsDead(owner)) || old : old;
  if (!stale) return false;
  return removeIfSame(breakPath, snapshot);
}

/**
 * Serialize stale-lock breaking with a short-lived `<lock>.break` lock, and re-check inside it that
 * the lock file is still the very same stale one before removing. Returns true when removed.
 */
async function breakStaleLock(lockPath, snapshot, options) {
  const breakPath = `${lockPath}${BREAK_SUFFIX}`;
  const breakOwner = {
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    startedAt: new Date().toISOString(),
  };
  try {
    await createLockAtomically(breakPath, breakOwner, options.link);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await clearStaleBreakLock(breakPath, options);
    return false;
  }
  try {
    if (options.hooks?.onBreakLocked) await options.hooks.onBreakLocked();
    return await removeIfSame(lockPath, snapshot);
  } finally {
    await releaseLock(breakPath, breakOwner).catch(() => {});
  }
}

function heartbeatIntervalMs(maxHoldMs) {
  return Math.max(1, Math.floor(maxHoldMs / 4));
}

function startHeartbeat(lockPath, owner, maxHoldMs) {
  const intervalMs = heartbeatIntervalMs(maxHoldMs);
  let stopped = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const current = parseOwner(await fs.readFile(lockPath, 'utf8'));
      if (!stopped && current && current.token === owner.token && current.pid === owner.pid) {
        const when = new Date();
        await fs.utimes(lockPath, when, when);
      }
    } catch {
      /* best effort: a missed beat is covered by the maxHoldMs margin */
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function runWithPathMutex(resolvedPath, deadline, waitMs, task) {
  const previous = pathQueues.get(resolvedPath) ?? Promise.resolve();
  let releaseMutex;
  const gate = new Promise(resolve => {
    releaseMutex = resolve;
  });
  const tail = previous.then(() => gate);
  pathQueues.set(resolvedPath, tail);
  tail.then(() => {
    if (pathQueues.get(resolvedPath) === tail) pathQueues.delete(resolvedPath);
  });

  let timer;
  const timedOut = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
  });
  let outcome;
  try {
    outcome = await Promise.race([previous.then(() => 'ready'), timedOut]);
  } finally {
    clearTimeout(timer);
  }
  if (outcome === 'timeout') {
    // Free our slot so later waiters still chain behind the previous holder.
    releaseMutex();
    throw lockError('file-lock-timeout', `file-lock-timeout: waited ${waitMs}ms for the in-process holder of ${resolvedPath}`);
  }
  try {
    return await task(releaseMutex);
  } catch (error) {
    releaseMutex();
    throw error;
  }
}

async function acquireOnDisk(lockPath, options, deadline) {
  const { pollMs, now } = options;
  const dir = path.dirname(lockPath);
  const token = crypto.randomBytes(16).toString('hex');
  const owner = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };
  const ownStart = await ownProcessStartTime();
  if (ownStart) owner.ownerStartedAt = ownStart;
  const watch = { last: null };

  while (true) {
    await cleanupDeadTempFiles(dir);

    try {
      await createLockAtomically(lockPath, owner, options.link);
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const state = await classifyLock(lockPath, options, watch);
    if (state.kind === 'absent') continue;

    if (state.kind === 'held') {
      if (Date.now() >= deadline) {
        throw lockError(
          'file-lock-timeout',
          `file-lock-timeout: held by pid ${state.owner.pid} for ${Math.round(state.holdAge)}ms`,
        );
      }
      await sleep(jitteredDelay(pollMs));
      continue;
    }

    if (state.kind === 'busy') {
      if (Date.now() >= deadline) {
        throw lockError('file-lock-timeout', 'file-lock-timeout: lock file busy (unreadable or empty)');
      }
      await sleep(jitteredDelay(pollMs));
      continue;
    }

    if (state.kind === 'stale') {
      const cleared = await breakStaleLock(lockPath, state.snapshot, options);
      if (cleared) {
        watch.last = null;
        continue;
      }
      if (Date.now() >= deadline) {
        throw lockError('file-lock-timeout', 'file-lock-timeout: stale lock could not be broken (break lock busy)');
      }
      await sleep(jitteredDelay(pollMs));
    }
  }
}

/** Delete the lock only if it still carries our token (re-read right before unlink). */
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
 * @typedef {object} FileLockOptions
 * @property {number} [waitMs]
 * @property {number} [graceMs]
 * @property {number} [maxHoldMs] heartbeat stops longer than this => a live owner's lock is stale
 * @property {number} [pollMs]
 * @property {number} [breakStaleMs] age after which a `.break` lock is stale
 * @property {() => number} [now] injectable clock used for staleness judgements
 * @property {(existing: string, newPath: string) => Promise<void>} [link] injectable link()
 * @property {{ onBreakLocked?: () => Promise<void> | void }} [hooks] test hooks
 */

/**
 * @param {string} lockPath
 * @param {FileLockOptions} [options]
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireFileLock(lockPath, {
  waitMs = 10_000,
  graceMs = 5000,
  maxHoldMs = 600_000,
  pollMs = 25,
  breakStaleMs = 5000,
  now = Date.now,
  link = fs.link,
  hooks,
} = {}) {
  const resolved = path.resolve(lockPath);
  if (heldPaths.getStore()?.has(resolved)) {
    throw lockError('file-lock-reentrant', `file-lock-reentrant: ${resolved} is already held by this call chain`);
  }
  await assertLockPathAllowed(resolved);

  const deadline = Date.now() + waitMs;
  return runWithPathMutex(resolved, deadline, waitMs, async releaseMutex => {
    const owner = await acquireOnDisk(
      resolved,
      { waitMs, graceMs, maxHoldMs, pollMs, breakStaleMs, now, link, hooks },
      deadline,
    );
    const stopHeartbeat = startHeartbeat(resolved, owner, maxHoldMs);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      stopHeartbeat();
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
 * @param {FileLockOptions} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, fn, options) {
  const resolved = path.resolve(lockPath);
  const release = await acquireFileLock(lockPath, options);
  try {
    const held = new Set(heldPaths.getStore() ?? []);
    held.add(resolved);
    return await heldPaths.run(held, fn);
  } finally {
    await release();
  }
}
