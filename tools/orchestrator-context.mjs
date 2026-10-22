// SPDX-License-Identifier: Apache-2.0
// Orchestrator context handoff (R-030): measure a Claude Code session transcript on disk against a configurable byte
// threshold; when over the limit, persist continuity into project and Claude memory so a fresh session can resume.
// The events log stores only the transcript file name; size is read through resolveTranscript (same roots as orchestrator-usage.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { resolveTranscript } from './orchestrator-usage.mjs';
import { maskCommand } from './orchestrator-events.mjs';

/** Default transcript size (bytes) past which the orchestrator should hand off before context gets expensive. */
export const DEFAULT_HANDOFF_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
export const HANDOFF_TRANSCRIPT_BYTES_ENV = 'SWARM_ORCHESTRATOR_HANDOFF_TRANSCRIPT_BYTES';
export const PROJECT_MEMORY_FILE = '.swarm/orchestrator/memory.md';
export const HANDOFF_STATE_FILE = '.swarm/orchestrator/context-handoff.json';
export const CLAUDE_HANDOFF_MEMORY = 'swarm-orchestrator-handoff.md';

const MIN_HANDOFF_BYTES = 256 * 1024;
const MAX_HANDOFF_BYTES = 64 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,80}$/;
const TAIL_READ = 96 * 1024;
const SUMMARY_LIMIT = 2400;

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseThresholdInt(value) {
  if (!Number.isInteger(value) || value < MIN_HANDOFF_BYTES || value > MAX_HANDOFF_BYTES) return null;
  return value;
}

function parseEnvThreshold(envValue) {
  if (envValue === undefined || envValue === '') return null;
  const n = Number.parseInt(String(envValue), 10);
  return parseThresholdInt(n);
}

/** Validates the profile's `orchestrator` block (optional `handoffTranscriptBytes`). */
export function validateOrchestratorConfig(raw) {
  if (raw === undefined) return { ok: true, config: null, errors: [] };
  if (!isObj(raw)) return { ok: false, config: null, errors: ['orchestrator must be an object'] };
  const errors = [];
  for (const key of Object.keys(raw)) if (key !== 'handoffTranscriptBytes') errors.push(`orchestrator.${key}: unknown key`);
  const config = {};
  if (raw.handoffTranscriptBytes !== undefined) {
    const bytes = parseThresholdInt(raw.handoffTranscriptBytes);
    if (bytes === null) errors.push(`orchestrator.handoffTranscriptBytes must be a whole number ${MIN_HANDOFF_BYTES} to ${MAX_HANDOFF_BYTES}`);
    else config.handoffTranscriptBytes = bytes;
  }
  return errors.length ? { ok: false, config: null, errors } : { ok: true, config: Object.keys(config).length ? config : null, errors: [] };
}

/** Resolved handoff threshold in bytes: explicit option, then profile orchestrator block, then env, then default. */
export function handoffTranscriptBytes({ threshold, orchestrator, config, env = process.env } = {}) {
  const explicit = parseThresholdInt(threshold);
  if (explicit !== null) return explicit;
  const block = orchestrator ?? config?.orchestrator;
  if (isObj(block) && block.handoffTranscriptBytes !== undefined) {
    const fromProfile = parseThresholdInt(block.handoffTranscriptBytes);
    if (fromProfile !== null) return fromProfile;
  }
  const fromEnv = parseEnvThreshold(env[HANDOFF_TRANSCRIPT_BYTES_ENV]);
  if (fromEnv !== null) return fromEnv;
  return DEFAULT_HANDOFF_TRANSCRIPT_BYTES;
}

