// SPDX-License-Identifier: Apache-2.0
// The Orchestrator lane: what the Claude Code sessions that drive a project are doing. A hook (tools/orchestrator-hook.mjs) appends one small event per prompt, tool call and stop to
// <project>/.swarm/orchestrator/events.ndjson: session id, event, tool, file path (inside the project) or the start of a shell command with secrets masked, time. Never file contents,
// never prompt text, never tool output. This module is the pure part: building an event, masking, classifying hand-built edits, and turning the log into session states.
// It imports nothing heavy: the hook runs on every tool call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRoutingPath } from './routing-paths.mjs';

export const EVENT_KINDS = Object.freeze(['pre', 'post', 'stop', 'prompt', 'blocked']);
export const WRITE_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Paths an orchestrator may write without the swarm having built them: tickets and plans.
export const ORCHESTRATOR_OWN = Object.freeze(['.swarm/', 'docs/plans/']);
export const EVENTS_FILE = '.swarm/orchestrator/events.ndjson';
const MAX_BYTES = 1500000;

// Session states. `working`: a tool is running. `thinking`: a prompt or a tool result is being worked on. `waiting`: the turn ended, the session waits for the owner. `idle`: nothing for a while.
export const WORKING_STALE_MS = 10 * 60 * 1000;
export const THINKING_STALE_MS = 3 * 60 * 1000;
export const WAITING_SHOWN_MS = 30 * 60 * 1000;
export const SESSION_SHOWN_MS = 60 * 60 * 1000;

