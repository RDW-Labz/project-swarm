// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';
import { withFileLock, isAlive } from './file-lock.mjs';

const MAX_ITEMS = 50;
const GOAL_LIMIT = 2000;
const PATH_LIMIT = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const STATUSES = new Set(['queued', 'started', 'done']);
const MAX_BACKUPS = 10;
const LOCK_WAIT_MS = 120_000;
// Backlog holds last milliseconds, so a reused pid must not block writers for the 10 minute default.
const LOCK_MAX_HOLD_MS = 60_000;

let lockImpl = withFileLock;

const BACKUP_OPEN_FLAGS = fssync.constants.O_WRONLY
  | fssync.constants.O_CREAT
  | fssync.constants.O_TRUNC
  | fssync.constants.O_NOFOLLOW;

function fail(code, detail = '') {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  return err;
}

export function normalizePath(value) {
  if (typeof value !== 'string') throw fail('backlog-path-invalid', String(value));
  const text = value.trim();
  if (!text || text.length > PATH_LIMIT || path.isAbsolute(text) || text.includes('\\') || text.includes(String.fromCharCode(0))) {
    throw fail('backlog-path-invalid', value);
  }
  const parts = text.split('/').filter(part => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) throw fail('backlog-path-invalid', value);
  return parts.join('/');
}

function cleanClaim(value) {
  if (typeof value !== 'string') return '';
  return value.trim().split('/').filter(part => part !== '' && part !== '.').join('/');
}

function overlaps(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function validateStored(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ID_RE.test(item.id) ||
      typeof item.goal !== 'string' || !Array.isArray(item.paths) || !STATUSES.has(item.status)) {
    throw fail('backlog-invalid', 'item is malformed');
  }
}

function normalizeVersion(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0) throw fail('backlog-invalid', 'version must be a non-negative integer');
  return value;
}

// Returns the project folder when it exists; refuses symlinks on the way.
async function existingProjectDir(root) {
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const part of ['.swarm', 'project']) {
    current = path.join(current, part);
    let stat = null;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw fail('backlog-path-unsafe', `${current} is a symlink`);
    if (!stat.isDirectory()) throw fail('backlog-path-unsafe', `${current} is not a directory`);
  }
  return current;
}

async function resolvedRoot(root) {
  return fs.realpath(root);
}

async function backlogFile(root) {
  const dir = await existingProjectDir(root);
  if (!dir) {
    const writable = await safeWritableDir(await resolvedRoot(root), ['.swarm', 'project']);
    return path.join(writable, 'backlog.json');
  }
  return path.join(dir, 'backlog.json');
}

async function backlogLockFile(root) {
  const file = await backlogFile(root);
  return path.join(path.dirname(file), 'backlog.lock');
}

async function parseBacklogFile(file) {
  await assertRegularOrMissing(file);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { items: [], version: 0 };
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail('backlog-invalid', 'backlog.json is not JSON');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw fail('backlog-invalid', 'items missing');
  data.items.forEach(item => validateStored(item));
  return { items: data.items, version: normalizeVersion(data.version) };
}

export async function readBacklog(root) {
  const dir = await existingProjectDir(root);
  if (!dir) {
    const file = path.join(await resolvedRoot(root), '.swarm', 'project', 'backlog.json');
    return parseBacklogFile(file);
  }
  return parseBacklogFile(path.join(dir, 'backlog.json'));
}

async function readBacklogOnDisk(root) {
  return parseBacklogFile(await backlogFile(root));
}

