#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Orchestrator lane: schedule journal handoff when transcript context is over limit.
// Invoked like orchestrator-hook.mjs (`node orchestrator-handoff-hook.mjs pre|post|...`, JSON on stdin)
// or via runOrchestratorHandoffHookFromRecord from tools/orchestrator-hook.mjs runRecordBody.
// Never blocks tool calls: over-limit on pre only marks scheduled; writeOrchestratorHandoff runs when in-flight tools are idle.
import * as child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contextHandoffOf } from './orchestrator-context.mjs';
import { writeOrchestratorHandoff } from './orchestrator-handoff.mjs';
import { isWorkerCwd, projectRootOf } from './orchestrator-events.mjs';

const hookScriptPath = (() => {
  try { return fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); }
})();

const HANDOFF_RECORD_WORKER = '--orchestrator-handoff-record';
const HANDOFF_TIMEOUT_MS = 5000;
const HOOK_SESSIONS_REL = path.join('.swarm', 'orchestrator', 'handoff-hook-sessions.json');

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function readHookSessions(root) {
  const file = path.join(root, HOOK_SESSIONS_REL);
  const dir = path.dirname(file);
  if (isLink(path.join(root, '.swarm')) || isLink(dir) || isLink(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  } catch {
    return {};
  }
}

function writeHookSessions(root, sessions) {
  const file = path.join(root, HOOK_SESSIONS_REL);
  const dir = path.dirname(file);
  if (isLink(path.join(root, '.swarm')) || isLink(dir) || isLink(file)) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.handoff-hook-sessions.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions })}\n`, { encoding: 'utf8', mode: 0o644 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function resetOrchestratorHandoffHookState() {
  /* tests call this between cases; each case uses its own project root */
}

function loadSession(root, sessionId) {
  const sessions = readHookSessions(root);
  const st = sessions[sessionId];
  if (st && typeof st.inFlight === 'number' && typeof st.scheduled === 'boolean') return { ...st };
  return { inFlight: 0, scheduled: false };
}

function storeSession(root, sessionId, st) {
  const sessions = readHookSessions(root);
  sessions[sessionId] = { inFlight: st.inFlight, scheduled: st.scheduled };
  writeHookSessions(root, sessions);
}

function orchestratorProfileBlock(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.project-swarm.json'), 'utf8'));
    const block = raw?.profile?.orchestrator;
    return block && typeof block === 'object' ? block : undefined;
  } catch {
    return undefined;
  }
}

function handoffOptionsForRoot(root, options = {}) {
  const orchestrator = options.orchestrator ?? orchestratorProfileBlock(root);
  return {
    ...options,
    env: options.env ?? process.env,
    ...(orchestrator ? { orchestrator } : {}),
  };
}

async function transcriptOverLimit(input, options) {
  const name = typeof input?.transcript_path === 'string' ? input.transcript_path : null;
  if (!name) return null;
  return contextHandoffOf(name, { ...options, measureOnly: true });
}

/**
 * @returns {Promise<{ action: string, inFlight?: number, wrote?: boolean }>}
 */
export async function maybeScheduleOrchestratorHandoff(recordKind, input, root, options = {}) {
  if (!root || !input || typeof input !== 'object') return { action: 'skip' };
  if (typeof input.session_id !== 'string' || !input.session_id) return { action: 'skip' };
  if (isWorkerCwd(input.cwd)) return { action: 'skip' };

  const opts = handoffOptionsForRoot(root, options);
  const writeHandoff = opts.writeHandoff ?? writeOrchestratorHandoff;
  const sessionId = input.session_id;
  const st = loadSession(root, sessionId);

  if (recordKind === 'pre') {
    st.inFlight += 1;
    const check = await transcriptOverLimit(input, opts);
    if (check?.over) st.scheduled = true;
    storeSession(root, sessionId, st);
    return { action: st.scheduled ? 'scheduled' : 'continue', inFlight: st.inFlight };
  }

  if (recordKind === 'post' || recordKind === 'blocked') {
    if (st.inFlight > 0) st.inFlight -= 1;
    const check = await transcriptOverLimit(input, opts);
    if (check?.over) st.scheduled = true;
    if (st.scheduled && st.inFlight === 0) {
      st.scheduled = false;
      storeSession(root, sessionId, st);
      await writeHandoff(root, opts);
      return { action: 'handoff', wrote: true, inFlight: 0 };
    }
    storeSession(root, sessionId, st);
    return { action: st.scheduled ? 'scheduled' : 'continue', inFlight: st.inFlight };
  }

  if (recordKind === 'prompt' || recordKind === 'stop' || recordKind === 'end') {
    const check = await transcriptOverLimit(input, opts);
    if (check?.over) st.scheduled = true;
    if (st.scheduled && st.inFlight === 0) {
      st.scheduled = false;
      storeSession(root, sessionId, st);
      await writeHandoff(root, opts);
      return { action: 'handoff', wrote: true, inFlight: st.inFlight };
    }
    storeSession(root, sessionId, st);
    return { action: st.scheduled ? 'scheduled' : 'continue', inFlight: st.inFlight };
  }

  return { action: 'skip' };
}

async function runHandoffRecordBody(raw, recordKind) {
  try {
    const input = JSON.parse(raw);
    const root = projectRootOf(input.cwd);
    if (!root) return;
    await maybeScheduleOrchestratorHandoff(recordKind, input, root, handoffOptionsForRoot(root));
  } catch { /* unreadable hook input */ }
}

/** Sync entry for orchestrator-hook.mjs runRecordBody; spawns a short-lived worker like the main hook. */
export function runOrchestratorHandoffHookFromRecord(recordKind, raw) {
  if (typeof raw !== 'string' || !raw || typeof recordKind !== 'string' || !recordKind) return;
  try {
    child_process.spawnSync(process.execPath, [hookScriptPath, HANDOFF_RECORD_WORKER, recordKind], {
      input: raw,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: HANDOFF_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch { /* never block the orchestrator hook */ }
}

function isCliMain() {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(arg).href; } catch { return false; }
}

const kind = process.argv[2] === HANDOFF_RECORD_WORKER ? process.argv[3] : process.argv[2];

if (process.argv[2] === HANDOFF_RECORD_WORKER) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    await runHandoffRecordBody(raw, kind);
  } catch { /* unreadable */ }
  process.exit(0);
} else if (isCliMain()) {
  let raw = '';
  const stdinWatch = setTimeout(() => process.exit(0), HANDOFF_TIMEOUT_MS);
  stdinWatch.unref();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (raw.length < 2_000_000) raw += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(stdinWatch);
    runOrchestratorHandoffHookFromRecord(kind, raw);
    process.exit(0);
  });
  process.stdin.on('error', () => {
    clearTimeout(stdinWatch);
    process.exit(0);
  });
}
