// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

export const KINDS = ['goal', 'plan', 'decision', 'run', 'integration', 'pr', 'blocker', 'human', 'note', 'command', 'action', 'checkpoint'];

const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const LINE_LIMIT = 8192;
const TEXT_LIMIT = 2000;
const MAX_KEYS = 30;
const MAX_DEPTH = 20;
const SECRET_PATTERNS = [
  [/\bsk[-_](?:ant-|or-|live_|test_)?[\w-]{16,}/g, '[redacted]'],
  [/\bbearer\s+[\w.~+\/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\b(?:gh[pousr]_|github_pat_)\w{16,}/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]'],
  // credentials inside a URL: https://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\/\s:@]+:[^\/\s@]+@/gi, '$1[redacted]@'],
  // NAME=value, NAME: value, "name":"value" for any name that ends in KEY, TOKEN, SECRET, PASSWORD or PASSWD,
  // including an empty prefix (TOKEN=x) and quoted values that contain spaces
  [/(["']?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]'],
  [/[A-Za-z0-9+\/]{40,}={0,2}/g, '[redacted]'],
];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function journalPath(root) {
  return path.join(root, '.swarm', 'project', 'journal.ndjson');
}

export function sanitizeText(text) {
  let out = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  const chars = [...out];
  if (chars.length > TEXT_LIMIT) out = chars.slice(0, TEXT_LIMIT - 1).join('') + '…';
  return out;
}

function clean(value, depth = 0) {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) throw new Error(`journal-key-invalid: ${key}`);
      out[key] = clean(item, depth + 1);
    }
    return out;
  }
  return value;
}

export async function appendEvent(root, event, { now = Date.now, best = false } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('journal-event-invalid');
  if (!KINDS.includes(event.kind)) throw new Error(`journal-kind-invalid: ${event.kind}`);
  if (Object.keys(event).length > MAX_KEYS) throw new Error('journal-too-many-keys');
  const { ts: _ignored, ...rest } = event;
  let stored = { ts: new Date(now()).toISOString(), ...clean(rest) };
  let line = JSON.stringify(stored);
  while (Buffer.byteLength(line) + 1 > LINE_LIMIT) {
    const open = Object.keys(stored).filter(key => key !== 'ts' && key !== 'kind');
    const long = open.filter(key => typeof stored[key] === 'string' && stored[key].length > 200);
    const nested = open.filter(key => stored[key] !== null && typeof stored[key] === 'object');
    const any = open.filter(key => typeof stored[key] === 'string' && stored[key].length > 0);
    if (long.length) {
      const longest = long.reduce((a, b) => (stored[b].length > stored[a].length ? b : a));
      stored = { ...stored, [longest]: stored[longest].slice(0, Math.floor(stored[longest].length / 2)), truncated: true };
    } else if (nested.length) {
      // Short strings stay; the largest nested value (array or object) is dropped, then the next one.
      const largest = nested.reduce((a, b) => (JSON.stringify(stored[b]).length > JSON.stringify(stored[a]).length ? b : a));
      stored = { ...stored, [largest]: '[omitted: too large]', truncated: true };
    } else if (any.length) {
      const longest = any.reduce((a, b) => (stored[b].length > stored[a].length ? b : a));
      stored = { ...stored, [longest]: stored[longest].slice(0, Math.floor(stored[longest].length / 2)), truncated: true };
    } else throw new Error('journal-event-too-large');
    line = JSON.stringify(stored);
  }
  try {
    const dir = await safeWritableDir(root, ['.swarm', 'project']);
    const handle = await fs.open(path.join(dir, 'journal.ndjson'), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { await handle.appendFile(line + '\n'); } finally { await handle.close(); }
  } catch (error) {
    if (!best) throw error;
  }
  return stored;
}

// Creates (if needed) and returns root/<parts...> after checking that no part is a symlink and that the real
// path stays inside the real root. A repository that plants a symlink at .swarm or coordination can then
// never make a swarm command write, append to or delete files outside the project.
export async function safeWritableDir(root, parts) {
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    let stat = null;
    try { stat = await fs.lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error(`journal-path-unsafe: ${current} is a symlink`);
    if (stat && !stat.isDirectory()) throw new Error(`journal-path-unsafe: ${current} is not a directory`);
    if (!stat) await fs.mkdir(current, { mode: 0o755 });
  }
  const real = await fs.realpath(current);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('journal-path-unsafe: outside the project');
  return real;
}

// For a file the caller is about to write or remove: refuse a symlink.
export async function assertRegularOrMissing(file) {
  let stat = null;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`journal-path-unsafe: ${file} is not a regular file`);
}

export async function readJournal(root, { limit = 500, kinds = null } = {}) {
  let text;
  try {
    text = await fs.readFile(journalPath(root), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const wanted = kinds === null ? null : new Set([].concat(kinds));
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    if (wanted && !wanted.has(event.kind)) continue;
    events.push(event);
  }
  if (!(limit > 0)) return [];
  return Number.isFinite(limit) ? events.slice(-Math.floor(limit)) : events;
}

export function openItems(events) {
  const latest = new Map();
  events.forEach((event, index) => {
    if (!event || (event.kind !== 'blocker' && event.kind !== 'human')) return;
    if (event.id === undefined || event.id === null) return;
    latest.set(`${event.kind}:${event.id}`, { event, index });
  });
  const open = [...latest.values()].filter(({ event }) => (event.kind === 'blocker' ? event.resolved !== true : event.done !== true));
  return open.sort((a, b) => b.index - a.index).map(({ event }) => event);
}
