// SPDX-License-Identifier: Apache-2.0
// `swarm watch` and `swarm gallery`: command glue for the read-only dashboard. The pieces
// (state, plan, delta, server, tui, gallery) are separate modules; this only wires them.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRunSnapshot } from './watch-state.mjs';
import { sanitizeWorkerText, UNTRUSTED_LABEL } from './worker-text.mjs';
import { buildPlanSnapshot } from './watch-plan.mjs';
import { liveOverview } from './board-live.mjs';
import { createWatchServer } from './watch-server.mjs';
import { renderTui } from './watch-tui.mjs';
import { readGallery, approveScreens, addComment } from './watch-gallery.mjs';
import { ticketComments } from './gallery-tickets.mjs';
import { buildCommandList, contextCommands } from './watch-command-meta.mjs';
import { COMMANDS } from './completion.mjs';
import {
  readLedger,
  writeLedger,
  validateTicket,
  approveLedger,
  isApproved,
  transition,
  appendLog,
} from './tickets.mjs';
import { decide } from './inbox.mjs';
import { inboxDeps } from './inbox-commands.mjs';
import { decideRequest } from './handbuild.mjs';
import { boardSummary, listLiveRuns } from './board.mjs';
import { listProjects, projectsFile, projectId, isScratchRoot } from './projects.mjs';
import { isBoardTempRoot } from './scratch-roots.mjs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { readHistory, historyFile } from './history.mjs';
import { boardInbox, inboxText } from './board-inbox.mjs';
import { createOwnerActions, ownerItemsFromBoardInbox } from './board-owner-actions.mjs';
import { guardBoardAction } from './board-action-guard.mjs';
import { remoteFile } from './remote.mjs';
import { runDetail, compareRuns } from './board-run.mjs';
import { boardSnapshot, projectDetail, workersHeld, laneUsage, enrichRunEvents, readRunStates, readProjectRunStates, projectFamilyRoots, isTestOrTempProject } from './board-data.mjs';
import { createPeerCache, listPeers, mergeMachines, publicPeers } from './board-peers.mjs';
import { versionInfo } from './server-version.mjs';
import { boardPools } from './pools-board.mjs';
import { resolveBudget, spendDir } from './spend.mjs';
import { lanesDir, machineConcurrency } from './lanes.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { backfillHistory } from './board-commands.mjs';
import { projectSummary } from './project-spend.mjs';
import { createDeployTracker } from './deploy-status.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LIVE = new Set(['running', 'queued']);

export const WATCH_USAGE = 'Usage: swarm watch [RUN] [--all [--text|--json]] [--tui] [--open] [--json]\n       swarm gallery list | approve ID... | comment ID "text" | tickets [ID...]\n';

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

const openTicketStatus = new Set(['todo', 'ready', 'running', 'review', 'blocked']);
const activeState = state => state?.status === 'running' || state?.status === 'paused';
const timestampOfRun = run => Math.max(Date.parse(run.state?.startedAt ?? '') || 0, Date.parse(run.state?.finishedAt ?? '') || 0, run.mtimeMs ?? 0);
const HISTORY_RECENT_KINDS = new Set(['run', 'pr', 'merge', 'spend']);
const WEEK = 7 * 86400000;

async function projectTestFacts(project, { now, liveRuns = [], env = process.env } = {}) {
  const root = await fs.realpath(project.root).catch(() => path.resolve(project.root));
  const pointer = await readJson(path.join(root, '.project-swarm.json'));
  const ledger = await readLedger(root).catch(() => null);
  const familyRoots = await projectFamilyRoots(root, { env });
  const runs = await readProjectRunStates(root, { env, familyRoots });
  const scopeFile = await Promise.any([
    fs.stat(path.join(root, 'docs', 'scope', 'roadmap.md')),
    fs.stat(path.join(root, 'docs', 'scope', 'scope.md')),
  ]).then(() => true, () => false);
  const marker = await fs.stat(path.join(root, '.swarm-scratch')).then(() => true, () => false);
  const openTickets = (ledger?.tickets ?? []).some(ticket => openTicketStatus.has(ticket?.status));
  const approvedLedger = Boolean(ledger?.approved === true || ledger?.approval === true || ledger?.scope);
  const scratchBase = path.join(os.homedir(), '.project-swarm-scratch');
  const parts = root.split(path.sep).filter(Boolean);
  const pathScratch = isScratchRoot(root)
    || root === scratchBase
    || root.startsWith(`${scratchBase}${path.sep}`)
    || parts.some(part => part.startsWith('.tmp-test'))
    || parts.some(part => ['tmp', 'temp', 'test', 'tests', '__tests__'].includes(part));
  const recentOnDisk = runs.some(run => now - timestampOfRun(run) <= WEEK && timestampOfRun(run) <= now);
  const historyPage = await readHistory({
    file: historyFile(env),
    project: project.id,
    from: new Date(now - WEEK).toISOString(),
    to: new Date(now).toISOString(),
    limit: 1000,
  }).catch(() => ({ events: [] }));
  const recentInHistory = (historyPage.events ?? []).some(event => HISTORY_RECENT_KINDS.has(event.kind));
  const live = liveRuns.some(record => {
    const recordRoot = path.resolve(String(record.root ?? root));
    return familyRoots.includes(recordRoot) && activeState(runs.find(run => run.root === recordRoot && run.id === record.runId)?.state);
  });
  const spend = await projectSummary(root, { env, ttlMs: 0 }).catch(() => ({}));
  // History revives a real registered project, but never changes a path-based scratch
  // classification. This keeps the scratch toggle/counts independent of old log entries.
  const recentRun = recentOnDisk || (recentInHistory && !pathScratch);
  const displayName = String(project.name ?? '').trim();
  const namelessNoRuns = (!displayName || displayName === String(project.id)) && runs.length === 0;
  const idleHidden = !pathScratch && !pointer?.scratch && !pointer?.profile?.scratch
    && !marker && !scopeFile && !ledger?.scope && !approvedLedger && !openTickets
    && !recentRun && !live && !project.pinned
    && !(Number(spend.spendUsd ?? spend.billedUsd ?? spend.usd ?? 0) > 0);
  return {
    tmpdir: os.tmpdir(),
    scratchBase: path.join(os.homedir(), '.project-swarm-scratch'),
    isScratchRoot: isScratchRoot(root),
    pointer,
    pointerScratch: pointer?.scratch === true || pointer?.profile?.scratch === true,
    marker,
    scopeFile,
    hasScope: Boolean(ledger?.scope),
    approvedLedger,
    openTickets,
    recentRun,
    idleHidden,
    live,
    spendUsd: Number(spend.spendUsd ?? spend.billedUsd ?? spend.usd ?? 0),
    namelessNoRuns,
  };
}