// A shell command can carry a token or a key: anything key-like, any NAME=value assignment and any long opaque string is replaced before the command is stored at all.
export function maskCommand(command, max = 80) {
  let text = String(command ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const KEYWORD = '(?:token|key|secret|passw(?:or)?d|passwd|auth|credential|cookie|bearer)';
  text = text
    // credentials in a URL: scheme://user:password@host
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1[value]@')
    // well-known token shapes
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AKIA|ASIA|AIza|ya29|glpat|npm|dop_v1)[-_A-Za-z0-9]{8,}/g, '[secret]')
    // NAME=value assignments (any name)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=[value]')
    // an option whose name carries a secret word, with its value after = or a space
    .replace(new RegExp(`(--?[\\w-]*${KEYWORD}[\\w-]*)(?:=|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), '$1 [value]')
    // -p PASSWORD, -pPASSWORD (mysql, psql -W), -u user:password
    .replace(/(\s-p)(?:\s+|(?=\S))(?!\s*-)("[^"]*"|'[^']*'|\S+)/g, '$1 [value]')
    .replace(/(\s-u\s+)[^\s:]+:\S+/g, '$1[value]')
    // header values: -H "X-Api-Key: abc", Authorization: token abc, Cookie: a=b
    .replace(new RegExp(`(${KEYWORD}[\\w-]*\\s*:\\s*)(?:(?:Bearer|Basic|token)\\s+)?[^"'\\s]+`, 'gi'), '$1[value]')
    .replace(/(Bearer|Basic)\s+\S+/gi, '$1 [value]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, '[secret]');
  return text.slice(0, max);
}

const norm = p => String(p).replace(/\\/g, '/');
/** The path relative to the project when it is really inside it (symlinks resolved on the nearest existing parent); null when it is outside (or not a path). */
export function realOf(p) { let cur = p; const tail = []; for (let i = 0; i < 64; i += 1) { try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch { const up = path.dirname(cur); if (up === cur) return p; tail.push(path.basename(cur)); cur = up; } } return p; }
export function insideProject(root, file) {
  if (typeof file !== 'string' || !file) return null;
  const realOfLocal = p => { let cur = p; const tail = []; for (let i = 0; i < 64; i += 1) { try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch { const up = path.dirname(cur); if (up === cur) return p; tail.push(path.basename(cur)); cur = up; } } return p; };
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const rel = norm(path.relative(realOf(root), realOf(abs)));
  // '' is the project folder itself
  return !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel) ? rel : null;
}

/** True when an edit lands in the project outside .swarm/, docs/plans/, and routing paths: the orchestrator built it by hand. */
export function isHandBuilt(tool, relPath) {
  if (!WRITE_TOOLS.includes(tool) || typeof relPath !== 'string') return false;
  if (isRoutingPath(relPath)) return false;
  return !ORCHESTRATOR_OWN.some(prefix => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

const isPlausibleWriteTarget = w => {
  const s = String(w ?? '');
  return s.length > 0 && !/[\s"'$`]/.test(s);
};
const isScratchpadPath = rel => norm(rel).toLowerCase().split('/').includes('scratchpad');
const isClaudeMemoryPath = (file, home = os.homedir()) => {
  if (typeof file !== 'string' || !file) return false;
  const expanded = file.startsWith('~/') ? path.join(home, file.slice(2)) : file;
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : null;
  if (!abs) return false;
  const under = norm(path.relative(path.join(home, '.claude', 'projects'), abs));
  if (under.startsWith('../') || path.isAbsolute(under)) return false;
  const parts = under.split('/');
  return parts.length >= 2 && parts[1] === 'memory';
};
/** Whether a shell-analyzer write path counts toward hand-built (bf may still list every write). */
function bashWriteCountsAsHandBuilt(root, write, home = os.homedir()) {
  if (!isPlausibleWriteTarget(write)) return false;
  if (isClaudeMemoryPath(write, home)) return false;
  const rel = insideProject(root, write);
  if (rel === null) return false;
  if (isScratchpadPath(rel)) return false;
  return isHandBuilt('Write', rel);
}

// A session that runs inside a swarm worker workspace is a worker, not an orchestrator.
export const isWorkerCwd = cwd => /[\\/]\.swarm[\\/](workspaces|worktrees)[\\/]/.test(String(cwd ?? '')) || /[\\/]\.swarm-tmp[\\/]/.test(String(cwd ?? ''));

/** Nearest folder at or above `cwd` that holds .project-swarm.json (or .git); null when there is none. */
export function projectRootOf(cwd, exists = file => fs.existsSync(file)) {
  let dir = path.resolve(String(cwd ?? ''));
  // a swarm worker workspace (.swarm/workspaces/RUN/JOB) belongs to the project above its .swarm folder, not to its own git worktree
  const ws = dir.split(path.sep).lastIndexOf('.swarm');
  if (ws > 0 && ['workspaces', 'worktrees'].includes(dir.split(path.sep)[ws + 1])) dir = dir.split(path.sep).slice(0, ws).join(path.sep) || path.sep;
  for (let i = 0; i < 40; i += 1) {
    if (exists(path.join(dir, '.project-swarm.json')) || exists(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** One log line for a hook input, or null when the input is not a session event of an orchestrator. `kind` is pre | post | stop | prompt. */
export function buildEvent(kind, input, { root, now = Date.now, analyze } = {}) {
  if (!EVENT_KINDS.includes(kind) || !input || typeof input !== 'object' || typeof input.session_id !== 'string' || !input.session_id) return null;
  if (isWorkerCwd(input.cwd)) return null;
  const event = { at: new Date(now()).toISOString(), s: input.session_id.slice(0, 80), e: kind };
  if (kind === 'pre' || kind === 'post' || kind === 'blocked') {
    const tool = typeof input.tool_name === 'string' ? input.tool_name.slice(0, 60) : null;
    if (!tool) return null;
    event.t = tool;
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    if (tool === 'Bash') {
      event.c = maskCommand(ti.command);
      // A shell command that writes files in the project is a hand-built edit too (sed -i, a redirect, tee, mv, cp, rm...): the files are listed so the share built by hand is complete.
      const a = typeof analyze === 'function' ? analyze(ti.command, { root, cwd: input.cwd }) : null;
      if (a && (a.writes.length || a.git.length || a.inline || a.unknown)) {
        if (a.writes.length) event.bf = a.writes.slice(0, 12).map(f => String(f).slice(0, 200));
        if (a.git.length) event.bg = a.git.map(g => String(g).replace(/[^a-z-]/g, '').slice(0, 20)).slice(0, 6);
        if (a.inline || a.unknown) event.bu = 1;
        // only a write with named files is a hand-built edit; a command the guard could not read is noted (bu), not counted
        if (a.writes.some(w => bashWriteCountsAsHandBuilt(root, w))) event.hb = 1;
      }
    }
    else {
      const rel = insideProject(root, ti.file_path ?? ti.notebook_path ?? ti.path);
      if (rel) { event.f = rel.slice(0, 200); if (isHandBuilt(tool, rel)) event.hb = 1; }
      else if (typeof (ti.file_path ?? ti.notebook_path ?? ti.path) === 'string') event.out = 1;   // a path outside the project: noted, never stored
    }
    if (kind === 'post' && input.tool_response && typeof input.tool_response === 'object' && (input.tool_response.is_error === true || input.tool_response.success === false)) event.err = 1;
  }
  // Only the transcript's file name (the session's own id) is kept; the folder it lives in is found again at read time.
  if ((kind === 'prompt' || kind === 'stop') && typeof input.transcript_path === 'string') { const base = path.basename(input.transcript_path); if (/^[A-Za-z0-9._-]{1,120}\.jsonl$/.test(base)) event.tp = base; }
  if ((kind === 'pre' || kind === 'post') && typeof input.tool_use_id === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(input.tool_use_id)) event.u = input.tool_use_id;
  return event;
}

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
/** Appends one event; the file is rotated once it passes 1.5 MB (the previous one is kept as events.1.ndjson). A link at .swarm, .swarm/orchestrator or the file is refused. Never throws. */
export function appendEvent(root, event) {
  try {
    const file = path.join(root, EVENTS_FILE);
    const dir = path.dirname(file);
    if (isLink(path.join(root, '.swarm')) || isLink(dir) || isLink(file)) return false;
    fs.mkdirSync(dir, { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        // One process rotates: the lock is created exclusively, the size is checked again under it, and a stale lock (a process that died) is taken over after 5 s.
        const lock = path.join(dir, 'events.lock');
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
        let fd = null;
        try { fd = fs.openSync(lock, 'wx'); } catch { /* another process is rotating */ }
        if (fd !== null) {
          try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, 'events.1.ndjson')); } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
        }
      }
    } catch { /* no file yet */ }
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(event)}\n`); } finally { fs.closeSync(fd); }
    return true;
  } catch { return false; }
}

function readTail(file, bytes) {
  let text = '';
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return '';
    const size = fs.statSync(file).size;
    const take = Math.min(size, bytes);
    const fd = fs.openSync(file, 'r');
    try { const buffer = Buffer.alloc(take); fs.readSync(fd, buffer, 0, take, size - take); text = buffer.toString('utf8'); } finally { fs.closeSync(fd); }
    if (size > take) text = text.slice(text.indexOf('\n') + 1);
  } catch { return ''; }
  return text;
}

/** The last `limit` events of a project (oldest first), from the rotated file and the current one. Reads only the tails. */
export function readEvents(root, { limit = 6000 } = {}) {
  const dir = path.join(root, path.dirname(EVENTS_FILE));
  const text = readTail(path.join(dir, 'events.1.ndjson'), 2400000) + readTail(path.join(root, EVENTS_FILE), 1600000);
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object' && !Array.isArray(e) && EVENT_KINDS.includes(e.e) && typeof e.s === 'string' && Number.isFinite(Date.parse(e.at))) out.push(e); } catch { /* a torn line is skipped */ }
  }
  return out.slice(-limit);
}

/** Sessions seen in the events: state now, what it is doing, since when, edits by hand. Events are folded in time order; `now` decides staleness. Tools that run at once are tracked
 *  by their tool_use id (a tool without one by name), so one finishing does not hide the others. */
export function sessionsOf(events, now = Date.now()) {
  const ordered = events.map((e, i) => [e, i]).sort((x, y) => (Date.parse(x[0].at) - Date.parse(y[0].at)) || (x[1] - y[1])).map(x => x[0]);
  const bySession = new Map();
  for (const e of ordered) {
    let s = bySession.get(e.s);
    if (!s) { s = { id: e.s, firstAt: e.at, lastAt: e.at, last: e, transcript: null, handBuilt: 0, edits: 0, blocked: 0, turnStartedAt: null, running: new Map() }; bySession.set(e.s, s); }
    s.lastAt = e.at; if (e.e !== 'blocked') s.last = e;
    if (e.tp) s.transcript = e.tp;
    if (e.e === 'prompt') { s.turnStartedAt = e.at; s.running.clear(); }
    if (e.e === 'pre') s.running.set(e.u ?? `n:${e.t}:${e.at}`, { name: e.t, file: e.f ?? null, command: e.c ?? null, startedAt: e.at, byName: !e.u });
    if (e.e === 'post') {
      if (e.u && s.running.has(e.u)) s.running.delete(e.u);
      else { const hit = [...s.running.entries()].reverse().find(([k, v]) => v.name === e.t && (v.byName || !e.u)); if (hit) s.running.delete(hit[0]); }
    }
    if (e.e === 'blocked') { const hit = [...s.running.entries()].reverse().find(([k, v]) => (e.u && k === e.u) || (!e.u && v.name === e.t)); if (hit) s.running.delete(hit[0]); }
    if (e.e === 'stop') { s.running.clear(); s.turnStartedAt = null; }
    if (e.e === 'post' && ((WRITE_TOOLS.includes(e.t) && e.f) || (e.t === 'Bash' && e.hb))) { s.edits += 1; if (e.hb) s.handBuilt += 1; }
    if (e.e === 'blocked') s.blocked += 1;
  }
  const out = [];
  for (const s of bySession.values()) {
    const age = now - Date.parse(s.lastAt);
    const tools = [...s.running.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    let state;
    if (tools.length) state = age <= WORKING_STALE_MS ? 'working' : 'idle';
    else if (s.last.e === 'post' || s.last.e === 'prompt' || s.last.e === 'pre') state = age <= (s.last.e === 'prompt' ? WORKING_STALE_MS : THINKING_STALE_MS) ? 'thinking' : 'idle';
    else state = age <= WAITING_SHOWN_MS ? 'waiting' : 'idle';
    const doing = state === 'working' ? tools[0] : null;
    out.push({
      id: s.id, state, lastAt: s.lastAt, since: state === 'working' ? doing.startedAt : state === 'thinking' ? (s.turnStartedAt ?? s.lastAt) : s.lastAt,
      doing: doing ? { tool: doing.name, file: doing.file, command: doing.command, startedAt: doing.startedAt, parallel: tools.length } : null,
      transcript: s.transcript, edits: s.edits, handBuilt: s.handBuilt, blocked: s.blocked, shown: age <= SESSION_SHOWN_MS,
    });
  }
  return out.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

/** Distinct files edited by hand (outside .swarm/ and docs/plans/, by an edit tool or a shell command) and how many edits in all, from the events; also the attempts the guard blocked. */
export function handBuiltOf(events) {
  const files = new Set();
  let edits = 0, blocked = 0;
  for (const e of events) {
    if (e.e === 'blocked') { blocked += 1; continue; }
    if (e.e !== 'post' || !e.hb) continue;
    edits += 1;
    if (e.f) files.add(e.f);
    for (const f of Array.isArray(e.bf) ? e.bf : []) if (typeof f === 'string') files.add(f);
  }
  return { files: files.size, edits, blocked, list: [...files].slice(0, 50) };
}
