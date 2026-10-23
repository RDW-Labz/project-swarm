// SPDX-License-Identifier: Apache-2.0
// R-030 / T-0142: persist orchestrator handoff state under .swarm/project so a fresh session can continue the same work.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJournal, openItems, safeWritableDir, assertRegularOrMissing, sanitizeText } from './journal.mjs';
import { transcriptBytes, transcriptHandoffSummary, handoffTranscriptBytes } from './orchestrator-context.mjs';

export const HANDOFF_DIR_PARTS = ['.swarm', 'project'];
export const HANDOFF_FILE = 'orchestrator-handoff.json';
export const HANDOFF_VERSION = 1;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const OPEN_LIMIT = 20;
const RECENT_LIMIT = 40;

const isObj = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function textOf(value) {
  return typeof value === 'string' && value ? sanitizeText(value) : null;
}

/** Build the continuity state a fresh orchestrator session needs. Pure: no file access. */
export function buildHandoffState({ sessionId, transcript = null, bytes = null, threshold = null, events = [], summary = null, now = Date.now } = {}) {
  const raw = typeof now === 'function' ? now() : now;
  const at = new Date(Number.isFinite(raw) ? raw : Date.now()).toISOString();
  const list = Array.isArray(events) ? events.filter(isObj) : [];
  const goalEvent = [...list].reverse().find(event => event.kind === 'goal') ?? null;
  const open = openItems(list).slice(0, OPEN_LIMIT).map(item => ({
    id: item.id ?? null,
    kind: item.kind ?? null,
    text: textOf(item.text),
  }));
  const recent = list.slice(-RECENT_LIMIT).map(event => ({
    kind: event.kind ?? null,
    ts: typeof event.ts === 'string' ? event.ts : null,
    text: textOf(event.text),
    action: textOf(event.action),
  }));
  return {
    version: HANDOFF_VERSION,
    at,
    sessionId,
    transcript: typeof transcript === 'string' && transcript ? path.basename(transcript) : null,
    bytes: Number.isFinite(bytes) ? bytes : null,
    threshold: Number.isFinite(threshold) ? threshold : null,
    goal: goalEvent ? textOf(goalEvent.text) : null,
    doneWhen: goalEvent ? textOf(goalEvent.doneWhen) : null,
    open,
    recent,
    lastUser: textOf(summary?.lastUser),
    lastAssistant: textOf(summary?.lastAssistant),
    resume: [
      'Read this file first.',
      'Read coordination HANDOFF.md and TASK.md.',
      'Continue from the open items and the last user message above; do not restart finished work.',
    ],
  };
}

/** Write the state atomically under .swarm/project (symlinks refused). Returns the absolute file path. */
export async function writeHandoffState(root, state) {
  const dir = await safeWritableDir(root, HANDOFF_DIR_PARTS);
  const file = path.join(dir, HANDOFF_FILE);
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.${HANDOFF_FILE}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
  return file;
}

/** Read the latest handoff state from .swarm/project, or null when missing, unsafe or invalid. */
export async function readHandoffState(root) {
  if (typeof root !== 'string' || !root) return null;
  const file = path.join(root, ...HANDOFF_DIR_PARTS, HANDOFF_FILE);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return isObj(raw) && raw.version === HANDOFF_VERSION ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Save handoff state for a fresh session.
 * @returns {Promise<{ ok: boolean, file?: string, error?: string }>}
 */
export async function saveOrchestratorHandoff({ root, sessionId, transcript = null, bytes = null, threshold = null, summary = null, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'handoff-needs-root' };
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { ok: false, error: 'handoff-bad-session-id' };
  try {
    const events = await readJournal(root, { limit: Infinity });
    const transcriptSummary = summary ?? (typeof transcript === 'string' && transcript ? transcriptHandoffSummary(transcript) : null);
    const state = buildHandoffState({ sessionId, transcript, bytes, threshold, events, summary: transcriptSummary, now });
    const file = await writeHandoffState(root, state);
    return { ok: true, file: path.relative(root, file).split(path.sep).join('/') };
  } catch (error) {
    return { ok: false, error: `handoff-write-failed: ${error.message}` };
  }
}

/**
 * Measure the transcript and save handoff state only when it is over the threshold.
 * @returns {Promise<{ over: boolean, saved: boolean, bytes: number|null, threshold: number, file?: string, error?: string }>}
 */
export async function handoffIfNeeded({ root, sessionId, transcript = null, orchestrator, config, env, now, statSync } = {}) {
  const threshold = handoffTranscriptBytes({ orchestrator, config, env });
  const bytes = typeof transcript === 'string' && transcript ? transcriptBytes(transcript, { statSync }) : null;
  const over = bytes !== null && bytes >= threshold;
  if (!over) return { over, saved: false, bytes, threshold };
  const saved = await saveOrchestratorHandoff({ root, sessionId, transcript, bytes, threshold, now });
  if (!saved.ok) return { over, saved: false, bytes, threshold, error: saved.error };
  return { over, saved: true, bytes, threshold, file: saved.file };
}
