// SPDX-License-Identifier: Apache-2.0
// Field lesson 133: a background scout/ask run, and check/mutant execution inside integrate, were
// both invisible to session-level idle-time accounting — neither wrote a record anywhere a reader
// could find. Every record here shares the same {startedAt, finishedAt, costUsd} property names a
// run's own state.json carries at its top level, so one reader can scan both shapes the same way.
import fs from 'node:fs/promises';
import path from 'node:path';

export const SESSION_METRICS_DIR = '.swarm/session-metrics';
const KIND_RE = /^[a-z]+$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

function recordPath(root, kind, id) {
  if (!KIND_RE.test(kind)) throw new Error(`Invalid session-metrics kind: ${kind}`);
  if (!ID_RE.test(id)) throw new Error(`Invalid session-metrics id: ${id}`);
  return path.join(root, SESSION_METRICS_DIR, kind, `${id}.json`);
}

export async function writeSessionMetric(root, kind, id, { startedAt, finishedAt = null, costUsd = null } = {}) {
  if (typeof startedAt !== 'string' || !startedAt) throw new Error('writeSessionMetric requires startedAt');
  const record = { kind, id, startedAt, finishedAt, costUsd };
  const target = recordPath(root, kind, id);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await fs.rename(temporary, target);
  return record;
}

// Every record back, oldest first; missing or corrupt entries are skipped, never thrown, since
// this reads records this same module wrote, not a place a caller reports errors against.
export async function readSessionMetrics(root, { kinds } = {}) {
  const base = path.join(root, SESSION_METRICS_DIR);
  let kindDirs;
  try { kindDirs = await fs.readdir(base, { withFileTypes: true }); } catch { return []; }
  const records = [];
  for (const entry of kindDirs) {
    if (!entry.isDirectory() || (kinds && !kinds.includes(entry.name))) continue;
    const dir = path.join(base, entry.name);
    let files;
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try { records.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))); } catch { /* skip unreadable/corrupt */ }
    }
  }
  return records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}