function projectHiddenFromBoard(project, { scratch, env }) {
  if (project.namelessNoRuns) return true;
  if (!scratch) {
    if (project.idleHidden) return true;
    if (project.testOrTemp) return true;
    if (project.live) return false;
    return isBoardTempRoot(project.root, boardProjectOpts(env));
  }
  if (project.idleHidden && !project.testOrTemp && !project.live
    && !isBoardTempRoot(project.root, boardProjectOpts(env))) return true;
  return false;
}

async function classifyProjects(projects, { now = Date.now(), liveRuns = [], env = process.env } = {}) {
  return Promise.all(projects.map(async project => {
    const facts = await projectTestFacts(project, { now, liveRuns, env });
    return {
      ...project,
      testOrTemp: isTestOrTempProject(project, facts),
      idleHidden: Boolean(facts.idleHidden),
      live: Boolean(facts.live),
    };
  }));
}

// Run ids start with a millisecond timestamp, so a name sort puts the newest last.
export async function findRunId(root, wanted) {
  const dir = path.join(root, '.swarm', 'runs');
  if (wanted) return (await readJson(path.join(dir, wanted, 'state.json'))) ? wanted : null;
  let names;
  try { names = (await fs.readdir(dir)).filter(n => RUN_ID_RE.test(n)).sort(); } catch { return null; }
  let newest = null;
  for (const name of names.slice(-30).reverse()) {
    const state = await readJson(path.join(dir, name, 'state.json'));
    if (!state) continue;
    if (LIVE.has(state.status)) return name;
    newest ??= name;
  }
  return newest;
}

// What the drawer shows for one job: the worker's own report. It is worker text: sanitised, capped, and labelled as data, never instructions.
export function jobReportLoader(root, runId) {
  const file = path.join(root, '.swarm', 'runs', runId, 'state.json');
  const list = (value, count, max) => (Array.isArray(value) ? value.slice(0, count).map(item => sanitizeWorkerText(typeof item === 'string' ? item : JSON.stringify(item), max)) : []);
  return async id => {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(id))) return null;
    const state = await readJson(file);
    const job = (state?.jobs ?? []).find(entry => entry?.id === id);
    if (!job) return null;
    const report = job.report && typeof job.report === 'object' ? job.report : null;
    return {
      label: UNTRUSTED_LABEL,
      id,
      status: sanitizeWorkerText(job.status ?? '', 40),
      summary: report ? sanitizeWorkerText(report.summary ?? '', 800) : null,
      reportStatus: report ? sanitizeWorkerText(report.status ?? '', 40) : null,
      files: list(report?.files, 30, 200),
      risks: list(report?.risks, 8, 400),
      followups: list(report?.followups, 8, 400),
      error: job.error ? sanitizeWorkerText(job.error, 600) : null,
      checksDeferred: Boolean(job.checksDeferred),
    };
  };
}

export function runSnapshotLoader(root, runId) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  return async () => {
    const state = await readJson(path.join(dir, 'state.json'));
    if (!state) return null;
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    const snapshot = buildRunSnapshot(state, { manifest, now: Date.now() });
    snapshot.project = await projectSummary(root).then(summary => ({ ...summary, capBasis: summary.capBasis ?? (typeof summary.billedUsd === 'number' ? 'billed' : 'billed+list') })).catch(() => null);
    return snapshot;
  };
}

const planLoader = root => async () => buildPlanSnapshot(await readLedger(root).catch(() => null));

function parseWatchArgs(args) {
  const opts = { all: false, tui: false, open: false, json: false, text: false, run: null };
  for (const arg of args) {
    if (arg === '--all') opts.all = true;
    else if (arg === '--tui') opts.tui = true;
    else if (arg === '--open') opts.open = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--text') opts.text = true;
    else if (arg.startsWith('--')) return { error: `Unknown flag: ${arg}` };
    else if (opts.run === null && RUN_ID_RE.test(arg)) opts.run = arg;
    else return { error: `Invalid argument: ${arg}` };
  }
  return opts;
}

// swarm go starts Swarm Watch for its run when a person is at the terminal. Never in CI, a pipe, or with --no-watch / SWARM_NO_WATCH.
export function shouldAutoWatch({ noWatch = false, env = process.env, tty = Boolean(process.stderr.isTTY && process.stdout.isTTY) } = {}) {
  if (noWatch || !tty) return false;
  if (env.SWARM_NO_WATCH || env.CI) return false;
  return true;
}

