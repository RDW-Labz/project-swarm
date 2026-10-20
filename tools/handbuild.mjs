// SPDX-License-Identifier: Apache-2.0
// The hand-build guard: an orchestrator session may not build by hand. All build work goes through the swarm (a ticket); the only exceptions are a hand-build the owner approved, for
// a valid reason, for named files, for a short time. This module is the state and the decision; tools/handbuild-guard.mjs is the Claude Code hook that asks it before every edit or shell
// command, and tools/handbuild-commands.mjs is `swarm handbuild request | approve | deny | status | log`.
//   Allowed without approval: reading, running tests and builds, writing under .swarm/ and docs/plans/ (tickets and plans), build output, anything outside the checkout, and swarm worker
//   workspaces. Everything else in the checkout (an edit, a write, sed -i, a redirect, tee, mv or cp into it, rm, git commit/push...) needs an approval that names the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insideProject, ORCHESTRATOR_OWN, WRITE_TOOLS } from './orchestrator-events.mjs';
import { execFileSync } from 'node:child_process';
import { analyzeShell, writesAnything, TOOL_DIRS, tokenize } from './shell-writes.mjs';
import { isRoutingPath } from './routing-paths.mjs';
import { swarmProducedFiles } from './swarm-produced.mjs';

export const GIT_REQUEST_OPS = Object.freeze(['commit', 'push', 'merge', 'deploy', 'force-push', 'branch-D']);
export const ELEVATED_GIT_OPS = Object.freeze(['merge', 'deploy', 'force-push', 'branch-D']);
const CHAT_MERGE_MS = 60 * 60000;
const ALLOWED_GH = new Set(['pr create', 'pr view', 'pr list', 'pr checks', 'pr diff', 'run list', 'run watch', 'run view']);
const READ_GIT_SUBS = new Set(['fetch', 'status', 'log', 'diff', 'show']);
const WRITE_HTTP = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Current branch name; detached HEAD returns `HEAD`. */
export function branchOf(root) {
  try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return 'HEAD'; }
}

export const isProtectedBranch = b => b === 'main' || b === 'master' || b === 'HEAD';