/** On-disk byte size of an allowed transcript (file name or path), or null when it cannot be resolved or read. */
export function transcriptBytes(name, { statSync = fs.statSync } = {}) {
  const real = resolveTranscript(name);
  if (!real) return null;
  try {
    const size = statSync(real).size;
    return Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

function safeOrchestratorDir(root) {
  if (typeof root !== 'string' || !root) return null;
  const swarm = path.join(root, '.swarm');
  const dir = path.join(root, '.swarm', 'orchestrator');
  if (isLink(swarm) || isLink(dir)) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function messageContentText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') out += part;
    else if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

// Transcript text can carry tokens or keys: mask them the same way event commands are masked before anything reaches memory.
function trimSummary(text) {
  const clean = maskCommand(text, SUMMARY_LIMIT + 1);
  if (clean.length <= SUMMARY_LIMIT) return clean;
  return clean.slice(0, SUMMARY_LIMIT - 1) + '…';
}

/** Last user and assistant lines from a transcript file (tail read only); null when unreadable. */
export function transcriptHandoffSummary(name, { readSync = fs.readSync, openSync = fs.openSync, closeSync = fs.closeSync, statSync = fs.statSync } = {}) {
  const real = resolveTranscript(name);
  if (!real) return null;
  let stat;
  try { stat = statSync(real); } catch { return null; }
  if (!stat.isFile()) return null;
  const take = Math.min(stat.size, TAIL_READ);
  const buf = Buffer.alloc(take);
  try {
    const fd = openSync(real, 'r');
    try { readSync(fd, buf, 0, take, stat.size - take); } finally { closeSync(fd); }
  } catch {
    return null;
  }
  let lastUser = null;
  let lastAssistant = null;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type === 'user') lastUser = trimSummary(messageContentText(row.message));
    if (row?.type === 'assistant') lastAssistant = trimSummary(messageContentText(row.message));
  }
  return { lastUser, lastAssistant };
}

function claudeMemoryFileForTranscript(transcriptName) {
  const real = resolveTranscript(transcriptName);
  if (!real) return null;
  const memoryDir = path.join(path.dirname(real), 'memory');
  if (isLink(memoryDir)) return null;
  return path.join(memoryDir, CLAUDE_HANDOFF_MEMORY);
}

function appendMarkdown(file, block, { appendFileSync = fs.appendFileSync, mkdirSync = fs.mkdirSync } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (isLink(file)) return false;
  appendFileSync(file, block, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  return true;
}

function writeJsonAtomic(file, value, { writeFileSync = fs.writeFileSync, mkdirSync = fs.mkdirSync } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (isLink(file)) return false;
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/** Autopilot --once with no journal or action changes: skip post-command writes (journal line, HANDOFF, etc.). */
let autopilotPollMeta = null;

export function noteAutopilotStep(root, step, { once = false } = {}) {
  const quiet = Boolean(
    step && !step.error
    && !(step.actions?.length)
    && !(step.blocked?.length)
    && !step.stepWroteJournal,
  );
  autopilotPollMeta = {
    root,
    once: Boolean(once),
    quiet,
    suppressPostCommand: Boolean(once && quiet),
  };
}

function quietAutopilotPollFor(root) {
  const meta = autopilotPollMeta;
  if (!meta || meta.root !== root || !meta.once || !meta.quiet) return false;
  return true;
}

export function clearAutopilotPollMeta() {
  autopilotPollMeta = null;
}

/** When true, journalAfterCommand must not append journal lines or refresh generated coordination files. */
export function shouldSuppressPostAutopilotPollWrites(root) {
  const meta = autopilotPollMeta;
  if (!meta || meta.root !== root || !meta.suppressPostCommand) return false;
  return true;
}

export function finishPostAutopilotPollWriteSuppression(root) {
  if (autopilotPollMeta?.root === root) clearAutopilotPollMeta();
}

/** When true, journalAfterCommand should not append or refresh generated files for this autopilot poll. */
export function shouldSkipJournalForAutopilotPoll(root) {
  if (!shouldSuppressPostAutopilotPollWrites(root)) return false;
  finishPostAutopilotPollWriteSuppression(root);
  return true;
}

function projectRootFromGeneratedPath(file) {
  if (typeof file !== 'string' || !file) return null;
  const normalized = path.normalize(file);
  const parts = normalized.split(path.sep);
  const coordIdx = parts.lastIndexOf('coordination');
  if (coordIdx > 0) return parts.slice(0, coordIdx).join(path.sep);
  const swarmIdx = parts.indexOf('.swarm');
  if (swarmIdx > 0) return parts.slice(0, swarmIdx).join(path.sep);
  return null;
}

/** Atomic UTF-8 write for generated project files (temp file in the same directory, then rename). */
export function writeUtf8Atomic(file, text, { writeFile = fs.promises.writeFile, rename = fs.promises.rename, mkdir = fs.promises.mkdir } = {}) {
  const root = projectRootFromGeneratedPath(file);
  if (root && shouldSuppressPostAutopilotPollWrites(root)) {
    finishPostAutopilotPollWriteSuppression(root);
    return Promise.resolve(false);
  }
  const dir = path.dirname(file);
  return mkdir(dir, { recursive: true }).then(() => {
    if (isLink(file)) return false;
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    return writeFile(tmp, text, { encoding: 'utf8', mode: 0o644 }).then(() => rename(tmp, file)).then(() => true);
  }).catch(() => false);
}

/**
 * Persist orchestrator continuity for a fresh session: project memory, Claude project memory, state file, journal.
 * @returns {{ ok: boolean, resume: object|null, error?: string }}
 */
export async function persistOrchestratorHandoff({
  root,
  sessionId,
  transcript,
  bytes,
  threshold,
  summary = null,
  now = Date.now,
} = {}) {
  if (typeof root !== 'string' || !root) return { ok: false, resume: null, error: 'handoff-needs-root' };
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, resume: null, error: 'handoff-needs-session' };
  if (!SESSION_ID_RE.test(sessionId)) {
    const err = new Error('invalid orchestrator session id');
    err.code = 'orchestrator-bad-session-id';
    throw err;
  }
  const name = typeof transcript === 'string' && transcript ? transcript : null;
  if (!name || bytes === null) return { ok: false, resume: null, error: 'handoff-needs-transcript' };
  const dir = safeOrchestratorDir(root);
  if (!dir) return { ok: false, resume: null, error: 'handoff-path-unsafe' };

  const raw = typeof now === 'function' ? now() : now;
  const nowMs = Number.isFinite(raw) ? raw : Date.now();
  const at = new Date(nowMs).toISOString();
  const given = isObj(summary) ? summary : null;
  const snap = given
    ? { lastUser: given.lastUser ? trimSummary(given.lastUser) : null, lastAssistant: given.lastAssistant ? trimSummary(given.lastAssistant) : null }
    : transcriptHandoffSummary(name) ?? { lastUser: null, lastAssistant: null };
  const block = [
    '',
    `## Orchestrator context handoff ${at}`,
    `Session \`${sessionId}\` transcript \`${path.basename(name)}\` reached ${bytes} bytes (threshold ${threshold}).`,
    'Start a fresh Claude Code session; read coordination HANDOFF.md and TASK.md, then this file.',
    '',
    snap.lastUser ? `### Last user message\n${snap.lastUser}\n` : '### Last user message\n(none captured)\n',
    snap.lastAssistant ? `### Last assistant message\n${snap.lastAssistant}\n` : '### Last assistant message\n(none captured)\n',
  ].join('\n');

  const projectMemory = path.join(root, PROJECT_MEMORY_FILE);
  if (!appendMarkdown(projectMemory, block)) return { ok: false, resume: null, error: 'handoff-memory-write-failed' };

  const claudeMemory = claudeMemoryFileForTranscript(name);
  if (claudeMemory && !appendMarkdown(claudeMemory, block)) return { ok: false, resume: null, error: 'handoff-claude-memory-write-failed' };

  const state = {
    version: 1,
    at,
    sessionId,
    transcript: path.basename(name),
    bytes,
    threshold,
    projectMemory: PROJECT_MEMORY_FILE,
    claudeMemory: claudeMemory ? path.relative(path.dirname(resolveTranscript(name)), claudeMemory).replace(/\\/g, '/') : null,
  };
  const statePath = path.join(root, HANDOFF_STATE_FILE);
  if (!writeJsonAtomic(statePath, state)) return { ok: false, resume: null, error: 'handoff-state-write-failed' };

  try {
    const { appendEvent } = await import('./journal.mjs');
    await appendEvent(root, {
      kind: 'action',
      action: 'orchestrator-context-handoff',
      session: state.sessionId,
      transcript: state.transcript,
      bytes,
      threshold,
      file: HANDOFF_STATE_FILE,
    }, { now: () => nowMs, best: true });
  } catch { /* journal is best effort */ }

  return {
    ok: true,
    resume: {
      stateFile: HANDOFF_STATE_FILE,
      projectMemory: PROJECT_MEMORY_FILE,
      claudeMemory: claudeMemory ?? null,
      at,
    },
  };
}

/** Read the latest handoff state written under the project, or null. */
export function readOrchestratorHandoffState(root, { readFileSync = fs.readFileSync } = {}) {
  if (typeof root !== 'string' || !root) return null;
  const file = path.join(root, HANDOFF_STATE_FILE);
  if (isLink(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return isObj(raw) && raw.version === 1 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Measure transcript size against the handoff threshold; when over and `apply` is true, save state to memory for a fresh session.
 * @returns {Promise<{ transcript: string|null, bytes: number|null, threshold: number, over: boolean, handoff: boolean, saved: boolean, freshSession: boolean, resume: object|null, error?: string }>}
 */
export async function contextHandoffOf(transcript, options = {}) {
  const threshold = handoffTranscriptBytes(options);
  const name = typeof transcript === 'string' && transcript ? transcript : null;
  const bytes = name ? transcriptBytes(name, options) : null;
  const over = bytes !== null && bytes >= threshold;
  const base = {
    transcript: name,
    bytes,
    threshold,
    over,
    handoff: over,
    saved: false,
    freshSession: false,
    resume: null,
  };
  if (!over) return { ...base, handoff: false };

  const apply = options.apply !== false && !options.dryRun && !options.measureOnly;
  if (!apply) return base;

  const { root, sessionId } = options;
  const persisted = await persistOrchestratorHandoff({
    root,
    sessionId,
    transcript: name,
    bytes,
    threshold,
    summary: options.summary,
    now: options.now,
  });
  if (!persisted.ok) return { ...base, error: persisted.error ?? 'handoff-failed' };
  return {
    ...base,
    saved: true,
    freshSession: true,
    resume: persisted.resume,
  };
}
