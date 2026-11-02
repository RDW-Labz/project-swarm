// SPDX-License-Identifier: Apache-2.0
// Swarm history: a permanent, append-only log of every project, stage, run, PR, merge, lesson and spend, machine-wide.
// One JSON line per event in ~/.project-swarm/history/history.ndjson. Nothing is ever rewritten or deleted here; an event with a `key`
// that is already in the log is not added again, so a backfill can be run any number of times.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizeWorkerText } from './worker-text.mjs';

export const HISTORY_KINDS = Object.freeze(['project', 'stage', 'run', 'pr', 'merge', 'lesson', 'spend']);
export const historyFile = (env = process.env, home = os.homedir()) => env.SWARM_HISTORY_FILE || path.join(home, '.project-swarm', 'history', 'history.ndjson');
const clean = (v, n = 200) => sanitizeWorkerText(v ?? '', n);

let queue = Promise.resolve();
const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

export function normalizeEvent(event, now = Date.now) {
  if (!event || typeof event !== 'object' || !HISTORY_KINDS.includes(event.kind)) return null;
  const at = Number.isFinite(Date.parse(event.at)) ? new Date(event.at).toISOString() : new Date(now()).toISOString();
  const url = typeof event.url === 'string' && /^https:\/\/[A-Za-z0-9.-]+(?:\/[\w./?=&%#~+-]*)?$/.test(event.url) ? event.url.slice(0, 300) : null;
  return {
    at, project: clean(event.project, 80), projectId: clean(event.projectId, 20) || null, kind: event.kind,
    key: event.key ? clean(event.key, 200) : null, title: clean(event.title, 240),
    ref: event.ref ? clean(event.ref, 120) : null, run: event.run ? clean(event.run, 120) : null,
    usd: Number.isFinite(event.usd) && event.usd >= 0 ? Math.round(event.usd * 1e6) / 1e6 : null, url,
  };
}

// The whole log, parsed once per change of the file (path, size and mtime), every line normalised again on the way in, and a key seen twice kept once
// (two processes may both have appended it).
const cache = new Map();
async function readAll(file) {
  let stat;
  try { stat = await fs.stat(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.rows;
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { return []; }
  const seen = new Set();
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const row = normalizeEvent(e);
    if (!row) continue;
    if (row.key) { if (seen.has(row.key)) continue; seen.add(row.key); }
    rows.push(row);
  }
  cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
  return rows;
}

// Appends the events that are new (by key). Returns how many were added. Never throws into the caller's work: failures are returned as { error }.
export function appendHistory(events, { file = historyFile(), now = Date.now } = {}) {
  return serial(async () => {
    try {
      const list = (Array.isArray(events) ? events : [events]).map(e => normalizeEvent(e, now)).filter(Boolean);
      if (!list.length) return { added: 0 };
      const seen = new Set((await readAll(file)).map(e => e.key).filter(Boolean));
      const fresh = [];
      for (const e of list) { if (e.key) { if (seen.has(e.key)) continue; seen.add(e.key); } fresh.push(e); }
      if (!fresh.length) return { added: 0 };
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // A torn last line (a crash mid-write) must not swallow the next event: start on a fresh line.
      let lead = '';
      try { const handle = await fs.open(file, 'r'); try { const { size } = await handle.stat(); if (size > 0) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 10) lead = '\n'; } } finally { await handle.close(); } } catch { /* a new file */ }
      await fs.appendFile(file, lead + fresh.map(e => `${JSON.stringify(e)}\n`).join(''), { mode: 0o600 });
      return { added: fresh.length };
    } catch (error) { return { added: 0, error: String(error.message).slice(0, 200) }; }
  });
}

// Newest first. Filters: project (name or id), kind, q (words, all must appear), from / to (dates or ISO times).
// `fold`: a pull request and its merge are one row (the merge, which links to the PR). `exclude`: project ids to leave out (test and temp projects).
export async function readHistory({ file = historyFile(), project, kind, q, from, to, limit = 200, offset = 0, cap = 1000, fold = false, exclude } = {}) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const fromMs = from ? Date.parse(from) : null, toMs = to ? Date.parse(to.length === 10 ? `${to}T23:59:59.999Z` : to) : null;
  const rows = (await readAll(file)).filter(e => {
    if (project && e.project !== project && e.projectId !== project) return false;
    if (exclude && exclude.has(e.projectId)) return false;
    if (kind && e.kind !== kind) return false;
    const t = Date.parse(e.at);
    if (fromMs !== null && Number.isFinite(fromMs) && t < fromMs) return false;
    if (toMs !== null && Number.isFinite(toMs) && t > toMs) return false;
    if (words.length) { const hay = `${e.project} ${e.kind} ${e.title} ${e.ref ?? ''} ${e.run ?? ''}`.toLowerCase(); if (!words.every(w => hay.includes(w))) return false; }
    return true;
  }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (fold) {
    const merged = new Set(rows.filter(e => e.kind === 'merge' && e.ref).map(e => `${e.projectId}|${e.ref}`));
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].kind === 'pr' && rows[i].ref && merged.has(`${rows[i].projectId}|${rows[i].ref}`)) rows.splice(i, 1);
  }
  return { total: rows.length, events: rows.slice(offset, offset + Math.min(Math.max(1, limit), cap)) };
}

// A cell that starts like a formula is neutralised (spreadsheet injection); quotes and line breaks are escaped.
const cell = value => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function historyCsv(events) {
  const head = ['at', 'project', 'kind', 'title', 'ref', 'run', 'usd', 'url'];
  return `${[head.join(','), ...events.map(e => [e.at, e.project, e.kind, e.title, e.ref, e.run, e.usd, e.url].map(cell).join(','))].join('\n')}\n`;
}
