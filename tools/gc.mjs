// SPDX-License-Identifier: Apache-2.0
import { git } from './codex-adapter.mjs';
import { scratchRootDir } from './claude-shell.mjs';
import { appendEvent, integrateBlockerRunIdFromId } from './journal.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { listProjects, projectsFile } from './projects.mjs';
import { holdsSwarmState, recordDeletion } from './state-guard.mjs';
import { expectedWorkspaceFor, worktreesBaseFor } from './swarm/core-11.mjs';
import { readState } from './swarm/core-41.mjs';
import { resolveWorktree } from './swarm/workspace.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { shouldArchiveUntrackedRun } from './board-data.mjs';

const execFileAsync = promisify(execFile);

export const GC_USAGE = `Usage: swarm gc [--apply] [--all-projects | --root PATH] [--older-than DAYS] [--keep-runs N] [--include-scratch] [--archive-untracked] [--force-unsafe] [--json] [--usage]
       Dry run by default: lists removable paths and bytes. --apply deletes them.
       --older-than DAYS   Only finished/orphan items older than this (default 7).
       --keep-runs N       Keep the N newest run folders per project (default 20).
       --include-scratch   Also consider stale scratch checkouts under the scratch base.
       --archive-untracked Summarize and trim off-ledger noise runs (older than 7 days or smoke/probe/bench).
       --json              Machine-readable plan or disk usage (--usage).
       --usage             With --json, print only diskUsage for the board.
`;

const DISK_USAGE_CACHE_MS = 10 * 60 * 1000;
const SIZE_WALK_MS = 2500;

export function resolveKeepWorkspaces(config = {}, options = {}) {
  if (options.keepWorkspaces === true) return true;
  if (config.keepWorkspaces === true) return true;
  if (config.profile?.keepWorkspaces === true) return true;
  return false;
}

export function resolveKeepFailedDays(config = {}, env = process.env) {
  const raw = env.SWARM_KEEP_FAILED_DAYS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (typeof config.keepFailedDays === 'number' && config.keepFailedDays >= 0) return config.keepFailedDays;
  if (typeof config.profile?.keepFailedDays === 'number' && config.profile.keepFailedDays >= 0) {
    return config.profile.keepFailedDays;
  }
  return 7;
}

const FAILURE_RUN_STATUSES = new Set(['failed', 'cancelled', 'timeout', 'missing-output', 'launch-error']);
const CLOSED_TICKET_STATUSES = new Set(['done', 'delivered']);

function isRunningJob(record) {
  return record?.status === 'running' || record?.status === 'queued';
}

export function runFailedOrAbandoned(state) {
  if (!state) return false;
  if (FAILURE_RUN_STATUSES.has(state.status)) return true;
  return (state.jobs ?? []).some(job => FAILURE_RUN_STATUSES.has(job.status));
}

/** Workspaces must stay until integrateQueue finishes (merge/requeue reads job output copies). */
export function integrateQueueStillNeedsRunWorkspaces(state) {
  const mq = state?.mergeQueue;
  if (!mq) return false;
  if (mq.state === 'running') return true;
  if (state.integrationStatus === 'queued') return true;
  if (Array.isArray(mq.conflicts) && mq.conflicts.length > 0 && !mq.summary) return true;
  return false;
}

