// SPDX-License-Identifier: Apache-2.0
// `swarm watch` and `swarm gallery`: command glue for the read-only dashboard. The pieces
// (state, plan, delta, server, tui, gallery) are separate modules; this only wires them.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRunSnapshot } from './watch-state.mjs';
import { buildPlanSnapshot } from './watch-plan.mjs';
import { createWatchServer } from './watch-server.mjs';
import { renderTui } from './watch-tui.mjs';
import { readGallery, approveScreens, addComment } from './watch-gallery.mjs';
import { buildCommandList, contextCommands } from './watch-command-meta.mjs';
import { COMMANDS } from './completion.mjs';
import { readLedger } from './tickets.mjs';
import { boardSummary } from './board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LIVE = new Set(['running', 'queued']);

export const WATCH_USAGE = 'Usage: swarm watch [RUN] [--all] [--tui] [--open] [--json]\n       swarm gallery list | approve ID... | comment ID "text"\n';

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

export function runSnapshotLoader(root, runId) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  return async () => {
    const state = await readJson(path.join(dir, 'state.json'));
    if (!state) return null;
    const manifest = await readJson(path.join(dir, 'manifest.json'));
    return buildRunSnapshot(state, { manifest, now: Date.now() });
  };
}

const planLoader = root => async () => buildPlanSnapshot(await readLedger(root).catch(() => null));

function parseWatchArgs(args) {
  const opts = { all: false, tui: false, open: false, json: false, run: null };
  for (const arg of args) {
    if (arg === '--all') opts.all = true;
    else if (arg === '--tui') opts.tui = true;
    else if (arg === '--open') opts.open = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--')) return { error: `Unknown flag: ${arg}` };
    else if (opts.run === null && RUN_ID_RE.test(arg)) opts.run = arg;
    else return { error: `Invalid argument: ${arg}` };
  }
  return opts;
}

function openUrl(url) {
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(bin, argv, () => {});
}

async function boardText() {
  const { runs } = await boardSummary();
  if (!runs.length) return 'No live runs on this machine.\n';
  return runs.map(run => {
    const done = run.jobs.filter(job => job.status === 'complete').length;
    return `${run.runId}  ${run.status}  ${done}/${run.jobs.length} jobs  ${run.root}\n  watch: swarm --root ${run.root} watch ${run.runId}`;
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

export async function runWatchCommand(root, args, { write = text => process.stdout.write(text) } = {}) {
  const opts = parseWatchArgs(args);
  if (opts.error) return { stdout: `${opts.error}\n${WATCH_USAGE}`, exitCode: 2 };
  if (opts.all) return { stdout: await boardText(), exitCode: 0 };
  const runId = await findRunId(root, opts.run);
  if (!runId) return { stdout: opts.run ? `No run ${opts.run} in this project.\n` : 'No runs in this project yet. Start one with swarm run or swarm go.\n', exitCode: 1 };
  if (opts.json) {
    return { stdout: `${JSON.stringify({ run: await runSnapshotLoader(root, runId)(), plan: await planLoader(root)() }, null, 2)}\n`, exitCode: 0 };
  }
  if (opts.tui) { await tuiLoop(root, runId, write); return { stdout: '', exitCode: 0 }; }
  const commandList = buildCommandList(COMMANDS);
  const server = createWatchServer({
    root,
    getRunSnapshot: runSnapshotLoader(root, runId),
    getPlanSnapshot: planLoader(root),
    getGallery: () => readGallery(root),
    commandList,
    contextCommands,
    assetDir: path.join(here, 'watch-assets'),
    deltaFile: path.join(here, 'watch-delta.mjs'),
  });
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
      return { stdout: `Comment saved on ${rest[0]}.\n`, exitCode: 0 };
    }
  } catch (error) {
    return { stdout: `${error.message}\n`, exitCode: 1 };
  }
  return { stdout: `Unknown gallery command: ${verb}\n${WATCH_USAGE}`, exitCode: 2 };
}
