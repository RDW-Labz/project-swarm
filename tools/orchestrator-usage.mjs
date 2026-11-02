// SPDX-License-Identifier: Apache-2.0
// Tokens and list cost of orchestrator sessions, read from their Claude Code transcripts (the jsonl file named by the hooks). A subscription session costs nothing extra: the dollars
// here are what the same tokens would cost at list price, and the board marks them that way. Read-only; a file is read once and then only what was appended, in bounded steps.
// The events file names only the transcript's file name; the file is found again under Claude Code's own folders (~/.claude/projects, or the folders in SWARM_TRANSCRIPT_ROOTS, for tests)
// and only a file whose real path is inside one of them is ever opened, by that real path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_RATES } from './rates.mjs';

const familyOf = model => { const m = String(model ?? '').toLowerCase(); return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : null; };
const cache = new Map();   // real path -> { offset, tail, messages: Map(id -> entry) }
const STEP = 8 * 1024 * 1024;

function roots() {
  const list = process.env.SWARM_TRANSCRIPT_ROOTS ? process.env.SWARM_TRANSCRIPT_ROOTS.split(path.delimiter) : [path.join(os.homedir(), '.claude')];
  const out = [];
  for (const r of list.filter(Boolean)) { try { out.push(fs.realpathSync(r)); } catch { /* not there */ } }
  return out;
}

/** The real path of a transcript inside an allowed folder, or null. `name` is a file name (looked up under <root>/projects/*) or a path. */
export function resolveTranscript(name) {
  if (typeof name !== 'string' || !name) return null;
  const allowedRoots = roots();
  const inside = real => allowedRoots.some(r => real === r || real.startsWith(r + path.sep));
  const candidates = [];
  if (path.isAbsolute(name)) candidates.push(name);
  else if (/^[A-Za-z0-9._-]{1,120}\.jsonl$/.test(name)) {
    for (const r of allowedRoots) {
      candidates.push(path.join(r, name));
      try { for (const d of fs.readdirSync(path.join(r, 'projects'))) candidates.push(path.join(r, 'projects', d, name)); } catch { /* no projects folder */ }
    }
  }
  for (const c of candidates) {
    try { const real = fs.realpathSync(c); if (inside(real) && fs.statSync(real).isFile()) return real; } catch { /* next */ }
  }
  return null;
}

function priceOf(entry) {
  const rate = MODEL_RATES[entry.family];
  if (!rate) return null;
  return (entry.input / 1e6) * rate.in + (entry.output / 1e6) * rate.out + (entry.cacheWrite / 1e6) * rate.cacheWrite + (entry.cacheRead / 1e6) * rate.cacheRead;
}

function load(real) {
  let stat;
  try { stat = fs.statSync(real); } catch { return null; }
  let hit = cache.get(real);
  if (!hit || stat.size < hit.offset) { hit = { offset: 0, tail: '', messages: new Map() }; cache.set(real, hit); if (cache.size > 200) cache.delete(cache.keys().next().value); }
  if (stat.size > hit.offset) {
    const fd = fs.openSync(real, 'r');
    try {
      const want = Math.min(stat.size - hit.offset, STEP);
      const buffer = Buffer.alloc(want);
      const got = fs.readSync(fd, buffer, 0, want, hit.offset);
      hit.offset += got;
      const lines = (hit.tail + buffer.toString('utf8', 0, got)).split('\n');
      hit.tail = lines.pop() ?? '';
      for (const line of lines) {
        if (!line || !line.includes('"usage"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e?.type !== 'assistant' || !e.message?.usage || typeof e.message.usage !== 'object') continue;
        const id = typeof e.message.id === 'string' && e.message.id ? e.message.id.slice(0, 80) : `line-${real}-${hit.messages.size}`;
        const u = e.message.usage;
        const model = typeof e.message.model === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(e.message.model) ? e.message.model : null;
        const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);
        const prev = hit.messages.get(id) ?? { at: e.timestamp, family: familyOf(model), model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        prev.input = Math.max(prev.input, num(u.input_tokens)); prev.output = Math.max(prev.output, num(u.output_tokens));
        prev.cacheWrite = Math.max(prev.cacheWrite, num(u.cache_creation_input_tokens)); prev.cacheRead = Math.max(prev.cacheRead, num(u.cache_read_input_tokens));
        hit.messages.set(id, prev);
      }
    } finally { fs.closeSync(fd); }
  }
  return hit;
}

function totalsOf(messages, now) {
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const out = { todayTokens: 0, todayListUsd: 0, allTokens: 0, allListUsd: 0, unpricedTokens: 0, models: [] };
  const models = new Set();
  for (const m of messages) {
    const tokens = m.input + m.output + m.cacheWrite + m.cacheRead;
    const usd = priceOf(m);
    if (m.model) models.add(m.model);
    out.allTokens += tokens;
    if (usd === null) out.unpricedTokens += tokens; else out.allListUsd += usd;
    if (Date.parse(m.at) >= dayStart.getTime()) { out.todayTokens += tokens; if (usd !== null) out.todayListUsd += usd; }
  }
  out.todayListUsd = Math.round(out.todayListUsd * 1e6) / 1e6; out.allListUsd = Math.round(out.allListUsd * 1e6) / 1e6;
  out.models = [...models].slice(0, 5);
  return out;
}

/** { todayTokens, todayListUsd, allTokens, allListUsd, unpricedTokens, models } for one transcript (a file name or path); null when it is not an allowed, readable file. */
export function sessionUsage(name, { now = Date.now() } = {}) {
  const real = resolveTranscript(name);
  if (!real) return null;
  const hit = load(real);
  return hit ? totalsOf(hit.messages.values(), now) : null;
}

/** The same totals over several transcripts at once, each message counted once (one session can appear in two projects' logs, and a resumed session repeats earlier messages). */
export function combinedUsage(names, { now = Date.now() } = {}) {
  const reals = [...new Set((names ?? []).map(resolveTranscript).filter(Boolean))];
  const merged = new Map();
  for (const real of reals) {
    const hit = load(real);
    if (!hit) continue;
    for (const [id, m] of hit.messages) {
      const key = id.startsWith('line-') ? `${real}|${id}` : id;
      if (!merged.has(key)) merged.set(key, m);
    }
  }
  return { ...totalsOf(merged.values(), now), transcripts: reals.length };
}