export function jobsEligibleForCleanup(state, { forGc = false } = {}) {
  if (!state || !Array.isArray(state.jobs)) return [];
  if (state.status === 'running') return [];
  if (state.jobs.some(isRunningJob)) return [];
  if (integrateQueueStillNeedsRunWorkspaces(state)) return [];
  if (state.integrationStatus === 'partial' && state.integratedAt) {
    return [];
  }
  if (state.integratedAt && state.integrationStatus !== 'partial') {
    return state.jobs.filter(job => !job.keptWorkspace);
  }
  if (forGc && runFailedOrAbandoned(state)) {
    return state.jobs.filter(job => !job.keptWorkspace);
  }
  return [];
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function ticketList(ledger) {
  if (!ledger) return [];
  if (Array.isArray(ledger)) return ledger;
  if (Array.isArray(ledger.tickets)) return ledger.tickets;
  return [];
}

function ledgerTicketIds(ledger) {
  const ids = new Set();
  for (const ticket of ticketList(ledger)) if (ticket?.id) ids.add(String(ticket.id));
  return ids;
}

async function collectArchiveUntrackedRuns(root, { nowMs = Date.now(), duImpl } = {}) {
  const ledger = await readJsonFile(path.join(root, '.swarm', 'project', 'tickets.json'));
  const ticketIds = ledgerTicketIds(ledger);
  const runsDir = path.join(root, '.swarm', 'runs');
  const rows = [];
  let ids = [];
  try { ids = (await fs.readdir(runsDir)).filter(Boolean); } catch { return rows; }
  for (const runId of ids) {
    let state;
    try { state = await readState(root, runId); } catch { continue; }
    if (!shouldArchiveUntrackedRun(state, ticketIds, { now: nowMs })) continue;
    const runDir = path.join(runsDir, runId);
    const bytes = await pathBytes(runDir, { duImpl }) ?? 0;
    rows.push({ path: runDir, bytes, runId, kind: 'untracked-archive' });
  }
  return rows;
}

function addPath(set, root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return;
  const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  set.add(abs);
}

async function workspacePathsForRun(root, runId) {
  const paths = new Set();
  let state;
  try { state = await readState(root, runId); } catch { return paths; }
  for (const job of state.jobs ?? []) {
    if (job.keptWorkspace) addPath(paths, root, job.keptWorkspace);
    if (job.workspace) addPath(paths, root, job.workspace);
    if (job.worktreePath) addPath(paths, root, job.worktreePath);
    else if (state.worktreesBase) addPath(paths, root, resolveWorktree(state, job));
  }
  return paths;
}

export async function collectProtectedWorkspacePaths(root) {
  const protectedPaths = new Set();
  const runIds = new Set();
  const ledger = await readJsonFile(path.join(root, '.swarm', 'project', 'tickets.json'));
  for (const ticket of ticketList(ledger)) {
    const status = ticket?.status;
    if (status && CLOSED_TICKET_STATUSES.has(status)) continue;
    if (ticket.workspace) addPath(protectedPaths, root, ticket.workspace);
    if (ticket.worktreePath) addPath(protectedPaths, root, ticket.worktreePath);
    if (ticket.keptWorkspace) addPath(protectedPaths, root, ticket.keptWorkspace);
    if (ticket.runId) runIds.add(ticket.runId);
    if (ticket.run) runIds.add(ticket.run);
  }
  try {
    const text = await fs.readFile(path.join(root, '.swarm', 'project', 'journal.ndjson'), 'utf8');
    const latest = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.kind === 'blocker' && event.id) latest.set(event.id, event);
    }
    for (const event of latest.values()) {
      if (event.resolved === true) continue;
      if (event.runId) runIds.add(event.runId);
      const blockerRun = integrateBlockerRunIdFromId(event.id);
      if (blockerRun) runIds.add(blockerRun);
      if (event.workspace) addPath(protectedPaths, root, event.workspace);
      if (event.worktreePath) addPath(protectedPaths, root, event.worktreePath);
    }
  } catch { /* no journal */ }
  for (const runId of runIds) {
    for (const p of await workspacePathsForRun(root, runId)) protectedPaths.add(p);
  }
  return protectedPaths;
}

function pathProtected(absPath, protectedPaths) {
  const resolved = path.resolve(absPath);
  for (const p of protectedPaths) {
    if (resolved === p || resolved.startsWith(`${p}${path.sep}`)) return true;
    if (p.startsWith(`${resolved}${path.sep}`)) return true;
  }
  return false;
}