// Starts `swarm watch RUN` as a background process (it stops itself when the run is done and the page is closed, or after 30 minutes idle),
// and returns its page address once it prints it. Returns null when it did not come up in time; the run is never held back by it.
export async function startWatchBackground(root, runId, { entry = path.join(here, 'swarm.mjs'), spawnImpl = spawn, waitMs = 4000, pollMs = 100 } = {}) {
  if (!RUN_ID_RE.test(String(runId))) return null;
  const logFile = path.join(root, '.swarm', 'runs', runId, 'watch.log');
  let fd = null;
  try {
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    // Never through a symlink or onto a file that is not ours: the log holds the page's token.
    const existing = await fs.lstat(logFile).catch(() => null);
    if (existing && !existing.isFile()) return null;
    fd = openSync(logFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
    const child = spawnImpl(process.execPath, [entry, '--root', root, 'watch', runId], { detached: true, windowsHide: true, stdio: ['ignore', fd, 'ignore'], env: { ...process.env, SWARM_NO_WATCH: '1' } });
    child.on?.('error', () => {});
    child.unref?.();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const match = /^(http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)$/m.exec(await fs.readFile(logFile, 'utf8').catch(() => ''));
      if (match) return match[1];
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return null;
  } catch { return null; } finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
}

function openUrl(url) {
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(bin, argv, () => {});
}

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
// Run ids and roots come from files on disk: only well-formed ones are shown, and the copied command quotes both.
async function safeBoard() {
  const { runs } = await boardSummary();
  return { runs: runs.filter(run => RUN_ID_RE.test(String(run.runId)) && typeof run.root === 'string' && !/[\u0000-\u001f]/.test(run.root)) };
}

function boardProjectOpts(env = process.env) {
  return { env, home: env.HOME ?? os.homedir() };
}

async function boardText({ env = process.env } = {}) {
  const { runs } = await safeBoard();
  const opts = boardProjectOpts(env);
  const projects = await listProjects({ file: projectsFile(env), forOwner: true, ...opts }).catch(() => []);
  const needs = inboxText(await boardInbox({ projects, env, forOwner: true }).catch(() => null));
  if (!runs.length) return `No live runs on this machine.\n${needs}`;
  return runs.map(run => {
    const done = run.jobs.filter(job => job.status === 'complete').length;
    return `${run.runId}  ${run.status}  ${done}/${run.jobs.length} jobs  ${run.root}\n  watch: swarm --root ${shellQuote(run.root)} watch ${shellQuote(run.runId)}`;
  }).join('\n') + `\n${needs}`;
}

async function tuiLoop(root, runId, write) {
  const load = runSnapshotLoader(root, runId);
  const plan = planLoader(root);
  const frame = async () => renderTui(await load(), { width: process.stdout.columns || 100, color: Boolean(process.stdout.isTTY), plan: await plan() });
  if (!process.stdout.isTTY) { write(`${await frame()}\n`); return; }
  let stop = false;
  const stdin = process.stdin;
  if (stdin.isTTY) { stdin.setRawMode(true); stdin.resume(); stdin.on('data', key => { if (String(key) === 'q' || String(key) === String.fromCharCode(3)) stop = true; }); }
  try {
    while (!stop) {
      write(`\u001b[H\u001b[2J${await frame()}\n`);
      const snapshot = await load();
      if (snapshot && (snapshot.status === 'complete' || snapshot.status === 'failed')) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally { if (stdin.isTTY) { stdin.setRawMode(false); stdin.pause(); } }
}

// The Watch server of one run: its own port and its own token.
export function makeRunServer(root, runId, extra = {}) {
  return createWatchServer({
    root,
    getRunSnapshot: runSnapshotLoader(root, runId),
    getPlanSnapshot: planLoader(root),
    getGallery: () => readGallery(root),
    getJobReport: jobReportLoader(root, runId),
    commandList: buildCommandList(COMMANDS),
    contextCommands,
    assetDir: path.join(here, 'watch-assets'),
    deltaFile: path.join(here, 'watch-delta.mjs'),
    ...extra,
  });
}

// What the board server calls. Every lookup goes through the machine's project list: a project is named by its id, never by a path the page could send,
// and a project's runs, tickets and files are only ever read under its own root.
// Finding the board from anywhere. A running board writes its address (it holds the board's own token) to a file only the user can read; a run page that wants to
// go back to it reads that file, checks the board still answers, and otherwise starts one in its own process.
export const boardFile = (env = process.env, home = os.homedir()) => env.SWARM_BOARD_FILE || path.join(home, '.project-swarm', 'board.json');

export function safeEnvSubset(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'HOME' || key === 'PATH') out[key] = String(value);
    else if (key.startsWith('SWARM') && typeof value === 'string') out[key] = value;
  }
  return out;
}

export function serverMode({ stdin = process.stdin, stdout = process.stdout, explicitBackground = false } = {}) {
  if (stdin.isTTY && stdout.isTTY) return 'terminal';
  if (explicitBackground && !stdin.isTTY && !stdout.isTTY) return 'background';
  if (!explicitBackground) return stdin.isTTY && stdout.isTTY ? 'terminal' : 'background';
  return 'terminal';
}

export function argvForRemoteServe(remote, registry = {}) {
  if (Array.isArray(registry.argv) && registry.argv.length) return registry.argv;
  const argv = ['remote', 'serve'];
  if (remote?.port != null) argv.push('--port', String(remote.port));
  if (typeof remote?.login === 'string' && remote.login) argv.push('--login', remote.login);
  if (Array.isArray(remote?.hosts)) {
    for (const host of remote.hosts) {
      if (typeof host === 'string') argv.push('--host', host);
      else if (host && typeof host.host === 'string') argv.push('--host', host.host);
      else if (host && typeof host.name === 'string') argv.push('--host', host.name);
    }
  }
  return argv;
}

export function registryModeFields(mode, { stdin = process.stdin, stdout = process.stdout, explicitBackground = false } = {}) {
  const fromTty = !stdin.isTTY && !stdout.isTTY;
  return {
    mode,
    ...(mode === 'background' && explicitBackground ? { explicitBackground: true, modeFromTty: fromTty } : {}),
  };
}

async function readPackageVersion(root = here) {
  try { return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

async function installedVersionFor(env, versionState = {}) {
  const install = env?.SWARM_INSTALL_DIR;
  if (install) {
    const direct = await readPackageVersion(path.join(install, 'current'));
    if (direct) return direct;
  }
  return versionState?.installedVersion ?? null;
}
// A board of ours belongs to this user: a process that exists but is not ours (EPERM) is not one.
const pidAlive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

async function boardAnswers(url, fetchImpl = fetch) {
  try {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1') return false;
    // Only our own board answers with the board's shape; a redirect is never followed (the token goes to this address and nowhere else).
    const res = await fetchImpl(`${u.origin}/api/board?t=${encodeURIComponent(u.searchParams.get('t') ?? '')}`, { redirect: 'manual', signal: AbortSignal.timeout?.(2000) });
    if (!res.ok) return false;
    const body = typeof res.json === 'function' ? await res.json() : null;
    return Boolean(body) && typeof body === 'object' && Array.isArray(body.projects) && Boolean(body.machine);
  } catch { return false; }
}

export async function writeBoardFile(url, { env = process.env, registry = {} } = {}) {
  const file = boardFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const body = {
    pid: process.pid,
    url,
    startedAt: new Date().toISOString(),
    ...registry,
  };
  await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, file);
}

export async function readBoardFile({ env = process.env, fetchImpl = fetch } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(boardFile(env), 'utf8'));
    if (data && pidAlive(data.pid) && typeof data.url === 'string' && await boardAnswers(data.url, fetchImpl)) { const u = new URL(data.url); return `${u.origin}/?t=${encodeURIComponent(u.searchParams.get('t') ?? '')}`; }
  } catch { /* no board, or a stale file */ }
  return null;
}

