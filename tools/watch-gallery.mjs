// SPDX-License-Identifier: Apache-2.0
// Swarm Watch gallery I/O (Phase 16). Node built-ins only.
import { readFile, writeFile, rename, mkdir, lstat, unlink } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { sanitizeWorkerText } from './worker-text.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KINDS = ['mockup', 'page'];
const COMMENT_MAX = 500;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function uiDir(root) {
  return path.join(root, '.swarm', 'ui');
}

function text(value, max = 200) {
  return value == null ? null : sanitizeWorkerText(value, max);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function lstatOrNull(p) {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

function normalizeResults(raw) {
  const src = raw && typeof raw === 'object' && raw.screens !== undefined ? raw.screens : raw;
  let entries = [];
  if (Array.isArray(src)) {
    entries = src;
  } else if (src && typeof src === 'object') {
    entries = Object.entries(src).map(([id, v]) => {
      const obj = v && typeof v === 'object' ? v : {};
      return { ...obj, id: obj.id ? obj.id : id };
    });
  }
  const map = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object' || !validId(e.id) || map.has(e.id)) continue;
    map.set(e.id, {
      id: e.id,
      verdict: e.pass === true ? 'pass' : 'fail',
      at: text(e.at, 200),
      score: typeof e.score === 'number' && Number.isFinite(e.score) ? e.score : null,
      fingerprint: typeof e.tree === 'string' && e.tree ? e.tree : null
    });
  }
  return map;
}

function keepComment(c) {
  return c && typeof c === 'object' && typeof c.text === 'string' && c.text.length <= COMMENT_MAX;
}

function cleanComment(c) {
  return {
    at: text(c.at, 200),
    text: sanitizeWorkerText(c.text, COMMENT_MAX),
    ticket: text(c.ticket, 200)
  };
}

function normalizeStored(raw) {
  const src = raw && typeof raw === 'object' && raw.screens && typeof raw.screens === 'object' && !Array.isArray(raw.screens) ? raw.screens : {};
  const map = new Map();
  for (const [id, v] of Object.entries(src)) {
    if (!validId(id)) continue;
    const obj = v && typeof v === 'object' ? v : {};
    const approved = obj.approved && typeof obj.approved === 'object' ? {
      at: text(obj.approved.at, 200),
      by: text(obj.approved.by, 200),
      fingerprint: typeof obj.approved.fingerprint === 'string' ? obj.approved.fingerprint : null
    } : null;
    const comments = Array.isArray(obj.comments)
      ? obj.comments.filter(keepComment).map(cleanComment)
      : [];
    map.set(id, { approved, comments });
  }
  return map;
}

export async function screenshotPath(root, id, kind) {
  if (!validId(id) || !KINDS.includes(kind)) return null;
  const dir = path.join(uiDir(root), id);
  const dirStat = await lstatOrNull(dir);
  if (!dirStat || !dirStat.isDirectory()) return null;
  const file = path.join(dir, kind + '.png');
  const st = await lstatOrNull(file);
  if (!st || !st.isFile()) return null;
  return path.resolve(file);
}

export async function readGallery(root) {
  const results = normalizeResults(await readJson(path.join(uiDir(root), 'results.json')));
  const stored = normalizeStored(await readJson(path.join(uiDir(root), 'gallery.json')));
  const screens = [];
  for (const id of [...results.keys()].sort()) {
    const r = results.get(id);
    const s = stored.get(id) || { approved: null, comments: [] };
    let approval = 'none';
    if (s.approved) {
      approval = r.fingerprint !== null && s.approved.fingerprint === r.fingerprint ? 'approved' : 'stale';
    }
    screens.push({
      id,
      verdict: r.verdict,
      at: r.at,
      score: r.score,
      hasMockup: (await screenshotPath(root, id, 'mockup')) !== null,
      hasPage: (await screenshotPath(root, id, 'page')) !== null,
      approval,
      comments: s.comments
    });
  }
  return { schema: 1, screens };
}

async function loadForWrite(root) {
  return {
    results: normalizeResults(await readJson(path.join(uiDir(root), 'results.json'))),
    stored: normalizeStored(await readJson(path.join(uiDir(root), 'gallery.json')))
  };
}

function requireScreen(results, id) {
  if (!validId(id) || !results.has(id)) {
    throw new Error('unknown screen: ' + String(id));
  }
}

async function writeGallery(root, stored) {
  const screens = {};
  for (const id of [...stored.keys()].sort()) {
    const s = stored.get(id);
    screens[id] = { approved: s.approved, comments: s.comments.filter(keepComment).map(cleanComment) };
  }
  const dir = uiDir(root);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'gallery.json');
  const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  const data = JSON.stringify({ version: 1, screens }, null, 2) + '\n';
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function approveScreens(root, ids, { by = 'owner', now = Date.now() } = {}) {
  const { results, stored } = await loadForWrite(root);
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    requireScreen(results, id);
    if (!results.get(id).fingerprint) throw new Error(`no fingerprint for ${id}; run swarm ui check`);
  }
  const at = new Date(now).toISOString();
  const who = text(by, 200) || 'owner';
  for (const id of list) {
    const entry = stored.get(id) || { approved: null, comments: [] };
    entry.approved = { at, by: who, fingerprint: results.get(id).fingerprint };
    stored.set(id, entry);
  }
  await writeGallery(root, stored);
  return { approved: [...new Set(list)] };
}

export async function addComment(root, id, body, { now = Date.now() } = {}) {
  const { results, stored } = await loadForWrite(root);
  requireScreen(results, id);
  const cleaned = text(body, COMMENT_MAX) || '';
  if (!cleaned) throw new Error('empty comment');
  const comment = { at: new Date(now).toISOString(), text: cleaned, ticket: null };
  const entry = stored.get(id) || { approved: null, comments: [] };
  entry.comments = [...entry.comments, comment];
  stored.set(id, entry);
  await writeGallery(root, stored);
  return comment;
}