async function pathBytes(target, { duImpl, now = Date.now, deadline } = {}) {
  if (deadline && now() >= deadline) return null;
  try {
    const st = await fs.lstat(target);
    if (st.isSymbolicLink()) return 0;
    if (duImpl) {
      try {
        const { stdout } = await duImpl(['-sk', target]);
        const kb = Number(String(stdout).trim().split(/\s+/)[0]);
        if (Number.isFinite(kb)) return kb * 1024;
      } catch { /* fall through */ }
    }
  } catch { return 0; }
  let total = 0;
  async function walk(dir) {
    if (deadline && now() >= deadline) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try { total += (await fs.stat(full)).size; } catch { /* skip */ }
      }
    }
  }
  await walk(target);
  return total;
}

async function appendGcLog(root, line) {
  const file = path.join(root, '.swarm', 'gc.log');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${line}\n`, { flag: 'a' });
}

async function appendRunCleanupJournal(root, runId, entry) {
  await appendEvent(root, { kind: 'note', text: `workspace-cleanup run=${runId} path=${entry.path} freed=${entry.bytesFreed ?? 0}` }, { best: true });
  await appendGcLog(root, `${new Date().toISOString()} run=${runId} ${entry.path} freed=${entry.bytesFreed ?? 0}`);
}

async function assertUnderBases(absPath, bases) {
  const resolved = await fs.realpath(absPath).catch(() => null);
  if (!resolved) return false;
  for (const base of bases) {
    let realBase;
    try { realBase = await fs.realpath(base); } catch { continue; }
    if (resolved === realBase || resolved.startsWith(`${realBase}${path.sep}`)) return true;
  }
  return false;
}

function gcStateGuardContext(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  return {
    env,
    home,
    registryFile: opts.registryFile ?? projectsFile(env, home),
    fsImpl: opts.fs ?? fs,
    now: opts.now ?? (() => new Date()),
  };
}

async function logCheckoutDeletionAttempt(absPath, caller, outcome, ctx) {
  await recordDeletion({
    dir: absPath,
    caller,
    outcome,
    home: ctx.home,
    env: ctx.env,
    fs: ctx.fsImpl,
    now: ctx.now,
  });
}

async function removeGitWorktree(root, worktreePath, { gitImpl = git, caller = 'gc.removeGitWorktree', guardCtx } = {}) {
  if (guardCtx && await holdsSwarmState(worktreePath, { fs: guardCtx.fsImpl, registryFile: guardCtx.registryFile })) {
    await logCheckoutDeletionAttempt(worktreePath, caller, 'refused', guardCtx);
    return { skipped: true, reason: 'state-holder', path: worktreePath };
  }
  if (guardCtx) await logCheckoutDeletionAttempt(worktreePath, caller, 'allowed', guardCtx);
  try {
    await gitImpl(root, ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    try { await fs.rm(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { await gitImpl(root, ['worktree', 'prune']); } catch { /* ignore */ }
  return { removed: true, path: worktreePath };
}

async function removePath(root, absPath, bases, { gitImpl, duImpl, runId, dryRun, log, caller = 'gc.removePath', guardCtx }) {
  if (!(await assertUnderBases(absPath, bases))) return { skipped: true, reason: 'outside-base', path: absPath, bytesFreed: 0 };
  let st;
  try { st = await fs.lstat(absPath); } catch { return { path: absPath, bytesFreed: 0, missing: true }; }
  if (st.isSymbolicLink()) return { skipped: true, reason: 'symlink', path: absPath, bytesFreed: 0 };
  const bytes = await pathBytes(absPath, { duImpl }) ?? 0;
  if (dryRun) return { path: absPath, bytesFreed: bytes, dryRun: true };
  if (guardCtx && await holdsSwarmState(absPath, { fs: guardCtx.fsImpl, registryFile: guardCtx.registryFile })) {
    await logCheckoutDeletionAttempt(absPath, caller, 'refused', guardCtx);
    return { skipped: true, reason: 'state-holder', path: absPath, bytesFreed: 0 };
  }
  if (guardCtx) await logCheckoutDeletionAttempt(absPath, caller, 'allowed', guardCtx);
  const isGit = await fs.access(path.join(absPath, '.git')).then(() => true, () => false);
  if (isGit) {
    const wtResult = await removeGitWorktree(root, absPath, { gitImpl, caller, guardCtx: null });
    if (wtResult?.skipped) return { skipped: true, reason: wtResult.reason, path: absPath, bytesFreed: 0 };
  }
  else await fs.rm(absPath, { recursive: true, force: true });
  if (log && runId) await appendRunCleanupJournal(root, runId, { path: absPath, bytesFreed: bytes });
  return { path: absPath, bytesFreed: bytes };
}

export async function pathsForJobCleanup(root, state, job, { includeWorkspace = true } = {}) {
  const paths = new Set();
  if (includeWorkspace) {
    const workspaceRel = typeof job.workspace === 'string' ? job.workspace : expectedWorkspaceFor(state.id, job.id, job);
    paths.add(path.join(root, workspaceRel));
  }
  if (job.worktreePath) paths.add(job.worktreePath);
  else if (state.worktreesBase) paths.add(resolveWorktree(state, job));
  return [...paths];
}

export async function cleanupRunWorkspaces(root, id, state, options = {}) {
  const config = options.config ?? loadLocalConfig({ env: options.env ?? process.env });
  if (resolveKeepWorkspaces(config, options) || state.keepWorkspaces) {
    return { kept: true, removed: [], bytesFreed: 0 };
  }
  if (state.status === 'running' || (state.jobs ?? []).some(isRunningJob)) {
    return { skipped: true, reason: 'run-active', removed: [], bytesFreed: 0 };
  }
  const jobs = jobsEligibleForCleanup(state, { forGc: options.forGc === true });
  if (!jobs.length) return { removed: [], bytesFreed: 0 };
  root = await fs.realpath(root);
  const worktreesBase = state.worktreesBase ?? await worktreesBaseFor(root, config, { env: options.env ?? process.env });
  const bases = [path.join(root, '.swarm', 'workspaces'), worktreesBase];
  const dryRun = options.dryRun === true;
  const includeWorkspace = options.removeWorkspaceCopies !== false;
  const guardCtx = gcStateGuardContext(options);
  const removed = [];
  let bytesFreed = 0;
  const seen = new Set();
  for (const job of jobs) {
    for (const p of await pathsForJobCleanup(root, state, job, { includeWorkspace })) {
      const abs = path.resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const result = await removePath(root, abs, bases, { gitImpl: options.gitImpl ?? git, duImpl: options.duImpl, runId: id, dryRun, log: options.log !== false, guardCtx });
      if (!result.skipped && !result.missing) {
        removed.push(result);
        bytesFreed += result.bytesFreed ?? 0;
      }
    }
  }
  const runWtDir = state.worktreesBase ? path.join(state.worktreesBase, id) : null;
  if (runWtDir && !dryRun) {
    try {
      const entries = await fs.readdir(runWtDir);
      if (entries.length === 0) await fs.rmdir(runWtDir);
    } catch { /* gone or not empty */ }
  }
  return { removed, bytesFreed };
}

export async function cleanupRunAfterTerminal(root, id, state, options = {}) {
  if (!state.integratedAt || state.integrationStatus === 'partial') {
    return { removed: [], bytesFreed: 0 };
  }
  return cleanupRunWorkspaces(root, id, state, options);
}

async function runMtime(dir) {
  try { return (await fs.stat(dir)).mtimeMs; } catch { return 0; }
}

async function projectHasActiveRun(root) {
  let ids;
  try { ids = await fs.readdir(path.join(root, '.swarm', 'runs')); } catch { return false; }
  for (const id of ids) {
    let state;
    try { state = await readState(root, id); } catch { continue; }
    if (state.status === 'running') return true;
  }
  return false;
}

async function collectRunWorktreePaths(root, state) {
  const out = new Set();
  for (const job of state.jobs ?? []) {
    if (typeof job.worktreePath === 'string' && job.worktreePath) out.add(job.worktreePath);
    else if (state.worktreesBase) out.add(resolveWorktree(state, job));
  }
  return out;
}

function runTerminalForGc(state, olderThanMs, nowMs, keepFailedMs) {
  const end = state.finishedAt ?? state.cancelledAt ?? state.integratedAt;
  const endMs = end ? Date.parse(end) : nowMs;
  if (state.integratedAt) return nowMs - endMs >= olderThanMs;
  if (runFailedOrAbandoned(state)) {
    const retentionMs = Math.max(olderThanMs, keepFailedMs);
    return nowMs - endMs >= retentionMs;
  }
  if (state.status === 'complete' && !state.integratedAt) return false;
  return false;
}

async function summarizeRunFolder(root, runId) {
  const runDir = path.join(root, '.swarm', 'runs', runId);
  const bytes = await pathBytes(runDir, {}) ?? 0;
  return { runId, path: runDir, bytes };
}

async function writeRunSummary(root, runId) {
  const runDir = path.join(root, '.swarm', 'runs', runId);
  const statePath = path.join(runDir, 'state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch { state = { id: runId }; }
  const journalPath = path.join(runDir, 'journal.ndjson');
  let journalLines = 0;
  try {
    const text = await fs.readFile(journalPath, 'utf8');
    journalLines = text.split('\n').filter(Boolean).length;
  } catch { /* no journal */ }
  const summary = {
    id: runId,
    status: state.status,
    integrationStatus: state.integrationStatus ?? null,
    integratedAt: state.integratedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    cancelledAt: state.cancelledAt ?? null,
    journalLines,
    summarizedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

async function gitWorktreeList(root, { gitImpl = git } = {}) {
  try {
    const text = await gitImpl(root, ['worktree', 'list', '--porcelain']);
    const worktrees = [];
    let current = {};
    for (const line of text.split('\n')) {
      if (!line) {
        if (current.path) worktrees.push(current);
        current = {};
        continue;
      }
      if (line.startsWith('worktree ')) current.path = line.slice('worktree '.length);
      if (line === 'bare') current.bare = true;
      if (line.startsWith('branch ')) current.branch = line.slice('branch '.length);
    }
    if (current.path) worktrees.push(current);
    return worktrees;
  } catch {
    return [];
  }
}

async function worktreeUnsafeToRemove(worktreePath, { gitImpl = git, forceUnsafe = false } = {}) {
  if (forceUnsafe) return { unsafe: false, warned: true };
  let dirty = false;
  try {
    const status = await gitImpl(worktreePath, ['status', '--porcelain']);
    dirty = Boolean(status.trim());
  } catch { dirty = true; }
  if (dirty) return { unsafe: true, reason: 'uncommitted-changes' };
  try {
    const branch = (await gitImpl(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch && branch !== 'HEAD') {
      const unpushed = await gitImpl(worktreePath, ['log', `@{u}..`, '--oneline']).catch(() => '');
      if (unpushed.trim()) return { unsafe: true, reason: 'unpushed-commits' };
    }
  } catch { /* detached */ }
  return { unsafe: false };
}

export async function loadDiskUsageCache(root) {
  const file = path.join(root, '.swarm', 'disk-usage.json');
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data?.at && Date.now() - Date.parse(data.at) < DISK_USAGE_CACHE_MS) return data;
  } catch { /* refresh */ }
  return null;
}

export async function computeDiskUsage(root, deps = {}) {
  const cached = await loadDiskUsageCache(root);
  if (cached && !deps.force) return cached.diskUsage;
  const realRoot = await fs.realpath(root);
  const config = loadLocalConfig({ env: deps.env ?? process.env });
  const worktreesBase = await worktreesBaseFor(realRoot, config, { env: deps.env ?? process.env });
  const deadline = Date.now() + SIZE_WALK_MS;
  const duImpl = deps.duImpl ?? (async args => execFileAsync('du', args, { encoding: 'utf8' }));
  const worktrees = await pathBytes(worktreesBase, { duImpl, deadline: () => Date.now() >= deadline }) ?? 0;
  const workspaces = await pathBytes(path.join(realRoot, '.swarm', 'workspaces'), { duImpl, deadline: () => Date.now() >= deadline }) ?? 0;
  let runFolders = 0;
  try {
    const runs = await fs.readdir(path.join(realRoot, '.swarm', 'runs'));
    for (const id of runs) {
      runFolders += await pathBytes(path.join(realRoot, '.swarm', 'runs', id), { duImpl, deadline: () => Date.now() >= deadline }) ?? 0;
    }
  } catch { /* no runs */ }
  const diskUsage = {
    projects: [{ root: realRoot, worktrees, workspaces, runFolders, bytes: worktrees + workspaces + runFolders }],
    totalBytes: worktrees + workspaces + runFolders,
  };
  const file = path.join(realRoot, '.swarm', 'disk-usage.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), diskUsage }, null, 2)}\n`);
  return diskUsage;
}

