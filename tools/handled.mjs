// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const DEDUPE_MS = 2000;

const EVENTS_REL = path.join('.swarm', 'orchestrator', 'events.ndjson');
const JOURNAL_REL = path.join('.swarm', 'project', 'journal.ndjson');

const empty = () => ({ today: 0, week: 0, total: 0, items: [], byRule: {} });

export function sanitizeHandledString(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 120);
}

async function readTailUtf8(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return { text: '', partialStart: false };
    const size = stat.size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return { text: buf.toString('utf8'), partialStart: start > 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', partialStart: false };
    return { text: '', partialStart: false };
  } finally {
    await handle?.close();
  }
}

function parseAutoDecision(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (row?.kind !== 'auto-decision') return null;
  const at = row.at ?? row.ts;
  if (at == null || at === '') return null;
  const atMs = Date.parse(String(at));
  if (!Number.isFinite(atMs)) return null;
  return {
    at: String(at),
    atMs,
    rule: sanitizeHandledString(row.rule),
    requestKind: sanitizeHandledString(row.requestKind),
    requestId: sanitizeHandledString(row.requestId),
    reason: sanitizeHandledString(row.reason),
    machine: sanitizeHandledString(row.machine),
  };
}

function linesFromTail({ text, partialStart }) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (partialStart && lines.length) lines.shift();
  return lines;
}

function isDuplicate(a, b) {
  return (
    a.rule === b.rule
    && a.requestKind === b.requestKind
    && a.requestId === b.requestId
    && Math.abs(a.atMs - b.atMs) <= DEDUPE_MS
  );
}

function dedupeDecisions(rows) {
  const kept = [];
  for (const row of rows) {
    if (kept.some(existing => isDuplicate(existing, row))) continue;
    kept.push(row);
  }
  return kept;
}

function itemFromRow(row) {
  return {
    at: row.at,
    rule: row.rule,
    requestKind: row.requestKind,
    requestId: row.requestId,
    reason: row.reason,
    machine: row.machine,
  };
}

export async function handledForProject(root, { now = Date.now(), limit = 20 } = {}) {
  try {
    const base = path.resolve(root);
    const paths = [path.join(base, EVENTS_REL), path.join(base, JOURNAL_REL)];
    const parsed = [];
    for (const filePath of paths) {
      const tail = await readTailUtf8(filePath);
      for (const line of linesFromTail(tail)) {
        const row = parseAutoDecision(line);
        if (row) parsed.push(row);
      }
    }

    const unique = dedupeDecisions(parsed);
    unique.sort((a, b) => b.atMs - a.atMs);

    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfDayMs = startOfDay.getTime();
    const weekStartMs = now - 7 * DAY_MS;

    let today = 0;
    let week = 0;
    const byRule = {};
    for (const row of unique) {
      if (row.atMs >= startOfDayMs) {
        today += 1;
        byRule[row.rule] = (byRule[row.rule] ?? 0) + 1;
      }
      if (row.atMs >= weekStartMs) week += 1;
    }

    const cap = Math.max(0, Number(limit) || 0);
    const items = unique.slice(0, cap).map(itemFromRow);

    return {
      today,
      week,
      total: unique.length,
      items,
      byRule,
    };
  } catch {
    return empty();
  }
}