const normBranch = b => String(b ?? '').replace(/^refs\/heads\//, '');
const isUnderScratchpad = abs => abs.split(path.sep).includes('scratchpad');
const allowedOutsideDelete = (abs, home) => {
  const n = path.resolve(abs);
  const scratch = path.join(home, '.project-swarm-scratch');
  const tmp = os.tmpdir();
  if (n === scratch || n.startsWith(`${scratch}${path.sep}`)) return true;
  if (n === tmp || n.startsWith(`${tmp}${path.sep}`)) return true;
  return isUnderScratchpad(n);
};

const ghApiWrite = (command, ops) => {
  if (!ops.some(o => o.tool === 'gh' && String(o.sub ?? '').startsWith('api'))) return false;
  for (const words of tokenize(command)) {
    const gi = words.findIndex(w => path.basename(w) === 'gh');
    if (gi === -1) continue;
    const rest = words.slice(gi + 1);
    if (rest[0] !== 'api') continue;
    for (let i = 1; i < rest.length; i += 1) {
      const w = rest[i];
      if (w === '-X' || w === '--method') {
        const m = String(rest[i + 1] ?? 'GET').toUpperCase();
        if (WRITE_HTTP.has(m)) return true;
      } else if (w.startsWith('--method=')) {
        if (WRITE_HTTP.has(w.slice(9).toUpperCase())) return true;
      } else if (WRITE_HTTP.has(String(w).toUpperCase()) && (rest[i - 1] === '-X' || rest[i - 1] === '--method')) {
        return true;
      }
    }
    return false;
  }
  return false;
};

const movesToScratchpad = (command, { root, cwd }) => {
  for (const words of tokenize(command)) {
    const mi = words.findIndex(w => w === 'mv');
    if (mi === -1) continue;
    const dest = words.slice(mi + 1).filter(w => w && !w.startsWith('-')).pop();
    if (!dest) continue;
    const raw = dest === '~' || dest.startsWith('~/') ? path.join(os.homedir(), dest.slice(2)) : path.isAbsolute(dest) ? dest : path.resolve(cwd || root, dest);
    const base = path.basename(raw.replace(/\/$/, ''));
    if (base === 'scratchpad') return true;
    const rel = insideProject(root, raw);
    if (rel !== null && (rel === 'scratchpad' || rel.startsWith('scratchpad/') || rel.split('/').includes('scratchpad'))) return true;
  }
  return false;
};

export const STATE_FILE = '.swarm/handbuild/state.json';
export const LOG_FILE = '.swarm/handbuild/log.ndjson';
export const OFF_FILE = '.swarm/handbuild/off';
export const MAX_MINUTES = 120;
export const DEFAULT_MINUTES = 30;
export const MAX_FILES = 20;
export const PENDING_MS = 24 * 60 * 60 * 1000;

/** The only valid reasons. Anything else: write a ticket instead. */
export const REASON_KINDS = Object.freeze({
  'swarm-cannot': 'the swarm cannot run it (no lane can do the work, or the swarm itself is what is broken)',
  emergency: 'an emergency fix to something live, where waiting for a ticket costs more than the hand-build',
  secret: 'it handles a secret or credential, which no worker may see',
  tiny: 'a change of under 5 lines that the swarm is blocked from making',
});
export const KIND_LIST = Object.keys(REASON_KINDS);
export const DENY_ADVICE = 'Hand-building is not allowed here: write a ticket instead (swarm tickets, swarm scope). If a valid reason applies, ask the owner: swarm handbuild request --kind <swarm-cannot|emergency|secret|tiny> --reason "why the swarm cannot do it" --files "src/a.ts,src/b.ts" --minutes 30';

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const safeDir = root => { const d = path.join(root, '.swarm', 'handbuild'); if (isLink(path.join(root, '.swarm')) || isLink(d)) throw Error('handbuild-path-unsafe'); fs.mkdirSync(d, { recursive: true }); return d; };
const cleanText = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function pruneMerges(state, now) {
  if (!state.merges || typeof state.merges !== 'object' || Array.isArray(state.merges)) { state.merges = {}; return; }
  for (const [k, exp] of Object.entries(state.merges)) if (!Number.isFinite(exp) || exp <= now) delete state.merges[k];
}

export function readState(root) {
  try {
    const file = path.join(root, STATE_FILE);
    if (isLink(file)) return { version: 1, requests: {}, merges: {} };
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = state && typeof state === 'object' && state.requests && typeof state.requests === 'object' && !Array.isArray(state.requests) ? state : { version: 1, requests: {} };
    if (!base.merges || typeof base.merges !== 'object' || Array.isArray(base.merges)) base.merges = {};
    return base;
  } catch { return { version: 1, requests: {}, merges: {} }; }
}

/** Owner typed `merge #N` in chat: allows one `gh pr merge N` / `swarm merge N` without a hand-build approval naming merge. */
export function recordChatMerge(root, pr, { now = Date.now } = {}) {
  const n = Number(String(pr ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) return;
  withStateLock(root, () => {
    const state = readState(root);
    pruneMerges(state, now());
    state.merges[String(n)] = now() + CHAT_MERGE_MS;
    writeState(root, state);
  });
}

function tryConsumeChatMerge(root, pr, now) {
  const key = String(pr ?? '').replace(/^#/, '');
  if (!/^\d+$/.test(key)) return false;
  return withStateLock(root, () => {
    const state = readState(root);
    pruneMerges(state, now);
    const exp = state.merges?.[key];
    if (!Number.isFinite(exp) || exp <= now) return false;
    delete state.merges[key];
    writeState(root, state);
    return true;
  });
}

const requestElevated = r => (r?.git ?? []).some(g => ELEVATED_GIT_OPS.includes(g));
// One writer at a time: the lock file is created exclusively (a stale one, from a process that died, is taken over after 10 seconds), and the state is read again under it.
function withStateLock(root, fn) {
  const dir = safeDir(root);
  const lock = path.join(dir, 'state.lock');
  const started = Date.now();
  for (;;) {
    try { const fd = fs.openSync(lock, 'wx', 0o600); fs.closeSync(fd); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
      if (Date.now() - started > 5000) throw Error('handbuild-busy: another hand-build command is writing the state; try again');
      const until = Date.now() + 20; while (Date.now() < until) { /* a short wait */ }
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
function writeState(root, state) {
  const dir = safeDir(root);
  const temp = path.join(dir, `state.json.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, path.join(dir, 'state.json'));
}

/** One line to the guard's own log and one to the project journal (an `action` event), written synchronously: the guard runs inside a hook. Never throws. */
export function logAction(root, entry, { now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  try {
    const dir = safeDir(root);
    const fd = fs.openSync(path.join(dir, 'log.ndjson'), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, `${JSON.stringify({ at, ...entry })}\n`); } finally { fs.closeSync(fd); }
  } catch { /* the journal line below still tries */ }
  try {
    const dir = path.join(root, '.swarm', 'project');
    if (isLink(path.join(root, '.swarm')) || isLink(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    const line = { ts: at, kind: 'action', action: `handbuild-${entry.event}`, ...Object.fromEntries(Object.entries({ id: entry.id, by: entry.by, tool: entry.tool, files: entry.files, reason: entry.reason }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => cleanText(x, 120)).slice(0, 20) : cleanText(v, 300)])) };
    const fd = fs.openSync(path.join(dir, 'journal.ndjson'), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(line)}\n`); } finally { fs.closeSync(fd); }
  } catch { /* best effort */ }
}

// ---- file patterns ---------------------------------------------------------------------------------------------------------------------------

const toRegExp = pattern => {
  const p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) return new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '*' && p[i + 1] === '*') { out += '.*'; i += 1; }
    else if (p[i] === '*') out += '[^/]*';
    else out += p[i].replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};
export const matchesFile = (patterns, rel) => (patterns ?? []).some(p => toRegExp(String(p)).test(rel));

// ---- the request -> approve flow ---------------------------------------------------------------------------------------------------------------

function newId(now) { return `hb-${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

/** Validates and stores a pending request. Throws an Error with a plain message for anything invalid (including a reason that is not on the list). */
export function createRequest(root, { kind, reason, files, minutes, git }, { now = Date.now, by = 'orchestrator' } = {}) {
  if (!KIND_LIST.includes(kind)) throw Error(`handbuild-kind: --kind must be one of ${KIND_LIST.join(', ')}. ${KIND_LIST.map(k => `${k}: ${REASON_KINDS[k]}`).join('; ')}. Anything else: write a ticket instead.`);
  const why = cleanText(reason, 400);
  if (why.length < 10) throw Error('handbuild-reason: --reason must say why the swarm cannot do it (at least 10 characters)');
  const list = (Array.isArray(files) ? files : String(files ?? '').split(',')).map(f => cleanText(f, 200)).filter(Boolean);
  if (!list.length) throw Error('handbuild-files: --files must name the files (comma separated)');
  if (list.length > MAX_FILES) throw Error(`handbuild-files: at most ${MAX_FILES} files per request`);
  for (const f of list) {
    const segments = f.replace(/\/$/, '').split('/');
    const last = segments[segments.length - 1];
    const wildcard = /[*?[{]/;
    if (path.isAbsolute(f) || segments.includes('..') || f.includes('**') || f === '.' || f === '.git' || segments.slice(0, -1).some(g => wildcard.test(g)) || (wildcard.test(last) && (!/\.\w+$/.test(last) || f.endsWith('/') || segments.length < 2)) || (f.endsWith('/') && segments.length < 2)) throw Error(`handbuild-files: ${f} is not specific enough (name files, or a folder at least two levels deep, or a *.ext pattern inside a folder; a catch-all or a whole top-level folder is not a request)`);
    if (isProtected(f.replace(/\/$/, '')) || f.replace(/\/$/, '').toLowerCase() === '.git') throw Error(`handbuild-files: ${f} belongs to the owner (the guard's own state and settings, and .git); it cannot be requested`);
  }
  const mins = minutes === undefined ? DEFAULT_MINUTES : Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > MAX_MINUTES) throw Error(`handbuild-minutes: --minutes must be a whole number from 1 to ${MAX_MINUTES}`);
  const ops = (Array.isArray(git) ? git : String(git ?? '').split(',')).map(g => g.trim()).filter(Boolean);
  for (const g of ops) if (!GIT_REQUEST_OPS.includes(g)) throw Error('handbuild-git: --git may name commit and push only');
  return withStateLock(root, () => {
  const state = readState(root);
  const id = newId(now());
  state.requests[id] = { id, kind, reason: why, files: list, git: ops, minutes: mins, status: 'pending', requestedAt: new Date(now()).toISOString(), requestedBy: cleanText(by, 40) };
  // Old finished requests are dropped so the file stays small.
  const done = Object.values(state.requests).filter(r => r.status !== 'pending' && r.status !== 'approved').sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  for (const r of done.slice(0, Math.max(0, done.length - 50))) delete state.requests[r.id];
  writeState(root, state);
  logAction(root, { event: 'request', id, by, files: list, reason: `${kind}: ${why}` }, { now });
  return state.requests[id];
  });
}

/** approve | deny a pending request. An approval runs for `minutes` from now and covers only the files (and git operations) it names. */
export function decideRequest(root, id, choice, { now = Date.now, by = 'owner', channel } = {}) {
  return withStateLock(root, () => {
  const state = readState(root);
  const r = state.requests[id];
  if (!r) throw Error(`handbuild-unknown: no hand-build request ${id}`);
  if (r.status !== 'pending') throw Error(`handbuild-not-pending: ${id} is already ${r.status}`);
  if (now() - Date.parse(r.requestedAt) > PENDING_MS) { r.status = 'expired'; writeState(root, state); throw Error(`handbuild-expired: ${id} waited more than 24 hours and expired; ask again if it is still needed`); }
  if (!['approve', 'deny'].includes(choice)) throw Error('handbuild-choice: approve or deny');
  if (choice === 'approve' && requestElevated(r) && channel !== undefined && channel !== 'computer') {
    throw Error('handbuild-computer-only: merge, deploy, force-push and branch -D need the owner at the computer (swarm decide), not from the phone or board');
  }
  r.status = choice === 'approve' ? 'approved' : 'denied';
  r.decidedAt = new Date(now()).toISOString();
  r.decidedBy = cleanText(by, 40);
  if (choice === 'approve') r.expiresAt = new Date(now() + r.minutes * 60000).toISOString();
  writeState(root, state);
  logAction(root, { event: choice === 'approve' ? 'approve' : 'deny', id, by, files: r.files, reason: choice === 'approve' ? `until ${r.expiresAt}` : '' }, { now });
  return r;
  });
}

export function listRequests(root) { return Object.values(readState(root).requests).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))); }