async function readBacklogRawText(root) {
  const file = await backlogFile(root);
  await assertRegularOrMissing(file);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function rotateBacklogBackup(root, replacedVersion, payloadText) {
  try {
    const dir = await safeWritableDir(await resolvedRoot(root), ['.swarm', 'project', 'backlog-backups']);
    const backupFile = path.join(dir, `backlog.${replacedVersion}.json`);
    let handle;
    try {
      handle = await fs.open(backupFile, BACKUP_OPEN_FLAGS, 0o600);
      await handle.writeFile(payloadText);
      await handle.sync();
      await handle.close();
      handle = null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    const entries = await fs.readdir(dir);
    const backupPaths = [];
    for (const name of entries) {
      if (!/^backlog\.\d+\.json$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fs.lstat(full);
        if (st.isSymbolicLink()) continue;
        backupPaths.push({ full, mtimeMs: st.mtimeMs });
      } catch {
        /* skip */
      }
    }
    backupPaths.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of backupPaths.slice(MAX_BACKUPS)) {
      await fs.rm(entry.full, { force: true }).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

async function cleanupDeadBacklogTempFiles(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const prefix = '.backlog.';
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const middle = name.slice(prefix.length, -4);
    const pidStr = middle.split('.')[0];
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isAlive(pid)) continue;
    await fs.unlink(path.join(dir, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function fsyncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, fssync.constants.O_RDONLY | fssync.constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * @param {{ expectId?: string, present?: boolean }} [tripwire]
 */
async function writeBacklog(root, items, expectedVersion, { allowSingleRemoval = false, allowBulkReplace = false, tripwire } = {}) {
  const file = await backlogFile(root);
  const dir = path.dirname(file);
  await cleanupDeadBacklogTempFiles(dir);

  const replacedText = await readBacklogRawText(root);
  const current = replacedText === null
    ? { items: [], version: 0 }
    : await parseBacklogFile(file);

  if (current.version !== expectedVersion) throw fail('backlog-stale-write');
  const drop = current.items.length - items.length;
  if (drop > 0) {
    if (allowBulkReplace) {
      // intentional bulk replace
    } else if (drop === 1 && allowSingleRemoval) {
      // single removeGoal
    } else {
      throw fail('backlog-unexpected-drop');
    }
  }
  const nextVersion = expectedVersion + 1;
  const payload = { items, version: nextVersion };
  const payloadText = JSON.stringify(payload, null, 2) + '\n';
  await assertRegularOrMissing(file);

  if (replacedText !== null) {
    await rotateBacklogBackup(root, current.version, replacedText);
  }

  const tmp = path.join(dir, `.backlog.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(payloadText);
    await handle.sync();
    await handle.close();
    await fs.rename(tmp, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw error;
  }

  await fsyncDirectory(dir);
  await cleanupDeadBacklogTempFiles(dir);

  const after = await readBacklogOnDisk(root);
  if (after.version !== nextVersion) throw fail('backlog-write-lost');
  if (tripwire?.expectId !== undefined) {
    const found = after.items.some(entry => entry.id === tripwire.expectId);
    const wantPresent = tripwire.present !== false;
    if (wantPresent !== found) throw fail('backlog-write-lost');
  }
}

async function withBacklogLock(root, fn) {
  const lockPath = await backlogLockFile(root);
  try {
    return await lockImpl(lockPath, fn, { waitMs: LOCK_WAIT_MS, maxHoldMs: LOCK_MAX_HOLD_MS });
  } catch (error) {
    if (error.code === 'file-lock-timeout') {
      throw fail('backlog-lock-timeout', error.message);
    }
    throw error;
  }
}

function normalizeList(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw fail('backlog-paths-invalid', 'expected an array of folders');
  return [...new Set(paths.map(normalizePath))];
}

function normalizeImportItem(raw, { now = Date.now } = {}) {
  validateStored(raw);
  const id = raw.id;
  const goal = raw.goal;
  if (typeof goal !== 'string' || goal.trim() === '' || [...goal].length > GOAL_LIMIT) {
    throw fail('backlog-goal-invalid', `1-${GOAL_LIMIT} characters`);
  }
  const list = normalizeList(raw.paths ?? []);
  if (raw.maxUsd !== undefined && !(Number.isFinite(raw.maxUsd) && raw.maxUsd > 0)) {
    throw fail('backlog-max-usd-invalid');
  }
  if (!STATUSES.has(raw.status)) throw fail('backlog-invalid', 'item is malformed');
  const item = {
    id,
    goal: sanitizeText(goal.trim()),
    paths: list,
    ...(raw.maxUsd !== undefined ? { maxUsd: raw.maxUsd } : {}),
    addedAt: typeof raw.addedAt === 'string' && raw.addedAt ? raw.addedAt : new Date(now()).toISOString(),
    status: raw.status,
    ...(typeof raw.run === 'string' && raw.run ? { run: raw.run.trim() } : {}),
  };
  validateStored(item);
  return item;
}

function normalizeImportItems(items, options) {
  if (!Array.isArray(items)) throw fail('backlog-invalid', 'items missing');
  const seen = new Set();
  const normalized = [];
  for (const raw of items) {
    const item = normalizeImportItem(raw, options);
    if (seen.has(item.id)) throw fail('backlog-duplicate-id', item.id);
    seen.add(item.id);
    normalized.push(item);
  }
  if (normalized.length > MAX_ITEMS) throw fail('backlog-full', `at most ${MAX_ITEMS} items`);
  return normalized;
}

export async function addGoal(root, { goal, paths = [], maxUsd, id } = {}, { now = Date.now } = {}) {
  if (typeof goal !== 'string' || goal.trim() === '' || [...goal].length > GOAL_LIMIT) {
    throw fail('backlog-goal-invalid', `1-${GOAL_LIMIT} characters`);
  }
  const list = normalizeList(paths);
  if (maxUsd !== undefined && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw fail('backlog-max-usd-invalid');
  if (id !== undefined && (typeof id !== 'string' || !ID_RE.test(id))) throw fail('backlog-id-invalid');

  return withBacklogLock(root, async () => {
    const data = await readBacklogOnDisk(root);
    if (data.items.length >= MAX_ITEMS) throw fail('backlog-full', `at most ${MAX_ITEMS} items`);
    const itemId = id ?? `g-${crypto.randomBytes(4).toString('hex')}`;
    if (data.items.some(entry => entry.id === itemId)) throw fail('backlog-duplicate-id', itemId);
    const item = {
      id: itemId,
      goal: sanitizeText(goal.trim()),
      paths: list,
      ...(maxUsd !== undefined ? { maxUsd } : {}),
      addedAt: new Date(now()).toISOString(),
      status: 'queued',
    };
    await writeBacklog(root, [...data.items, item], data.version, { tripwire: { expectId: itemId, present: true } });
    return item;
  });
}

export async function removeGoal(root, id) {
  return withBacklogLock(root, async () => {
    const data = await readBacklogOnDisk(root);
    const index = data.items.findIndex(entry => entry.id === id);
    if (index < 0) throw fail('backlog-unknown', String(id));
    const nextItems = data.items.filter(entry => entry.id !== id);
    await writeBacklog(root, nextItems, data.version, {
      allowSingleRemoval: true,
      tripwire: { expectId: id, present: false },
    });
    return data.items[index];
  });
}

async function transition(root, id, from, to, extra) {
  return withBacklogLock(root, async () => {
    const data = await readBacklogOnDisk(root);
    const item = data.items.find(entry => entry.id === id);
    if (!item) throw fail('backlog-unknown', String(id));
    if (item.status !== from) {
      throw fail(from === 'queued' ? 'backlog-not-queued' : 'backlog-not-started', `${id} is ${item.status}`);
    }
    const nextItems = data.items.map(entry => (entry.id === id ? { ...entry, status: to, ...extra } : entry));
    await writeBacklog(root, nextItems, data.version, { tripwire: { expectId: id, present: true } });
    return nextItems.find(entry => entry.id === id);
  });
}

export async function markStarted(root, id, runId) {
  if (typeof runId !== 'string' || runId.trim() === '') throw fail('backlog-run-invalid');
  return transition(root, id, 'queued', 'started', { run: runId.trim() });
}

export async function markDone(root, id) {
  return transition(root, id, 'started', 'done', {});
}

export async function moveGoal(root, id, { to } = {}) {
  return withBacklogLock(root, async () => {
    const data = await readBacklogOnDisk(root);
    const fromIndex = data.items.findIndex(entry => entry.id === id);
    if (fromIndex < 0) throw fail('backlog-unknown', String(id));
    const nextItems = [...data.items];
    const [moved] = nextItems.splice(fromIndex, 1);
    if (to === 'top') {
      nextItems.unshift(moved);
    } else if (to === 'bottom') {
      nextItems.push(moved);
    } else if (to && typeof to === 'object' && typeof to.after === 'string') {
      const afterIndex = nextItems.findIndex(entry => entry.id === to.after);
      if (afterIndex < 0) throw fail('backlog-unknown', String(to.after));
      nextItems.splice(afterIndex + 1, 0, moved);
    } else {
      throw fail('backlog-invalid', 'move target is malformed');
    }
    if (nextItems.length !== data.items.length) throw fail('backlog-invalid', 'move changed item count');
    await writeBacklog(root, nextItems, data.version, { tripwire: { expectId: id, present: true } });
    return moved;
  });
}

export async function exportBacklog(root) {
  return readBacklog(root);
}

export async function importBacklog(root, { items, replace } = {}, { now = Date.now } = {}) {
  const normalized = normalizeImportItems(items, { now });

  return withBacklogLock(root, async () => {
    const data = await readBacklogOnDisk(root);
    const incoming = new Set(normalized.map(item => item.id));
    const disappearing = data.items.filter(entry => !incoming.has(entry.id)).length;
    const needsReplace = disappearing > 1 || normalized.length === 0;
    if (needsReplace && replace !== true) throw fail('backlog-unexpected-drop');
    await writeBacklog(root, normalized.map(item => ({ ...item })), data.version, {
      allowBulkReplace: true,
      tripwire: normalized.length === 1
        ? { expectId: normalized[0].id, present: true }
        : undefined,
    });
    return { items: normalized, version: data.version + 1 };
  });
}

/** @internal Test-only: swap the lock function to spy on its options; returns a restore function. */
export function __testSetLockImpl(impl) {
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error('__testSetLockImpl is only available under the test runner');
  }
  const previous = lockImpl;
  lockImpl = impl;
  return () => {
    lockImpl = previous;
  };
}

/** @internal Used by tests to exercise write guards without a public mutation API. */
export async function __testWriteBacklog(root, items, expectedVersion, options) {
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error('__testWriteBacklog is only available under the test runner');
  }
  return withBacklogLock(root, async () => {
    await writeBacklog(root, items, expectedVersion, options);
  });
}

export function nextStartable(items, { activeClaims = [] } = {}) {
  const claims = (activeClaims ?? []).map(cleanClaim).filter(Boolean);
  for (const item of items) {
    if (item.status !== 'queued') continue;
    const paths = (item.paths ?? []).map(cleanClaim).filter(Boolean);
    if (paths.length === 0) {
      if (claims.length === 0) return item;
      continue;
    }
    if (paths.some(p => claims.some(c => overlaps(p, c)))) continue;
    return item;
  }
  return null;
}