// The board's own project page address, from the board's address: same server, same token.
export function boardProjectUrl(boardUrl, projectId) {
  const u = new URL(boardUrl);
  return `${u.origin}/project?id=${encodeURIComponent(projectId)}&t=${encodeURIComponent(u.searchParams.get('t') ?? '')}`;
}

let ownedBoard = null;   // a board this process started for a run page that was opened directly
export function ownedBoardDone() { return ownedBoard?.server.done ?? Promise.resolve(); }
export async function closeOwnedBoard() { if (ownedBoard) { const b = ownedBoard; ownedBoard = null; await b.server.close().catch(() => {}); await b.api.close().catch(() => {}); } }

// The board that exists, or a new one started here. `start` is injectable for tests.
let pendingBoard = null;
export function ensureBoard({ env = process.env, root, fetchImpl = fetch, start = startBoardServer } = {}) {
  // One lookup-or-start at a time in this process: two clicks at once share it, so only one board is ever started here.
  pendingBoard ??= (async () => {
    const found = await readBoardFile({ env, fetchImpl });
    if (found) return found;
    if (ownedBoard && await boardAnswers(ownedBoard.url, fetchImpl)) return ownedBoard.url;
    ownedBoard = await start({ env, root });
    return ownedBoard.url;
  })().finally(() => { pendingBoard = null; });
  return pendingBoard;
}

// The run page's navigation: where it sits and how to get back to the board (or to this project's page on it).
export function runNav({ root, runId, env = process.env, openBoard }) {
  const project = { id: projectId(root), name: path.basename(root).slice(0, 80) };
  return { project, runId, openBoard: openBoard ?? (async pid => { const board = await ensureBoard({ env, root }); return pid ? boardProjectUrl(board, pid) : board; }) };
}

const MAX_WATCHERS = 6;
const BOARD_RUN_IDLE_MS = 10 * 60 * 1000;

// Watch responses deliberately contain no money until a real billing source exists. These key
// fragments cover currency, cost, billing, list pricing, spend and budget fields; whole spend,
// cost and cap objects are also removed because their remaining shape can still imply money.
const MONEY_KEY_RE = /usd|Usd|USD|cost|Cost|billed|Billed|listValue|flatRate|price|Price|spend|Spend|budget|Budget/;
const hasNumber = value => Array.isArray(value)
  ? value.some(hasNumber)
  : value && typeof value === 'object'
    ? Object.values(value).some(hasNumber)
    : typeof value === 'number';
export function stripMoney(value) {
  if (Array.isArray(value)) return value.map(stripMoney);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'noCap') {
      out[key] = child === true;
      continue;
    }
    if (MONEY_KEY_RE.test(key) || key === 'spend' || key === 'cost' || key === 'cap' || key === 'caps' || (key === 'capBasis' && hasNumber(child))) continue;
    out[key] = stripMoney(child);
  }
  return out;
}

const historyCsvCell = value => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function publicHistoryCsv(events) {
  const head = ['at', 'project', 'kind', 'title', 'ref', 'run', 'url'];
  const rows = events
    .filter(event => event?.kind !== 'spend')
    .map(event => stripMoney(event))
    .map(event => [event.at, event.project, event.kind, event.title, event.ref, event.run, event.url].map(historyCsvCell).join(','));
  return `${[head.join(','), ...rows].join('\n')}\n`;
}

async function boardHistoryQuery(q, env, showsScratch, scratchIds) {
  if (q.kind === 'spend') return { total: 0, events: [] };
  const base = {
    file: historyFile(env),
    project: q.project || undefined,
    kind: q.kind || undefined,
    q: q.q || undefined,
    from: q.from || undefined,
    to: q.to || undefined,
    fold: true,
    exclude: showsScratch ? undefined : scratchIds,
  };
  const { events: all } = await readHistory({ ...base, limit: 1e6, cap: 1e6 });
  const filtered = all.filter(event => event.kind !== 'spend');
  const offset = Number(q.offset) || 0;
  const limit = Math.min(Math.max(1, Number(q.limit) || 100), 1000);
  return { total: filtered.length, events: filtered.slice(offset, offset + limit) };
}

function ownerAuditPath(env) {
  const home = env.HOME ?? os.homedir();
  return path.join(path.dirname(remoteFile(env, home)), '.swarm', 'owner', 'audit.ndjson');
}

