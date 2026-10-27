// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';
import { acquireAutopilotLock } from './autopilot-lock.mjs';

const MAX_ITEMS = 50;
const GOAL_LIMIT = 2000;
const PATH_LIMIT = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const STATUSES = new Set(['queued', 'started', 'done']);
const MAX_BACKUPS = 10;

function fail(code, detail = '') {
  return new Error(detail ? `${code}: ${detail}` : code);
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

async function rotateBacklogBackup(root, version, payloadText) {
  try {
    const dir = await safeWritableDir(await resolvedRoot(root), ['.swarm', 'project', 'backlog-backups']);
    const backupFile = path.join(dir, `backlog.${version}.json`);
    await fs.writeFile(backupFile, payloadText, { mode: 0o600 });
    const entries = await fs.readdir(dir);
    const versions = entries
      .filter(name => /^backlog\.\d+\.json$/.test(name))
      .map(name => Number(name.slice('backlog.'.length, -'.json'.length)))
      .filter(n => Number.isInteger(n))
      .sort((a, b) => b - a);
    for (const old of versions.slice(MAX_BACKUPS)) {
      await fs.rm(path.join(dir, `backlog.${old}.json`), { force: true });
    }
  } catch {
    /* best-effort */
  }
}

async function writeBacklog(root, items, expectedVersion, { allowSingleRemoval = false, allowBulkReplace = false } = {}) {
  const current = await readBacklogOnDisk(root);
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
  const dir = await safeWritableDir(await resolvedRoot(root), ['.swarm', 'project']);
  const file = path.join(dir, 'backlog.json');
  await assertRegularOrMissing(file);
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
  await rotateBacklogBackup(root, nextVersion, payloadText);
}

function normalizeList(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw fail('backlog-paths-invalid', 'expected an array of folders');
  return [...new Set(paths.map(normalizePath))];
}

export async function addGoal(root, { goal, paths = [], maxUsd, id } = {}, { now = Date.now } = {}) {
  if (typeof goal !== 'string' || goal.trim() === '' || [...goal].length > GOAL_LIMIT) {
    throw fail('backlog-goal-invalid', `1-${GOAL_LIMIT} characters`);
  }
  const list = normalizeList(paths);
  if (maxUsd !== undefined && !(Number.isFinite(maxUsd) && maxUsd > 0)) throw fail('backlog-max-usd-invalid');
  if (id !== undefined && (typeof id !== 'string' || !ID_RE.test(id))) throw fail('backlog-id-invalid');
  const releaseLock = await acquireAutopilotLock(root, { name: 'backlog' });
  try {
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
    await writeBacklog(root, [...data.items, item], data.version);
    return item;
  } finally {
    await releaseLock();
  }
}

export async function removeGoal(root, id) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'backlog' });
  try {
    const data = await readBacklogOnDisk(root);
    const index = data.items.findIndex(entry => entry.id === id);
    if (index < 0) throw fail('backlog-unknown', String(id));
    const nextItems = data.items.filter(entry => entry.id !== id);
    await writeBacklog(root, nextItems, data.version, { allowSingleRemoval: true });
    return data.items[index];
  } finally {
    await releaseLock();
  }
}

async function transition(root, id, from, to, extra) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'backlog' });
  try {
    const data = await readBacklogOnDisk(root);
    const item = data.items.find(entry => entry.id === id);
    if (!item) throw fail('backlog-unknown', String(id));
    if (item.status !== from) {
      throw fail(from === 'queued' ? 'backlog-not-queued' : 'backlog-not-started', `${id} is ${item.status}`);
    }
    const nextItems = data.items.map(entry => (entry.id === id ? { ...entry, status: to, ...extra } : entry));
    await writeBacklog(root, nextItems, data.version);
    return nextItems.find(entry => entry.id === id);
  } finally {
    await releaseLock();
  }
}

export async function markStarted(root, id, runId) {
  if (typeof runId !== 'string' || runId.trim() === '') throw fail('backlog-run-invalid');
  return transition(root, id, 'queued', 'started', { run: runId.trim() });
}

export async function markDone(root, id) {
  return transition(root, id, 'started', 'done', {});
}

export async function moveGoal(root, id, { to } = {}) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'backlog' });
  try {
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
    await writeBacklog(root, nextItems, data.version);
    return moved;
  } finally {
    await releaseLock();
  }
}

export async function exportBacklog(root) {
  return readBacklog(root);
}

export async function importBacklog(root, { items } = {}) {
  if (!Array.isArray(items)) throw fail('backlog-invalid', 'items missing');
  items.forEach(item => validateStored(item));
  const releaseLock = await acquireAutopilotLock(root, { name: 'backlog' });
  try {
    const data = await readBacklogOnDisk(root);
    await writeBacklog(root, items.map(item => ({ ...item })), data.version, { allowBulkReplace: true });
    return { items, version: data.version + 1 };
  } finally {
    await releaseLock();
  }
}

/** @internal Used by tests to exercise write guards without a public mutation API. */
export async function __testWriteBacklog(root, items, expectedVersion, options) {
  const releaseLock = await acquireAutopilotLock(root, { name: 'backlog' });
  try {
    await writeBacklog(root, items, expectedVersion, options);
  } finally {
    await releaseLock();
  }
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