export async function collectProjectGcPlan(root, opts = {}) {
  const {
    olderThanDays = 7,
    keepRuns = 20,
    nowMs = Date.now(),
    env = process.env,
    home = os.homedir(),
    includeScratch = false,
    archiveUntracked = false,
    forceUnsafe = false,
    gitImpl = git,
    duImpl,
    registryFile = projectsFile(env, home),
    fs: fsDep = fs,
  } = opts;
  const olderThanMs = olderThanDays * 86400000;
  root = await fs.realpath(root);
  const config = loadLocalConfig({ env });
  const keepFailedMs = resolveKeepFailedDays(config, env) * 86400000;
  const worktreesBase = await worktreesBaseFor(root, config, { env });
  const bases = [path.join(root, '.swarm', 'workspaces'), worktreesBase];
  const protectedPaths = await collectProtectedWorkspacePaths(root);
  const categories = { finishedRuns: [], orphans: [], oldRunFolders: [], scratch: [], untrackedArchives: [] };
  let totalBytes = 0;

  const runsDir = path.join(root, '.swarm', 'runs');
  let runIds = [];
  try { runIds = (await fs.readdir(runsDir)).filter(Boolean).sort(); } catch { runIds = []; }
  const referencedWt = new Set();
  for (const id of runIds) {
    let state;
    try { state = await readState(root, id); } catch { continue; }
    for (const p of await collectRunWorktreePaths(root, state)) referencedWt.add(path.resolve(p));
    if (!runTerminalForGc(state, olderThanMs, nowMs, keepFailedMs)) continue;
    if (state.status === 'running') continue;
    for (const job of jobsEligibleForCleanup(state, { forGc: true })) {
      for (const p of await pathsForJobCleanup(root, state, job)) {
        const abs = path.resolve(p);
        if (pathProtected(abs, protectedPaths)) continue;
        if (!(await assertUnderBases(abs, bases))) continue;
        const mtime = await runMtime(abs);
        const ageMs = runFailedOrAbandoned(state) ? Math.max(olderThanMs, keepFailedMs) : olderThanMs;
        if (mtime && nowMs - mtime < ageMs) continue;
        const bytes = await pathBytes(abs, { duImpl }) ?? 0;
        categories.finishedRuns.push({ path: abs, bytes, runId: id });
        totalBytes += bytes;
      }
    }
  }

  for (const wt of await gitWorktreeList(root, { gitImpl })) {
    if (!wt.path || wt.bare) continue;
    try { await fs.access(wt.path); } catch {
      categories.orphans.push({ path: wt.path, bytes: 0, kind: 'git-metadata' });
    }
  }

  try {
    const runDirs = await fs.readdir(worktreesBase, { withFileTypes: true });
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const runPath = path.join(worktreesBase, runDir.name);
      let jobDirs = await fs.readdir(runPath, { withFileTypes: true });
      for (const jobDir of jobDirs) {
        if (!jobDir.isDirectory()) continue;
        const candidate = path.join(runPath, jobDir.name);
        const candidateAbs = path.resolve(candidate);
        if (referencedWt.has(candidateAbs)) continue;
        if (pathProtected(candidateAbs, protectedPaths)) continue;
        const mtime = await runMtime(candidate);
        if (nowMs - mtime < olderThanMs) continue;
        const bytes = await pathBytes(candidate, { duImpl }) ?? 0;
        categories.orphans.push({ path: candidate, bytes });
        totalBytes += bytes;
      }
    }
  } catch { /* no base */ }

  const sortedRuns = runIds.slice().sort((a, b) => b.localeCompare(a));
  const dropRuns = sortedRuns.slice(keepRuns);
  for (const runId of dropRuns) {
    const runDir = path.join(runsDir, runId);
    const mtime = await runMtime(runDir);
    if (nowMs - mtime < olderThanMs) continue;
    const bytes = await pathBytes(runDir, { duImpl }) ?? 0;
    categories.oldRunFolders.push({ path: runDir, bytes, runId });
    totalBytes += bytes;
  }

  if (archiveUntracked) {
    for (const row of await collectArchiveUntrackedRuns(root, { nowMs, duImpl })) {
      categories.untrackedArchives.push(row);
      totalBytes += row.bytes;
    }
  }

  if (includeScratch) {
    const scratchBase = scratchRootDir({ env });
    let entries = [];
    try { entries = await fs.readdir(scratchBase, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(scratchBase, entry.name);
      const mtime = await runMtime(candidate);
      if (nowMs - mtime < olderThanMs) continue;
      if (await holdsSwarmState(candidate, { fs: fsDep, registryFile })) continue;
      const safety = await worktreeUnsafeToRemove(candidate, { gitImpl, forceUnsafe });
      if (safety.unsafe) continue;
      const bytes = await pathBytes(candidate, { duImpl }) ?? 0;
      categories.scratch.push({ path: candidate, bytes });
      totalBytes += bytes;
    }
  }

  return { root, categories, totalBytes, bases, worktreesBase };
}