export async function readOwnerAudit(env = process.env) {
  const auditFile = ownerAuditPath(env);
  let text = '';
  try {
    text = await fs.readFile(auditFile, 'utf8');
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

export async function approveProposedTicketOnBoard(root, ticketId, { now: nowFn }) {
  const fresh = await readLedger(root);
  if (!fresh) return { ok: false, message: 'no ticket ledger; run swarm scope split first' };
  const ticket = fresh.tickets.find(x => x.id === ticketId);
  if (!ticket) return { ok: false, message: `no ticket ${ticketId}` };
  if (ticket.status !== 'proposed') return { ok: false, message: `${ticket.id} is ${ticket.status}, not proposed` };
  if (!(ticket.files ?? []).length) return { ok: false, message: `${ticket.id} names no files yet` };
  const clash = [];
  for (const f of ticket.files) {
    const owners = fresh.tickets.filter(x => x.id !== ticket.id && ['todo', 'ready', 'running', 'review', 'blocked'].includes(x.status) && ((x.files ?? []).includes(f) || (x.deletes ?? []).includes(f)));
    if (owners.length) clash.push(`${f} (${owners.map(o => o.id).join(', ')})`);
  }
  if (clash.length) return { ok: false, message: `${ticket.id} writes files that open tickets also write` };
  const next = { ...ticket, status: 'todo', approvedBy: 'owner' };
  const v = validateTicket(next);
  if (!v.ok) return { ok: false, message: v.errors[0] };
  const wasApproved = isApproved(fresh);
  fresh.tickets = fresh.tickets.map(x => (x.id === ticket.id ? next : x));
  const prev = fresh.approved;
  const saved = wasApproved
    ? { ...fresh, approved: { ...prev, ...approveLedger(fresh, { by: 'owner', now: nowFn() }).approved, at: prev.at, ...(prev.ciTickets ? { ciTickets: prev.ciTickets } : {}) } }
    : fresh;
  saved.updatedAt = new Date(nowFn()).toISOString();
  await writeLedger(root, saved);
  await appendLog(root, { event: 'proposed-approved', id: ticket.id, by: 'owner', note: 'board' });
  return { ok: true };
}

export function boardOwnerApply(env, now = Date.now) {
  const inboxApplyDeps = inboxDeps({ channel: 'board', now });
  return async (item, answer, { identity, now: nowFn }) => {
    const root = item?.projectRoot;
    if (!root) return { ok: false, message: 'the action could not be applied' };
    const kind = item.kind;
    const decision = answer?.decision;
    const choice = answer?.choice ?? null;
    if (kind === 'scope') {
      return { ok: false, message: 'scope approval runs its gate in the terminal: swarm scope approve' };
    }
    const handbuildId = String(item.id ?? '');
    if (handbuildId.startsWith('handbuild-') || kind === 'handbuild') {
      const picked = choice ?? (decision === 'approve' ? 'approve' : 'deny');
      try {
        const hbRef = handbuildId.startsWith('handbuild-') ? handbuildId.slice('handbuild-'.length) : handbuildId;
        decideRequest(root, hbRef, picked, { now: nowFn, by: 'owner', channel: 'board' });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error.message ?? 'the action could not be applied').slice(0, 400) };
      }
    }
    if (kind === 'decision') {
      const picked = choice;
      try {
        await decide(root, item.id, picked, { ...inboxApplyDeps, now: nowFn, channel: 'board' });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error.message ?? 'the action could not be applied').slice(0, 400) };
      }
    }
    if (kind === 'proposed-ticket') {
      if (decision === 'approve') {
        return approveProposedTicketOnBoard(root, item.id, { now: nowFn });
      }
      try {
        await transition(root, item.id, 'cancelled', {
          by: 'owner',
          note: `denied on the board by ${identity}`,
          now: nowFn(),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error.message ?? 'the action could not be applied').slice(0, 400) };
      }
    }
    return { ok: false, message: 'the action could not be applied' };
  };
}

