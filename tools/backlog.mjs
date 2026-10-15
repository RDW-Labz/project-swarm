// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';

const MAX_ITEMS = 50;
const GOAL_LIMIT = 2000;
const PATH_LIMIT = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const STATUSES = new Set(['queued', 'started', 'done']);

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

export async function readBacklog(root) {
  const dir = await existingProjectDir(root);
  if (!dir) return { items: [] };
  const file = path.join(dir, 'backlog.json');
  await assertRegularOrMissing(file);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { items: [] };
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
  return { items: data.items };
}

async function writeBacklog(root, data) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'backlog.json');
  await assertRegularOrMissing(file);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
  } finally {
    await handle.close();
  }
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
  const data = await readBacklog(root);
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
  await writeBacklog(root, { items: [...data.items, item] });
  return item;
}

export async function removeGoal(root, id) {
  const data = await readBacklog(root);
  const index = data.items.findIndex(entry => entry.id === id);
  if (index < 0) throw fail('backlog-unknown', String(id));
  const [removed] = data.items.splice(index, 1);
  await writeBacklog(root, data);
  return removed;
}

async function transition(root, id, from, to, extra) {
  const data = await readBacklog(root);
  const item = data.items.find(entry => entry.id === id);
  if (!item) throw fail('backlog-unknown', String(id));
  if (item.status !== from) {
    throw fail(from === 'queued' ? 'backlog-not-queued' : 'backlog-not-started', `${id} is ${item.status}`);
  }
  Object.assign(item, { status: to }, extra);
  await writeBacklog(root, data);
  return item;
}

export async function markStarted(root, id, runId) {
  if (typeof runId !== 'string' || runId.trim() === '') throw fail('backlog-run-invalid');
  return transition(root, id, 'queued', 'started', { run: runId.trim() });
}

export async function markDone(root, id) {
  return transition(root, id, 'started', 'done', {});
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