function formatTable(rows) {
  const lines = ['path'.padEnd(60) + 'bytes'];
  for (const row of rows) lines.push(`${row.path.slice(0, 60).padEnd(60)}${String(row.bytes).padStart(12)}`);
  return `${lines.join('\n')}\n`;
}

export async function applyProjectGcPlan(root, plan, opts = {}) {
  const { gitImpl = git, duImpl, forceUnsafe = false } = opts;
  const guardCtx = gcStateGuardContext(opts);
  if (await projectHasActiveRun(root)) return { skipped: true, reason: 'active-run', bytesFreed: 0 };
  let bytesFreed = 0;
  const removed = [];
  for (const row of [...plan.categories.finishedRuns, ...plan.categories.orphans.filter(o => o.kind !== 'git-metadata')]) {
    const result = await removePath(root, row.path, plan.bases, { gitImpl, duImpl, dryRun: false, log: false, guardCtx });
    if (!result.skipped) { bytesFreed += result.bytesFreed ?? 0; removed.push(result); }
  }
  for (const wt of plan.categories.orphans.filter(o => o.kind === 'git-metadata')) {
    try { await gitImpl(root, ['worktree', 'prune']); } catch { /* ignore */ }
  }
  for (const row of [...plan.categories.oldRunFolders, ...plan.categories.untrackedArchives]) {
    await writeRunSummary(root, row.runId);
    const heavy = ['jobs', 'worktrees', 'artifacts'];
    for (const name of heavy) {
      const target = path.join(row.path, name);
      try {
        const bytes = await pathBytes(target, { duImpl }) ?? 0;
        await fs.rm(target, { recursive: true, force: true });
        bytesFreed += bytes;
      } catch { /* missing */ }
    }
    removed.push({ path: row.path, bytesFreed: row.bytes });
  }
  for (const row of plan.categories.scratch) {
    if (await holdsSwarmState(row.path, { fs: guardCtx.fsImpl, registryFile: guardCtx.registryFile })) {
      await logCheckoutDeletionAttempt(row.path, 'gc.applyScratch', 'refused', guardCtx);
      continue;
    }
    const safety = await worktreeUnsafeToRemove(row.path, { gitImpl, forceUnsafe });
    if (safety.unsafe && !forceUnsafe) continue;
    const result = await removePath(root, row.path, [scratchRootDir({ env: opts.env })], { gitImpl, duImpl, dryRun: false, log: false, caller: 'gc.applyScratch', guardCtx });
    if (!result.skipped) bytesFreed += result.bytesFreed ?? 0;
  }
  await appendGcLog(root, `${new Date().toISOString()} apply freed=${bytesFreed}`);
  return { bytesFreed, removed };
}