// watch-server handleOwner reads prepare POST JSON and passes choice into ownerActions.prepare.
function buildOwnerActions({ env, now, live, remoteLogin }) {
  const auditFile = ownerAuditPath(env);
  const appendAudit = async entry => {
    await fs.mkdir(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    await fs.appendFile(auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };
  const readAudit = async () => (await readOwnerAudit(env)).entries;
  const login = typeof remoteLogin === 'string' ? remoteLogin : '';
  const apply = boardOwnerApply(env, now);
  return createOwnerActions({
    listItems: async () => {
      const opts = boardProjectOpts(env);
      const projects = await listProjects({ file: projectsFile(env), forOwner: true, ...opts }).catch(() => []);
      const inbox = await boardInbox({ projects, env, forOwner: true, now: now() }).catch(() => null);
      return ownerItemsFromBoardInbox(inbox ?? { items: [] });
    },
    appendAudit,
    readAudit,
    guard: guardBoardAction,
    apply,
    now,
    randomId: () => randomBytes(16).toString('hex'),
    ownerIdentities: login ? [login] : [],
    verifyIdentity: (req, identity) => req.tailnetVerified === true && identity === login,
  });
}

export function createBoardApi({ env = process.env, now = Date.now, live = () => listLiveRuns(), runServer = makeRunServer, cacheMs = 1000, listPeers: listPeersFn = listPeers, peerCache = null, fetchImpl = fetch, versionInfo: versionInfoFn = versionInfo, boardPools: boardPoolsFn = boardPools, remote = null } = {}) {
  const watchers = new Map();                // `${projectId}/${runId}` -> { server, url, closed }
  const deployTracker = createDeployTracker({ env });
  const peersCache = peerCache ?? createPeerCache({
    fetchImpl: (request, init) => {
      const url = new URL(request instanceof URL ? request : request?.url ?? request);
      url.searchParams.set('local', '1');
      return fetchImpl(url, init);
    },
  });
  let boardUrl = null;
  const cachedBy = new Map();                // by whether test/temp projects and peers are shown
  const showsScratch = q => q?.scratch === '1' || q?.scratch === true;
  const shouldRedact = q => Boolean(q?.redact || q?.t || q?.get?.('t'));
  const scratchIds = async () => {
    const all = await listProjects({ file: projectsFile(env) });
    const flagged = await classifyProjects(all, { now: now(), liveRuns: await live(), env });
    return new Set(flagged.filter(project => project.testOrTemp || (isBoardTempRoot(project.root, boardProjectOpts(env)) && !project.live)).map(project => project.id));
  };
  const find = async id => (await listProjects({ file: projectsFile(env) })).find(p => p.id === id) ?? null;
  const api = {
    // One snapshot at a time: requests that arrive while one is being built share it.
    snapshot(q = {}) {
      const scratch = showsScratch(q);
      const localOnly = q?.local === '1' || q?.local === true;
      const cacheKey = `${scratch}|${localOnly}`;
      const cached = cachedBy.get(cacheKey);
      if (cached && now() - cached.at < cacheMs) return cached.promise;
      const promise = (async () => {
        let config = {}, max = null, invalid = false;
        try { config = loadLocalConfig({ env }) ?? {}; max = machineConcurrency(config); } catch { config = {}; invalid = true; /* the runs that read it refuse to start; the board says so */ }
        const all = await listProjects({ file: projectsFile(env) });
        const snapshotNow = now();
        const liveRuns = await live();
        const flagged = await classifyProjects(all, { now: snapshotNow, liveRuns, env });
        // Test and temp projects are left out of everything (lanes, totals, the inbox) unless asked for, so the numbers still add up.
        const projects = flagged.filter(p => !projectHiddenFromBoard(p, { scratch, env }));
        const caps = (() => { try { const lanes = resolveBudget({ config }).lanes ?? {}; return Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v?.dailyUsd])); } catch { return {}; } })();
        const configured = (() => { try { return Object.entries(config.lanes ?? {}).filter(([, v]) => typeof v?.model === 'string' && v.model).map(([k]) => k); } catch { return []; } })();
        const configuredModels = (() => { try { return Object.fromEntries(Object.entries(config.lanes ?? {}).filter(([, v]) => typeof v?.model === 'string' && v.model).map(([k, v]) => [k, v.model])); } catch { return {}; } })();
        const laneState = async () => {
          let store;
          try { store = JSON.parse(await fs.readFile(path.join(lanesDir(env), 'lanes.json'), 'utf8')); } catch { return { configured: configuredModels, caps }; }
          const demand = {};
          const at = now();
          for (const [agent, entry] of Object.entries(store?.demand ?? {})) {
            if (entry && Number.isInteger(entry.count) && entry.count > 0 && Number.isFinite(entry.at) && at - entry.at <= 5000) demand[agent] = (demand[agent] ?? 0) + entry.count;
          }
          return { configured: configuredModels, pauses: store?.pauses && typeof store.pauses === 'object' ? store.pauses : {}, demand, caps };
        };
        const workers = await workersHeld({ dir: lanesDir(env), max, invalid });
        const snapshot = await boardSnapshot({ projects, liveRuns, now: snapshotNow, env, laneState, workers, lanes: (laneToday, jobsToday) => laneUsage({ laneToday, jobsToday, configured, spendDirectory: spendDir(env), lanesDirectory: lanesDir(env), caps, now: snapshotNow }), deployStatus: root => isScratchRoot(root) ? null : deployTracker.get(root) });
        let peers = [];
        let remoteResults = [];
        if (!localOnly) {
          try { peers = await listPeersFn(env); } catch { peers = []; }
          try { remoteResults = await peersCache.all(peers); } catch { remoteResults = []; }
        }
        const filteredResults = (Array.isArray(remoteResults) ? remoteResults : []).map(remote => {
          const machine = remote?.machine ?? remote?.name;
          if (!remote || remote.ok !== true || !machine) return remote;
          return {
            ...remote,
            projects: (Array.isArray(remote.projects) ? remote.projects : []).filter(card => !card?.machine || card.machine === machine),
            orchestrators: (Array.isArray(remote.orchestrators) ? remote.orchestrators : []).filter(card => !card?.machine || card.machine === machine),
          };
        });
        const versionState = await versionInfoFn();
        const runningVersion = versionState?.runningVersion ?? versionState?.version ?? null;
        const installedVersion = await installedVersionFor(env, versionState);
        const localVersion = installedVersion ?? runningVersion;
        const merged = mergeMachines({ name: os.hostname(), version: localVersion, projects: snapshot.projects, orchestrators: snapshot.machine.orchestrator.sessions }, filteredResults);
        snapshot.projects = merged.projects;
        snapshot.machine.orchestrator.sessions = merged.orchestrators;
        snapshot.machine.version = localVersion;
        snapshot.machine.runningVersion = runningVersion;
        snapshot.machines = merged.machines;
        snapshot.drift = merged.drift;
        snapshot.peers = publicPeers(peers);
        try {
          const hosts = Array.isArray(config.hosts) ? config.hosts.filter(host => host && typeof host === 'object' && host.enabled !== false) : [];
          snapshot.pools = await boardPoolsFn({ now: snapshotNow, stubInput: { workers: snapshot.machine.workers, laneRows: snapshot.machine.lanes, hosts } });
        } catch {
          snapshot.pools = { source: 'stub', pools: [], at: new Date(snapshotNow).toISOString() };
        }
        // What waits for the owner (read-only); a failure here never hides the rest of the board.
        snapshot.inbox = await boardInbox({ projects, now: now(), env, forOwner: !scratch }).catch(error => ({ total: 0, items: [], problems: [{ project: '-', problem: String(error.message).slice(0, 120) }], phone: null }));
        const scratchProjects = flagged.filter(p => p.testOrTemp && !p.idleHidden);
        snapshot.scratch = { shown: scratch, hidden: scratch ? 0 : scratchProjects.length, total: scratchProjects.length };
        const idleHidden = flagged.filter(p => p.idleHidden).length;
        if (idleHidden) snapshot.scratch.idleHidden = idleHidden;
        // Direct internal snapshot callers still receive the full model; only the token-authenticated
        // board response is public and redacted. The HTTP board route always supplies its token.
        return shouldRedact(q) ? stripMoney(snapshot) : snapshot;
      })();
      cachedBy.set(cacheKey, { at: now(), promise });
      promise.catch(() => { if (cachedBy.get(cacheKey)?.promise === promise) cachedBy.delete(cacheKey); });
      return promise;
    },
    async project(id) {
      const project = await find(id);
      if (!project) return null;
      const familyRoots = await projectFamilyRoots(project.root, { env, extraRoots: (await listProjects({ file: projectsFile(env) })).map(item => item.root) });
      const liveRuns = (await live()).filter(r => familyRoots.includes(path.resolve(String(r.root ?? project.root))));
      let max = null;
      try { max = machineConcurrency(loadLocalConfig({ env })); } catch { /* invalid local config leaves split quality without a slot limit */ }
      return stripMoney(await projectDetail(project, { now: now(), liveRunIds: new Set(liveRuns.map(r => r.runId)), slots: max, env, extraRoots: (await listProjects({ file: projectsFile(env) })).map(item => item.root), deployStatus: root => isBoardTempRoot(root, boardProjectOpts(env)) ? null : deployTracker.get(root) }));
    },
    // Every run alive in one project, combined (the Live tab of the project page).
    async live(id) {
      const project = await find(id);
      if (!project) return null;
      const allProjects = await listProjects({ file: projectsFile(env) });
      const familyRoots = await projectFamilyRoots(project.root, { env, extraRoots: allProjects.map(item => item.root) });
      const liveRuns = (await live()).filter(r => familyRoots.includes(path.resolve(String(r.root ?? project.root))));
      return stripMoney(await liveOverview(project, liveRuns, { now: now(), env, familyRoots, extraRoots: allProjects.map(item => item.root) }));
    },
    // One run's jobs, graph and journal; with `compare`, that run beside another run of the same project.
    async run(id, runId, compare = null) {
      const project = await find(id);
      if (!project) return null;
      const a = await runDetail(project, runId);
      if (!a) return null;
      if (!compare) return stripMoney(a);
      const b = await runDetail(project, compare);
      return b ? stripMoney({ run: a, compare: compareRuns(a, b) }) : null;
    },
    async history(q = {}) {
      const exclude = showsScratch(q) ? undefined : await scratchIds();
      const page = await boardHistoryQuery(q, env, showsScratch(q), exclude);
      if (page && Array.isArray(page.events)) page.events = await enrichRunEvents(page.events, await listProjects({ file: projectsFile(env) }).catch(() => []));
      return stripMoney(page);
    },
    async historyCsv(q = {}) {
      const exclude = showsScratch(q) ? undefined : await scratchIds();
      const page = await boardHistoryQuery({ ...q, limit: 1e6, offset: 0 }, env, showsScratch(q), exclude);
      return publicHistoryCsv(page.events);
    },
    // Starts the run's own Watch server (or reuses the one already up) and returns its address, with that server's token. Null for anything not a run of a listed project.
    async openRun(id, runId) {
      const project = await find(id);
      if (!project || !RUN_ID_RE.test(String(runId))) return null;
      if (!(await findRunId(project.root, runId))) return null;
      const key = `${project.id}/${runId}`;
      const hit = watchers.get(key);
      if (hit && !hit.closed) return hit.pending;
      // The promise is stored before the server starts, so two clicks at once share one server; at most MAX_WATCHERS stay open (the oldest is closed).
      const entry = { closed: false, server: null, pending: null };
      entry.pending = (async () => {
        const open = [...watchers.entries()].filter(([, w]) => !w.closed);
        while (open.length >= MAX_WATCHERS) { const [oldKey, old] = open.shift(); old.closed = true; watchers.delete(oldKey); await old.server?.close().catch(() => {}); }
        entry.server = runServer(project.root, runId, { idleMs: BOARD_RUN_IDLE_MS, nav: { project: { id: project.id, name: project.name }, runId, openBoard: async pid => (boardUrl ? (pid ? boardProjectUrl(boardUrl, pid) : boardUrl) : null) } });
        const { url } = await entry.server.listen();
        entry.server.done.then(() => { entry.closed = true; });
        return url;
      })();
      watchers.set(key, entry);
      entry.pending.catch(() => { entry.closed = true; watchers.delete(key); });
      return entry.pending;
    },
    // The board tells the api its own address once it is listening: the run pages it opens link back to it.
    setBoardUrl(url) { boardUrl = url; },
    watcherCount: () => [...watchers.values()].filter(w => !w.closed).length,
    async close() { for (const w of watchers.values()) if (!w.closed) await w.server?.close().catch(() => {}); watchers.clear(); },
  };
  if (remote) api.ownerActions = buildOwnerActions({ env, now, live, remoteLogin: remote.login });
  return api;
}