/** The live approvals (approved and not expired). */
export function activeApprovals(root, now = Date.now()) { return listRequests(root).filter(r => r.status === 'approved' && Date.parse(r.expiresAt) > now); }

// ---- the decision ----------------------------------------------------------------------------------------------------------------------------

// The approval state is the owner's: no approval covers a write to it, to the guard's log, or to the hooks' own settings, and an orchestrator session cannot run the approval commands.
export const PROTECTED = Object.freeze(['.swarm/handbuild', '.claude/settings.local.json', '.claude/settings.json', '.git/']);
// Compared in lower case (the usual macOS volume is case-insensitive), and the folders that contain the guard's state are protected too, not only the files in them.
const isProtected = rel => { const r = rel.toLowerCase(); return r === '.swarm' || r === '.claude' || PROTECTED.some(p => r === p || r.startsWith(p.endsWith('/') ? p : `${p}/`)); };
// Outside the checkout too: the install (the guard's own scripts) and the user's own Claude settings could switch the hooks off.
export const protectedAbsolute = (home = os.homedir()) => [path.join(home, '.project-swarm'), path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json'), ...(process.env.SWARM_INSTALL_DIR ? [process.env.SWARM_INSTALL_DIR] : [])];
const underAbs = (abs, list) => list.some(prefix => abs === prefix || abs.startsWith(`${prefix}/`));
const AllowRel = rel => { const r = rel.toLowerCase(); return ORCHESTRATOR_OWN.some(prefix => r === prefix.slice(0, -1) || r.startsWith(prefix)) || TOOL_DIRS.some(prefix => r === prefix.slice(0, -1) || r.startsWith(prefix)); };

/** { allow, reason, files, approval } for one tool call. `input` is the hook input (tool_name, tool_input, cwd). */
export function guardDecision({ tool, toolInput, root, cwd, now = Date.now, home, branchOf: branchOfFn = branchOf } = {}) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const h = home ?? os.homedir();
  const approvals = activeApprovals(root, now());
  const produced = swarmProducedFiles(root);
  const swarmOk = rel => isRoutingPath(rel) || produced.has(rel);
  const covers = (rels, gitOps = []) => {
    // every file and every git operation must be covered by one live approval
    for (const rel of rels) if (!approvals.some(a => matchesFile(a.files, rel))) return { ok: false, missing: rel };
    const gitCovered = op => approvals.some(a => a.git.includes(op) || (op === 'add' && a.git.includes('commit')));
    for (const op of gitOps) if (!gitCovered(op)) return { ok: false, missing: `git ${op}` };
    const used = approvals.find(a => rels.some(rel => matchesFile(a.files, rel)) || gitOps.some(op => gitCovered(op)));
    return { ok: true, approval: used?.id };
  };
  if (WRITE_TOOLS.includes(tool)) {
    const raw0 = ti.file_path ?? ti.notebook_path ?? ti.path;
    // a relative path means relative to the folder the session is in
    const raw = typeof raw0 === 'string' && raw0 && !path.isAbsolute(raw0) ? path.resolve(cwd || root, raw0) : raw0;
    const rel = insideProject(root, raw);
    if (rel === null && typeof raw === 'string' && raw && underAbs(path.resolve(path.isAbsolute(raw) ? raw : path.join(cwd || root, raw)), protectedAbsolute(home))) return { allow: false, files: [], reason: `Hand-build guard: ${raw} belongs to the owner (the swarm install and the user's Claude settings hold the guard itself); no approval covers it.` };
    if (rel !== null && isProtected(rel)) return { allow: false, files: [rel], reason: `Hand-build guard: ${rel} belongs to the owner (approvals and the guard's own settings); no approval covers it.` };
    if (rel === null || AllowRel(rel)) return { allow: true };
    if (rel !== null && isRoutingPath(rel)) return { allow: true, files: [rel] };
    const c = covers([rel]);
    return c.ok ? { allow: true, files: [rel], approval: c.approval } : { allow: false, files: [rel], reason: `${DENY_ADVICE} (blocked: ${tool} ${rel})` };
  }
  if (tool === 'Bash') {
    const a = analyzeShell(ti.command, { root, cwd, home: h, protectedAbs: protectedAbsolute(h) });
    const current = branchOfFn(root);
    const protBranch = isProtectedBranch(current);
    if (a.selfApproval) return { allow: false, files: [], reason: 'Hand-build guard: approving or denying a hand-build, or switching the guard off, is the owner\'s alone (swarm handbuild approve, or the phone). An orchestrator session cannot approve its own request.' };
    if (a.protectedOutside.length) return { allow: false, files: [], reason: `Hand-build guard: ${a.protectedOutside.join(', ')} belongs to the owner (the swarm install and the user's Claude settings hold the guard itself); no approval covers it.` };
    if (a.writes.some(isProtected)) return { allow: false, files: a.writes, reason: `Hand-build guard: ${a.writes.filter(isProtected).join(', ')} belongs to the owner (approvals and the guard's own settings); no approval covers it.` };
    if (a.outsideDeletes?.length && !a.outsideDeletes.every(p => allowedOutsideDelete(p, h))) {
      return { allow: false, files: [], reason: 'Hand-build guard: deletes outside the scratchpad are the owner\'s.' };
    }
    const policyGitOps = [];
    let commitStagedCheck = null;
    for (const op of a.ops) {
      if (op.tool === 'git') {
        if (READ_GIT_SUBS.has(op.sub)) continue;
        if (op.sub === 'branch') {
          if (op.delete === 'safe') continue;
          if (op.delete === 'force') { policyGitOps.push('branch-D'); continue; }
        }
        if (op.sub === 'rebase') {
          if (protBranch) policyGitOps.push('commit');
          continue;
        }
        if (op.sub === 'merge') { policyGitOps.push('merge'); continue; }
        if (op.sub === 'push') {
          const target = normBranch(op.branch ?? current);
          if (op.force && isProtectedBranch(target)) {
            return { allow: false, files: [], reason: 'Hand-build guard: force push to a protected branch (main or master) is never approvable, even with a hand-build approval that names force-push.' };
          }
          if (op.force) { policyGitOps.push('force-push'); continue; }
          if (protBranch || isProtectedBranch(target)) policyGitOps.push('push');
          continue;
        }
        if (op.sub === 'commit') {
          if (protBranch) policyGitOps.push('commit');
          else commitStagedCheck = 'allowlist';
          continue;
        }
      } else if (op.tool === 'gh') {
        if (ALLOWED_GH.has(op.sub)) continue;
        if (op.sub === 'pr merge') {
          if (op.target && tryConsumeChatMerge(root, op.target, now())) continue;
          policyGitOps.push('merge');
          continue;
        }
      } else if (op.tool === 'vercel' && op.sub === 'deploy') {
        policyGitOps.push('deploy');
      } else if (op.tool === 'swarm' && op.sub === 'merge') {
        if (op.target && tryConsumeChatMerge(root, op.target, now())) continue;
        policyGitOps.push('merge');
      }
    }
    if (ghApiWrite(ti.command, a.ops)) policyGitOps.push('gh-api-write');
    if (policyGitOps.length && !covers([], policyGitOps).ok) {
      const label = policyGitOps[0] === 'gh-api-write' ? 'gh api write' : `git ${policyGitOps[0]}`;
      return { allow: false, files: [], reason: `${DENY_ADVICE} (blocked: ${label})` };
    }
    if (!writesAnything(a)) return { allow: true };
    if (a.inline || a.unknown) {
      const need = [a.inline ? 'an inline script that writes files' : null, a.unknown ? 'a write whose target is a variable or substitution' : null].filter(Boolean).join(' and ');
      return { allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: ${need}; the guard cannot tell what it writes, so it needs an approval that names the files, or a ticket)` };
    }
    let staged = [];
    const hasCommit = a.ops.some(o => o.tool === 'git' && o.sub === 'commit') || a.git.includes('commit');
    if (hasCommit) {
      const added = [];
      let everything = false;
      for (const words of tokenize(ti.command)) {
        const gi = words.findIndex(w => path.basename(w) === 'git');
        if (gi === -1) continue;
        const rest = words.slice(gi + 1);
        const ai = rest.indexOf('add');
        const ci = rest.indexOf('commit');
        const list = ai !== -1 ? rest.slice(ai + 1, ci === -1 ? undefined : ci) : ci !== -1 && rest.includes('--') ? rest.slice(rest.indexOf('--') + 1) : [];
        for (const w of list) {
          if (['-A', '--all', '-u', '--update', '.', ':/', '-p', '--patch', '-i', '--interactive'].includes(w) || /[*?[{]/.test(w)) everything = true;
          else if (!w.startsWith('-') && w !== '--') { const rel = insideProject(root, path.isAbsolute(w) ? w : path.resolve(cwd || root, w)); if (rel) added.push(rel); }
        }
      }
      if (everything) return { allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: a git add of everything, or of a pattern, cannot be checked against an approval; add the approved files by name)` };
      staged.push(...added);
      const all = /\bcommit\b[^;&|]*\s-[A-Za-z]*a|--all\b/.test(String(ti.command ?? ''));
      try { staged = [...staged, ...execFileSync('git', ['diff', all ? '--name-only' : '--cached', ...(all ? ['HEAD'] : ['--name-only'])], { cwd: root, encoding: 'utf8', timeout: 3000 }).split('\n').filter(Boolean)]; }
      catch { return { allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: git commit, and the guard could not read which files it would carry)` }; }
      if (commitStagedCheck === 'allowlist' && staged.length && staged.every(swarmOk)) {
        if (!policyGitOps.length) return { allow: true, files: staged };
      }
      if (commitStagedCheck === 'allowlist' && staged.some(f => !swarmOk(f) && !AllowRel(f))) {
        policyGitOps.push('commit');
      }
    }
    const needsFileApproval = a.writes.filter(w => !swarmOk(w) && !AllowRel(w));
    const fileRels = [...new Set([...needsFileApproval, ...staged.filter(f => !swarmOk(f) && !AllowRel(f))])];
    if (policyGitOps.length) {
      const c = covers(fileRels, policyGitOps);
      if (c.ok) return { allow: true, files: [...a.writes, ...staged], approval: c.approval };
      const label = policyGitOps[0] === 'gh-api-write' ? 'gh api write' : `git ${policyGitOps[0]}`;
      return { allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: ${label})` };
    }
    const residualGit = a.git.filter(g => {
      if (g === 'rebase' && !protBranch) return false;
      if (g === 'push') return false;
      if (g === 'branch' && a.ops.some(o => o.tool === 'git' && o.sub === 'branch' && o.delete === 'safe')) return false;
      if (g === 'commit' && commitStagedCheck === 'allowlist' && staged.length && staged.every(swarmOk)) return false;
      return true;
    });
    if (movesToScratchpad(ti.command, { root, cwd })) return { allow: true, files: a.writes };
    if (!fileRels.length && !residualGit.length) return { allow: true, files: [...a.writes, ...staged] };
    if (a.writes.length && a.writes.every(w => swarmOk(w) || AllowRel(w)) && !residualGit.length) return { allow: true, files: a.writes };
    const c = covers(fileRels, residualGit);
    if (c.ok) return { allow: true, files: [...a.writes, ...staged], approval: c.approval };
    return { allow: false, files: a.writes, reason: `${DENY_ADVICE} (blocked: ${[...fileRels.map(w => `writes ${w}`), ...residualGit.map(g => `git ${g}`)].join(', ')})` };
  }
  return { allow: true };
}