export async function runGc(args, deps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  let apply = false;
  let allProjects = false;
  let root = deps.root ?? null;
  let olderThanDays = 7;
  let keepRuns = 20;
  let includeScratch = false;
  let json = false;
  let usageOnly = false;
  let forceUnsafe = false;
  let archiveUntracked = false;
  const rest = [...args];
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--apply') apply = true;
    else if (flag === '--all-projects') allProjects = true;
    else if (flag === '--include-scratch') includeScratch = true;
    else if (flag === '--archive-untracked') archiveUntracked = true;
    else if (flag === '--json') json = true;
    else if (flag === '--usage') usageOnly = true;
    else if (flag === '--force-unsafe') forceUnsafe = true;
    else if (flag === '--older-than') olderThanDays = Number(rest[++i]);
    else if (flag === '--keep-runs') keepRuns = Number(rest[++i]);
    else if (flag === '--root') root = rest[++i];
    else if (flag.startsWith('-')) return { stdout: `unknown flag: ${flag}\n${GC_USAGE}`, exitCode: 2 };
    else return { stdout: `unexpected argument: ${flag}\n${GC_USAGE}`, exitCode: 2 };
  }
  if (usageOnly && json) {
    const projectRoot = root ? path.resolve(root) : deps.defaultRoot?.();
    if (!projectRoot) return { stdout: '{"error":"missing root"}\n', exitCode: 2 };
    const diskUsage = await computeDiskUsage(projectRoot, deps);
    return { stdout: `${JSON.stringify({ diskUsage })}\n`, exitCode: 0 };
  }
  const projects = allProjects
    ? (await listProjects({ includeScratch: true, env, home })).map(p => p.root)
    : [root ? path.resolve(root) : deps.defaultRoot?.()].filter(Boolean);
  if (!projects.length) return { stdout: `${GC_USAGE}`, exitCode: 2 };
  const plans = [];
  let totalBytes = 0;
  const counts = { finishedRuns: 0, orphans: 0, oldRunFolders: 0, scratch: 0, untrackedArchives: 0 };
  for (const projectRoot of projects) {
    if (apply && await projectHasActiveRun(projectRoot)) {
      plans.push({ root: projectRoot, skipped: true, reason: 'active-run' });
      continue;
    }
    const plan = await collectProjectGcPlan(projectRoot, { olderThanDays, keepRuns, env, includeScratch, archiveUntracked, forceUnsafe, gitImpl: deps.gitImpl, duImpl: deps.duImpl, nowMs: deps.now?.() ?? Date.now() });
    plans.push(plan);
    for (const key of Object.keys(counts)) counts[key] += plan.categories[key].length;
    totalBytes += plan.totalBytes;
  }
  if (apply) {
    let freed = 0;
    for (const plan of plans) {
      if (plan.skipped) continue;
      const result = await applyProjectGcPlan(plan.root, plan, { gitImpl: deps.gitImpl, duImpl: deps.duImpl, forceUnsafe, env, home: deps.home ?? home });
      freed += result.bytesFreed ?? 0;
    }
    if (json) return { stdout: `${JSON.stringify({ apply: true, bytesFreed: freed, counts, totalBytes: freed })}\n`, exitCode: 0 };
    return { stdout: `freed ${freed} bytes\n`, exitCode: 0 };
  }
  const rows = [];
  for (const plan of plans) {
    if (plan.skipped) continue;
    for (const key of Object.keys(plan.categories)) for (const row of plan.categories[key]) rows.push(row);
  }
  if (json) {
    const diskUsage = await computeDiskUsage(projects[0], deps);
    return { stdout: `${JSON.stringify({ dryRun: true, counts, totalBytes, plans: plans.map(p => ({ root: p.root, categories: p.categories, totalBytes: p.totalBytes, skipped: p.skipped, reason: p.reason })), diskUsage })}\n`, exitCode: 0 };
  }
  return { stdout: formatTable(rows), exitCode: 0 };
}
