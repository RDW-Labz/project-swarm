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
import { createWatchServer } from './watch-server.mjs';
import { renderTui } from './watch-tui.mjs';
import { readGallery, approveScreens, addComment } from './watch-gallery.mjs';
import { ticketComments } from './gallery-tickets.mjs';
import { buildCommandList, contextCommands } from './watch-command-meta.mjs';
import { COMMANDS } from './completion.mjs';
import { readLedger } from './tickets.mjs';
import { boardSummary, listLiveRuns } from './board.mjs';
import { listProjects, projectsFile } from './projects.mjs';
import { readHistory, historyCsv, historyFile } from './history.mjs';
import { boardSnapshot, projectDetail } from './board-data.mjs';
import { backfillHistory } from './board-commands.mjs';
import { projectSummary } from './project-spend.mjs';

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

async function boardText() {
  const { runs } = await safeBoard();
  if (!runs.length) return 'No live runs on this machine.\n';
  return runs.map(run => {
    const done = run.jobs.filter(job => job.status === 'complete').length;
    return `${run.runId}  ${run.status}  ${done}/${run.jobs.length} jobs  ${run.root}\n  watch: swarm --root ${shellQuote(run.root)} watch ${shellQuote(run.runId)}`;
  }).join('\n') + '\n';
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
const MAX_WATCHERS = 6;
const BOARD_RUN_IDLE_MS = 10 * 60 * 1000;

export function createBoardApi({ env = process.env, now = Date.now, live = () => listLiveRuns(), runServer = makeRunServer, cacheMs = 1000 } = {}) {
  const watchers = new Map();                // `${projectId}/${runId}` -> { server, url, closed }
  let cached = null;
  const find = async id => (await listProjects({ file: projectsFile(env) })).find(p => p.id === id) ?? null;
  const api = {
    // One snapshot at a time: requests that arrive while one is being built share it.
    snapshot() {
      if (cached && now() - cached.at < cacheMs) return cached.promise;
      const promise = (async () => boardSnapshot({ projects: await listProjects({ file: projectsFile(env) }), liveRuns: await live(), now: now() }))();
      cached = { at: now(), promise };
      promise.catch(() => { if (cached?.promise === promise) cached = null; });
      return promise;
    },
    async project(id) {
      const project = await find(id);
      if (!project) return null;
      const liveRuns = (await live()).filter(r => r.root === project.root);
      return projectDetail(project, { now: now(), liveRunIds: new Set(liveRuns.map(r => r.runId)) });
    },
    async history(q = {}) {
      return readHistory({ file: historyFile(env), project: q.project || undefined, kind: q.kind || undefined, q: q.q || undefined, from: q.from || undefined, to: q.to || undefined, limit: Number(q.limit) || 100, offset: Number(q.offset) || 0 });
    },
    async historyCsv(q = {}) {
      const { events } = await readHistory({ file: historyFile(env), project: q.project || undefined, kind: q.kind || undefined, q: q.q || undefined, from: q.from || undefined, to: q.to || undefined, limit: 1e6, cap: 1e6 });
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
        entry.server = runServer(project.root, runId, { idleMs: BOARD_RUN_IDLE_MS });
        const { url } = await entry.server.listen();
        entry.server.done.then(() => { entry.closed = true; });
        return url;
      })();
      watchers.set(key, entry);
      entry.pending.catch(() => { entry.closed = true; watchers.delete(key); });
      return entry.pending;
    },
    watcherCount: () => [...watchers.values()].filter(w => !w.closed).length,
    async close() { for (const w of watchers.values()) if (!w.closed) await w.server?.close().catch(() => {}); watchers.clear(); },
  };
  return api;
}

export async function runWatchCommand(root, args, { write = text => process.stdout.write(text) } = {}) {
  const opts = parseWatchArgs(args);
  if (opts.error) return { stdout: `${opts.error}\n${WATCH_USAGE}`, exitCode: 2 };
  if (opts.all && opts.json) return { stdout: `${JSON.stringify(await safeBoard(), null, 2)}\n`, exitCode: 0 };
  if (opts.all && (opts.text || opts.tui)) return { stdout: await boardText(), exitCode: 0 };
  if (opts.all) {
    // The web board: a lane per project on this machine, the machine's agents and spend on top, the history, and a click-through to any run's own page.
    const api = createBoardApi({ env: process.env });
    backfillHistory({ env: process.env }).catch(() => {});
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
    });
    const { url } = await server.listen();
    write(`Swarm Watch board (every project on this machine)\n${url}\nRead-only, on this machine only. Opening a run starts that run's own page. Stops after 30 minutes idle. Ctrl-C stops it now. (swarm watch --all --text prints the live runs instead.)\n`);
    if (opts.open) openUrl(url);
    const stop = () => { server.close(); api.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await server.done;
    await api.close();
    return { stdout: '', exitCode: 0 };
  }
  const runId = await findRunId(root, opts.run);
  if (!runId) return { stdout: opts.run ? `No run ${opts.run} in this project.\n` : 'No runs in this project yet. Start one with swarm run or swarm go.\n', exitCode: 1 };
  if (opts.json) {
    return { stdout: `${JSON.stringify({ run: await runSnapshotLoader(root, runId)(), plan: await planLoader(root)() }, null, 2)}\n`, exitCode: 0 };
  }
  if (opts.tui) { await tuiLoop(root, runId, write); return { stdout: '', exitCode: 0 }; }
  const server = makeRunServer(root, runId);
  const { url } = await server.listen();
  write(`Swarm Watch for run ${runId}\n${url}\nRead-only, on this machine only. Stops after 30 minutes idle, or when the run is done and the page is closed. Ctrl-C stops it now.\n`);
  if (opts.open) openUrl(url);
  const stop = () => { server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await server.done;
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