// Starts the board server in this process and records its address for run pages that want to go back to it.
// `remote` ({ port, token, hosts, login }): the board `swarm remote` keeps up behind tailscale serve. It is not the board run pages go back to, so it records no address,
// and it does not stop when idle.
export async function startBoardServer({ env = process.env, root, remote, registry = null, now = Date.now } = {}) {
  const api = createBoardApi({ env, remote, now });
  backfillHistory({ env }).catch(() => {});
  const server = createWatchServer({
    root,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: () => safeBoard(),
    board: api,
    indexName: 'board.html',
    commandList: buildCommandList(COMMANDS),
    contextCommands,
    assetDir: path.join(here, 'watch-assets'),
    deltaFile: path.join(here, 'watch-delta.mjs'),
    ...(remote ? {
      port: remote.port,
      token: remote.token,
      remote: { hosts: remote.hosts, login: remote.login },
      idleMs: Infinity,
      ownerActions: api.ownerActions,
    } : {}),
  });
  const { url, port } = await server.listen();
  api.setBoardUrl(remote ? null : url);
  const version = await readPackageVersion();
  const boardMode = remote ? 'background' : serverMode({ explicitBackground: registry?.explicitBackground === true });
  const baseRegistry = {
    version,
    argv: remote ? argvForRemoteServe(remote, registry ?? {}) : ['watch', '--all'],
    cwd: process.cwd(),
    port,
    env: safeEnvSubset(env),
    ...registryModeFields(boardMode, { explicitBackground: remote || registry?.explicitBackground === true }),
    ...(registry && typeof registry === 'object' ? registry : {}),
  };
  if (!remote) {
    try {
      await writeBoardFile(url, { env, registry: baseRegistry });
    } catch (error) {
      process.stderr.write(`board server record write failed: ${error.message}\n`);
    }
  } else {
    const { writeRegistryRecord, remoteServerFile } = await import('./server-restart.mjs');
    try {
      await writeRegistryRecord(remoteServerFile(env), { pid: process.pid, url, startedAt: new Date().toISOString(), ...baseRegistry });
    } catch (error) {
      process.stderr.write(`remote server record write failed: ${error.message}\n`);
    }
  }
  const cleaned = server.done.then(async () => {
    try {
      // The run pages this board opened must not point back at a board that is gone, and they close with it.
      api.setBoardUrl(null);
      await api.close().catch(() => {});
      if (!remote) {
        try {
          const data = JSON.parse(await fs.readFile(boardFile(env), 'utf8'));
          if (data.pid === process.pid && data.url === url) await fs.rm(boardFile(env), { force: true });
        } catch { /* already gone */ }
      } else {
        try {
          const { remoteServerFile } = await import('./server-restart.mjs');
          const file = remoteServerFile(env);
          const data = JSON.parse(await fs.readFile(file, 'utf8'));
          if (data.pid === process.pid && data.url === url) await fs.rm(file, { force: true });
        } catch { /* already gone */ }
      }
    } catch { /* cleaned must never reject */ }
  }).catch(() => {});
  return { server, api, url, cleaned };
}

