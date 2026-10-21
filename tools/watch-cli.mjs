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
import { readLedger } from './tickets.mjs';
import { boardSummary, listLiveRuns } from './board.mjs';
import { listProjects, projectsFile, projectId, isScratchRoot } from './projects.mjs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { readHistory, historyCsv, historyFile } from './history.mjs';
import { boardInbox, inboxText } from './board-inbox.mjs';
import { runDetail, compareRuns } from './board-run.mjs';
import { boardSnapshot, projectDetail, workersHeld, laneUsage, enrichRunEvents } from './board-data.mjs';
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
    snapshot.project = await projectSummary(root).catch(() => null);
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

async function boardText({ env = process.env } = {}) {
  const { runs } = await safeBoard();
  const projects = await listProjects({ file: projectsFile(env) }).catch(() => []);
  const needs = inboxText(await boardInbox({ projects, env }).catch(() => null));
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

export async function writeBoardFile(url, { env = process.env } = {}) {
  const file = boardFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ pid: process.pid, url, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
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

export function createBoardApi({ env = process.env, now = Date.now, live = () => listLiveRuns(), runServer = makeRunServer, cacheMs = 1000 } = {}) {
  const watchers = new Map();                // `${projectId}/${runId}` -> { server, url, closed }
  const deployTracker = createDeployTracker({ env });
  let boardUrl = null;
  const cachedBy = new Map();                // by whether test/temp projects are shown
  const showsScratch = q => q?.scratch === '1' || q?.scratch === true;
  const scratchIds = async () => new Set((await listProjects({ file: projectsFile(env) })).filter(p => isScratchRoot(p.root)).map(p => p.id));
  const find = async id => (await listProjects({ file: projectsFile(env) })).find(p => p.id === id) ?? null;
  const api = {
    // One snapshot at a time: requests that arrive while one is being built share it.
    snapshot(q = {}) {
      const scratch = showsScratch(q);
      const cached = cachedBy.get(scratch);
      if (cached && now() - cached.at < cacheMs) return cached.promise;
      const promise = (async () => {
        let max = null, invalid = false;
        try { max = machineConcurrency(loadLocalConfig({ env })); } catch { invalid = true; /* the runs that read it refuse to start; the board says so */ }
        const all = await listProjects({ file: projectsFile(env) });
        // Test and temp projects are left out of everything (lanes, totals, the inbox) unless asked for, so the numbers still add up.
        const projects = scratch ? all : all.filter(p => !isScratchRoot(p.root));
        const caps = (() => { try { const lanes = resolveBudget({ config: loadLocalConfig({ env }) }).lanes ?? {}; return Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v?.dailyUsd])); } catch { return {}; } })();
        const configured = (() => { try { return Object.entries(loadLocalConfig({ env }).lanes ?? {}).filter(([, v]) => typeof v?.model === 'string' && v.model).map(([k]) => k); } catch { return []; } })();
        const configuredModels = (() => { try { return Object.fromEntries(Object.entries(loadLocalConfig({ env }).lanes ?? {}).filter(([, v]) => typeof v?.model === 'string' && v.model).map(([k, v]) => [k, v.model])); } catch { return {}; } })();
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
        const snapshot = await boardSnapshot({ projects, liveRuns: await live(), now: now(), laneState, workers: await workersHeld({ dir: lanesDir(env), max, invalid }), lanes: (laneToday, jobsToday) => laneUsage({ laneToday, jobsToday, configured, spendDirectory: spendDir(env), lanesDirectory: lanesDir(env), caps, now: now() }), deployStatus: root => isScratchRoot(root) ? null : deployTracker.get(root) });
        // What waits for the owner (read-only); a failure here never hides the rest of the board.
        snapshot.inbox = await boardInbox({ projects, now: now(), env }).catch(error => ({ total: 0, items: [], problems: [{ project: '-', problem: String(error.message).slice(0, 120) }], phone: null }));
        snapshot.scratch = { shown: scratch, hidden: scratch ? 0 : all.length - projects.length, total: all.filter(p => isScratchRoot(p.root)).length };
        return snapshot;
      })();
      cachedBy.set(scratch, { at: now(), promise });
      promise.catch(() => { if (cachedBy.get(scratch)?.promise === promise) cachedBy.delete(scratch); });
      return promise;
    },
    async project(id) {
      const project = await find(id);
      if (!project) return null;
      const liveRuns = (await live()).filter(r => r.root === project.root);
      return projectDetail(project, { now: now(), liveRunIds: new Set(liveRuns.map(r => r.runId)), deployStatus: root => isScratchRoot(root) ? null : deployTracker.get(root) });
    },
    // Every run alive in one project, combined (the Live tab of the project page).
    async live(id) {
      const project = await find(id);
      if (!project) return null;
      const liveRuns = (await live()).filter(r => r.root === project.root);
      return liveOverview(project, liveRuns, { now: now() });
    },
    // One run's jobs, graph and journal; with `compare`, that run beside another run of the same project.
    async run(id, runId, compare = null) {
      const project = await find(id);
      if (!project) return null;
      const a = await runDetail(project, runId);
      if (!a) return null;
      if (!compare) return a;
      const b = await runDetail(project, compare);
      return b ? { run: a, compare: compareRuns(a, b) } : null;
    },
    async history(q = {}) {
      const page = await readHistory({ file: historyFile(env), project: q.project || undefined, kind: q.kind || undefined, q: q.q || undefined, from: q.from || undefined, to: q.to || undefined, limit: Number(q.limit) || 100, offset: Number(q.offset) || 0, fold: true, exclude: showsScratch(q) ? undefined : await scratchIds() });
      if (page && Array.isArray(page.events)) page.events = await enrichRunEvents(page.events, await listProjects({ file: projectsFile(env) }).catch(() => []));
      return page;
    },
    async historyCsv(q = {}) {
      const { events } = await readHistory({ file: historyFile(env), project: q.project || undefined, kind: q.kind || undefined, q: q.q || undefined, from: q.from || undefined, to: q.to || undefined, limit: 1e6, cap: 1e6, exclude: showsScratch(q) ? undefined : await scratchIds() });
      return historyCsv(events);
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
  return api;
}

// Starts the board server in this process and records its address for run pages that want to go back to it.
// `remote` ({ port, token, hosts, login }): the board `swarm remote` keeps up behind tailscale serve. It is not the board run pages go back to, so it records no address,
// and it does not stop when idle.
export async function startBoardServer({ env = process.env, root, remote }) {
  const api = createBoardApi({ env });
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
    ...(remote ? { port: remote.port, token: remote.token, remote: { hosts: remote.hosts, login: remote.login }, idleMs: Infinity } : {}),
  });
  const { url } = await server.listen();
  api.setBoardUrl(remote ? null : url);
  if (!remote) await writeBoardFile(url, { env }).catch(() => {});
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
    const board = await startBoardServer({ env: process.env, root });
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
