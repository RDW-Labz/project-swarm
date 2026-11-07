// SPDX-License-Identifier: Apache-2.0
// Estimated hands-on hours (Phase 19 part 3b): from the owner's own activity in one project, grouped into working blocks.
// Signals (timestamps only, never their content): the owner's messages to the orchestrator (Claude Code session files for this folder), ticket approvals,
// merges (the machine history), and inbox answers (the project journal). A block is activity with gaps of 15 minutes or less; its hours are its span plus a
// short tail (5 minutes) for reading and thinking, because a single message still took some time. Estimates are marked "estimated" and are never written
// to the time file: a manual entry (swarm time log) for a day replaces that day's estimate.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { projectId } from './projects.mjs';
import { historyFile } from './history.mjs';
import { readTime, localDay } from './quotes.mjs';

export const GAP_MINUTES = 15;
export const TAIL_MINUTES = 5;
const MIN = 60000;
const MAX_FILES = 400;

export const transcriptDir = (root, { claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) =>
  path.join(claudeDir, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));

const SYSTEMISH = /^\s*<(?:task-notification|system-reminder|local-command|command-stdout)/;

// A real message from the person: a user turn in the main conversation that holds text of their own (not a tool result, not a system notice).
export function isOwnerMessage(entry) {
  if (!entry || entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.userType === 'internal') return false;
  const content = entry.message?.content;
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text) : [];
  return parts.some(t => t.trim() && !SYSTEMISH.test(t) && !/^\s*\[SYSTEM NOTIFICATION/.test(t) && !/^\s*Caveat: The messages below/.test(t));
}

async function transcriptStamps(root, opts) {
  const dir = transcriptDir(root, opts);
  let files = [];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl')).slice(0, MAX_FILES); } catch { return []; }
  const stamps = [];
  for (const f of files) {
    const rl = readline.createInterface({ input: createReadStream(path.join(dir, f), { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.includes('"type":"user"')) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const at = Date.parse(e.timestamp ?? '');
        if (Number.isFinite(at) && isOwnerMessage(e)) stamps.push({ at, source: 'message' });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error('[tools/time-auto.mjs] read transcript session file:', error?.message ?? error);
      }
    }
  }
  return stamps;
}

async function ndjson(file) {
  try { return (await fs.readFile(file, 'utf8')).split('\n').flatMap(l => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } }); } catch { return []; }
}

export async function ownerActivity(root, { claudeDir, historyPath = historyFile() } = {}) {
  const stamps = await transcriptStamps(root, { claudeDir });
  const id = projectId(root);
  for (const e of await ndjson(historyPath)) if (e.projectId === id && e.kind === 'merge' && Number.isFinite(Date.parse(e.at))) stamps.push({ at: Date.parse(e.at), source: 'merge' });
  for (const e of await ndjson(path.join(root, '.swarm/project/tickets.log'))) if (e.event === 'approve' && e.by === 'owner' && Number.isFinite(Date.parse(e.at))) stamps.push({ at: Date.parse(e.at), source: 'approval' });
  for (const e of await ndjson(path.join(root, '.swarm/project/journal.ndjson'))) if (e.kind === 'human' && Number.isFinite(Date.parse(e.ts))) stamps.push({ at: Date.parse(e.ts), source: 'inbox answer' });
  return stamps.sort((a, b) => a.at - b.at);
}

export function workBlocks(stamps, { gapMinutes = GAP_MINUTES, tailMinutes = TAIL_MINUTES } = {}) {
  const blocks = [];
  for (const s of [...stamps].sort((a, b) => a.at - b.at)) {
    const last = blocks.at(-1);
    if (last && s.at - last.end <= gapMinutes * MIN) { last.end = s.at; last.events += 1; last.sources.add(s.source); }
    else blocks.push({ start: s.at, end: s.at, events: 1, sources: new Set([s.source]) });
  }
  return blocks.map(b => ({ start: b.start, end: b.end, events: b.events, sources: [...b.sources].sort(), hours: (b.end - b.start + tailMinutes * MIN) / 3600000 }));
}

const r2 = v => Math.round(v * 100) / 100;

// One row per day with activity or a manual entry: the estimate, what the owner entered, and the hours that count (the entry wins).
export function dailyHours({ blocks, manual }) {
  const days = new Map();
  const row = day => { if (!days.has(day)) days.set(day, { day, estimated: 0, blocks: 0, manual: null, through: null }); return days.get(day); };
  for (const b of blocks) { const d = row(localDay(b.start)); d.estimated += b.hours; d.blocks += 1; }
  const through = manual.filter(e => e.through);
  for (const e of manual) if (!e.through) { const d = row(e.day ?? localDay(Date.parse(e.at))); d.manual = (d.manual ?? 0) + e.hours; }
  // A "through" entry covers every day up to its date: it is counted once, on its own date, and silences the estimates before it.
  const cover = through.reduce((m, e) => (e.through > m ? e.through : m), '');
  for (const e of through) { const d = row(e.through); d.manual = (d.manual ?? 0) + e.hours; d.through = e.through; }
  const rows = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => {
    const silenced = cover && d.day <= cover && d.through === null && d.manual === null;
    const counted = d.manual !== null ? d.manual : silenced ? 0 : d.estimated;
    return { day: d.day, estimatedHours: r2(d.estimated), blocks: d.blocks, manualHours: d.manual === null ? null : r2(d.manual), counted: r2(counted), basis: d.manual !== null ? 'entered' : silenced ? 'covered by your total' : 'estimated' };
  });
  const total = r2(rows.reduce((s, r) => s + r.counted, 0));
  const estimatedPart = r2(rows.filter(r => r.basis === 'estimated').reduce((s, r) => s + r.counted, 0));
  return { rows, total, estimatedPart };
}

export async function ownerHoursOf(root, opts = {}) {
  const [stamps, time] = await Promise.all([ownerActivity(root, opts), readTime(root)]);
  const daily = dailyHours({ blocks: workBlocks(stamps), manual: time.entries });
  return { ...daily, entries: time.entries.length, activity: stamps.length };
}

export function renderSummary(daily, { days = 14, now = Date.now } = {}) {
  const cutoff = localDay(now() - (days - 1) * 86400000);
  const rows = daily.rows.filter(r => r.day >= cutoff);
  if (!rows.length) return `No activity or hours in the last ${days} days. swarm time log HOURS "note"`;
  const lines = rows.map(r => `${r.day}  ${String(r.counted).padStart(5)} h  ${r.basis === 'estimated' ? `estimated (${r.blocks} working block${r.blocks === 1 ? '' : 's'})` : r.basis === 'entered' ? `you entered${r.estimatedHours ? `; the estimate was ${r.estimatedHours}` : ''}` : `covered by your total; the estimate was ${r.estimatedHours}`}`);
  return [...lines, `last ${days} days: ${r2(rows.reduce((s, r) => s + r.counted, 0))} h; all time: ${daily.total} h (${daily.estimatedPart} h of it estimated)`,
    'Correct a day with: swarm time log HOURS "note" --date YYYY-MM-DD   (your entry replaces that day\'s estimate)'].join('\n');
}