export async function runWatchCommand(root, args, { write = text => process.stdout.write(text) } = {}) {
  const opts = parseWatchArgs(args);
  if (opts.error) return { stdout: `${opts.error}\n${WATCH_USAGE}`, exitCode: 2 };
  if (opts.all && opts.json) return { stdout: `${JSON.stringify(await safeBoard(), null, 2)}\n`, exitCode: 0 };
  if (opts.all && (opts.text || opts.tui)) return { stdout: await boardText(), exitCode: 0 };
  if (opts.all) {
    // The web board: a lane per project on this machine, the machine's agents and spend on top, the history, and a click-through to any run's own page.
    const watchArgv = ['watch', '--all', ...(opts.open ? ['--open'] : []), ...(opts.tui ? ['--tui'] : []), ...(opts.text ? ['--text'] : [])];
    const board = await startBoardServer({
      env: process.env,
      root,
      registry: {
        argv: watchArgv,
        cwd: process.cwd(),
        env: safeEnvSubset(process.env),
        explicitBackground: true,
        ...registryModeFields(serverMode({ explicitBackground: true }), { explicitBackground: true }),
      },
    });
    write(`Swarm Watch board (every project on this machine)\n${board.url}\nRead-only, on this machine only. Opening a run starts that run's own page. Stops after 30 minutes idle. Ctrl-C stops it now. (swarm watch --all --text prints the live runs instead.)\n`);
    if (opts.open) openUrl(board.url);
    const stop = () => { board.server.close(); board.api.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await board.server.done;
    await board.api.close();
    return { stdout: '', exitCode: 0 };
  }
  const runId = await findRunId(root, opts.run);
  if (!runId) return { stdout: opts.run ? `No run ${opts.run} in this project.\n` : 'No runs in this project yet. Start one with swarm run or swarm go.\n', exitCode: 1 };
  if (opts.json) {
    return { stdout: `${JSON.stringify({ run: await runSnapshotLoader(root, runId)(), plan: await planLoader(root)() }, null, 2)}\n`, exitCode: 0 };
  }
  if (opts.tui) { await tuiLoop(root, runId, write); return { stdout: '', exitCode: 0 }; }
  const realRoot = await fs.realpath(root).catch(() => root);
  const server = makeRunServer(realRoot, runId, { nav: runNav({ root: realRoot, runId, env: process.env }) });
  const { url } = await server.listen();
  write(`Swarm Watch for run ${runId}\n${url}\nRead-only, on this machine only. Stops after 30 minutes idle, or when the run is done and the page is closed. Ctrl-C stops it now.\n`);
  if (opts.open) openUrl(url);
  let signalled = false;
  const stop = () => { signalled = true; server.close(); closeOwnedBoard(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await server.done;
  // A board started from this run's page lives as long as this process (the person may still be on it), unless the person stopped it with Ctrl-C.
  if (!signalled) await ownedBoardDone();
  return { stdout: '', exitCode: 0 };
}

export async function runGalleryCommand(root, args) {
  const addTicket = async partial => (await import('./scope-commands.mjs')).addProposedTicket(root, partial);
  const [verb, ...rest] = args;
  if (!verb || verb === 'list') {
    const { screens } = await readGallery(root);
    if (!screens.length) return { stdout: 'No screens yet. Run swarm ui check first.\n', exitCode: 0 };
    return { stdout: screens.map(s => `${s.id}  ${s.verdict ?? '-'}  score ${s.score ?? '-'}  approval ${s.approval}  comments ${s.comments.length}`).join('\n') + '\n', exitCode: 0 };
  }
  try {
    if (verb === 'approve') {
      if (!rest.length) return { stdout: `Name at least one screen id.\n${WATCH_USAGE}`, exitCode: 2 };
      await approveScreens(root, rest, { by: 'owner' });
      return { stdout: `Approved: ${rest.join(', ')}\n`, exitCode: 0 };
    }
    if (verb === 'comment') {
      if (rest.length !== 2) return { stdout: `Usage: swarm gallery comment ID "text"\n`, exitCode: 2 };
      await addComment(root, rest[0], rest[1]);
      const made = await ticketComments(root, { addTicket, screens: [rest[0]] }).catch(error => ({ made: [], error: error.message }));
      const note = made.made?.length ? ` It became proposed ticket ${made.made.map(m => m.ticket).join(', ')}: nothing runs it until you approve it (swarm tickets ${made.made[0].ticket} --files ..., then --approve --yes).` : made.noLedger ? ' (No ticket ledger yet, so no fix ticket was proposed.)' : made.error ? ` (No ticket was proposed: ${made.error})` : '';
      return { stdout: `Comment saved on ${rest[0]}.${note}\n`, exitCode: 0 };
    }
    if (verb === 'tickets') {
      const { made, noLedger } = await ticketComments(root, { addTicket, screens: rest.length ? rest : null });
      if (noLedger) return { stdout: 'No ticket ledger yet (swarm scope split), so no fix tickets can be proposed.\n', exitCode: 1 };
      return { stdout: made.length ? `Proposed ${made.length} ticket(s): ${made.map(m => `${m.ticket} (${m.screen})`).join(', ')}. Read them, name their files, then swarm tickets ID --approve --yes. No worker runs a proposed ticket.\n` : 'Every comment already has a ticket.\n', exitCode: 0 };
    }
  } catch (error) {
    return { stdout: `${error.message}\n`, exitCode: 1 };
  }
  return { stdout: `Unknown gallery command: ${verb}\n${WATCH_USAGE}`, exitCode: 2 };
}
