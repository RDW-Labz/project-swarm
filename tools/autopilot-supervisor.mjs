// SPDX-License-Identifier: Apache-2.0
// Supervises one autopilot loop per eligible registered project while the Swarm Watch board runs.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listProjects, projectsFile, isScratchRoot } from './projects.mjs';
import { readLedger, isApproved } from './tickets.mjs';
import { acquireAutopilotLock } from './autopilot-lock.mjs';
import {
  runAutopilot,
  MIN_INTERVAL_MS,
  computeIdleWithReady,
  countReadyTickets,
  autopilotOffPath,
  isAutopilotOff,
  setAutopilotOff,
  autopilotStatusForRoot,
} from './autopilot.mjs';
import {
  startBoardServer,
  safeEnvSubset,
  serverMode,
  registryModeFields,
  WATCH_USAGE,
} from './watch-cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export {
  autopilotOffPath,
  isAutopilotOff,
  setAutopilotOff,
  autopilotStatusForRoot,
  computeIdleWithReady,
  countReadyTickets,
} from './autopilot.mjs';

export async function shouldSuperviseProject(project, {
  env = process.env,
  readLedgerFn = readLedger,
  isScratchRootFn = isScratchRoot,
  isOffFn = isAutopilotOff,
  registeredRoots = [],
} = {}) {
  if (!project || typeof project.root !== 'string') return false;
  if (isScratchRootFn(project.root, { env, registeredRoots, strict: true })) return false;
  if (await isOffFn(project.root)) return false;
  const ledger = await readLedgerFn(project.root).catch(() => null);
  if (!ledger || !isApproved(ledger)) return false;
  const tickets = Array.isArray(ledger.tickets) ? ledger.tickets : [];
  if (!tickets.length) return false;
  return true;
}

async function defaultSleep(ms, signal) {
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    }, { once: true });
  });
}

export async function superviseProjectLoop(root, deps, { signal } = {}) {
  const sleep = deps.sleep ?? defaultSleep;
  const backoffMs = deps.lockBackoffMs ?? MIN_INTERVAL_MS;
  const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? 30_000);
  const acquire = deps.acquireAutopilotLock ?? acquireAutopilotLock;
  const run = deps.runAutopilot ?? runAutopilot;
  const autopilotDeps = deps.autopilotDeps;
  if (typeof autopilotDeps !== 'function') throw new Error('autopilotDeps required');

  while (!signal?.aborted) {
    let release = null;
    try {
      release = await acquire(root, deps.lockOptions);
    } catch (error) {
      if (error?.code === 'autopilot-running') {
        try { await sleep(backoffMs, signal); } catch { break; }
        continue;
      }
      throw error;
    }
    try {
      await run(root, autopilotDeps(root), {
        once: true,
        signal,
        sleep,
        intervalMs,
        now: deps.now,
        legacyPlan: deps.legacyPlan,
      });
    } finally {
      if (release) await release().catch(() => {});
    }
    if (signal?.aborted) break;
    try { await sleep(intervalMs, signal); } catch { break; }
  }
}

export function createAutopilotSupervisor({
  env = process.env,
  listProjectsFn = () => listProjects({ file: projectsFile(env) }),
  shouldSupervise = shouldSuperviseProject,
  superviseLoop = superviseProjectLoop,
  ...loopDeps
} = {}) {
  const loops = new Map();
  let reconcilePromise = null;

  async function reconcile() {
    const projects = await listProjectsFn();
    const roots = projects.map(p => p.root);
    const eligible = [];
    for (const project of projects) {
      if (await shouldSupervise(project, { env, registeredRoots: roots, ...loopDeps })) eligible.push(project);
    }
    const eligibleSet = new Set(eligible.map(p => p.root));
    for (const [root, handle] of loops) {
      if (!eligibleSet.has(root)) {
        handle.controller.abort();
        loops.delete(root);
      }
    }
    for (const project of eligible) {
      if (loops.has(project.root)) continue;
      const controller = new AbortController();
      const promise = superviseLoop(project.root, { env, ...loopDeps }, { signal: controller.signal })
        .catch(() => {})
        .finally(() => {
          if (loops.get(project.root)?.controller === controller) loops.delete(project.root);
        });
      loops.set(project.root, { controller, promise });
    }
    return { eligible: eligible.map(p => p.root), running: [...loops.keys()] };
  }

  return {
    loops: () => new Map(loops),
    async reconcile() {
      reconcilePromise = reconcile();
      return reconcilePromise;
    },
    async start() {
      await reconcile();
      return {
        stop: async () => {
          for (const handle of loops.values()) handle.controller.abort();
          loops.clear();
        },
      };
    },
    async stop() {
      for (const handle of loops.values()) handle.controller.abort();
      loops.clear();
    },
  };
}

export function attachSupervisorToBoard(board, options = {}) {
  const supervisor = createAutopilotSupervisor(options);
  let stopHandle = null;
  const started = supervisor.start().then(handle => { stopHandle = handle; });
  const origClose = board.api.close.bind(board.api);
  board.api.close = async () => {
    await started;
    if (stopHandle) await stopHandle.stop();
    else await supervisor.stop();
    return origClose();
  };
  return { supervisor, board };
}

function openUrl(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  const child = spawn(cmd, platform === 'win32' ? ['', url] : [url], { detached: true, stdio: 'ignore', shell: platform === 'win32' });
  child.unref?.();
}

function parseWatchArgs(args) {
  const opts = { all: false, tui: false, open: false, json: false, text: false, run: null, error: null };
  const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
  for (const arg of args) {
    if (arg === '--all') opts.all = true;
    else if (arg === '--tui') opts.tui = true;
    else if (arg === '--open') opts.open = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--text') opts.text = true;
    else if (arg.startsWith('--')) opts.error = `Unknown flag: ${arg}`;
    else if (opts.run === null && RUN_ID_RE.test(arg)) opts.run = arg;
    else opts.error = `Invalid argument: ${arg}`;
  }
  return opts;
}

/** Interactive `swarm watch --all` with autopilot supervision (watch-cli has no hook). */
export async function runBoardWatchAll(root, args, { env = process.env, write = text => process.stdout.write(text), supervisorOptions = {} } = {}) {
  const opts = parseWatchArgs(args);
  if (opts.error) return { stdout: `${opts.error}\n${WATCH_USAGE}`, exitCode: 2 };
  if (!opts.all) return { stdout: `${WATCH_USAGE}`, exitCode: 2 };
  const watchArgv = ['watch', '--all', ...(opts.open ? ['--open'] : []), ...(opts.tui ? ['--tui'] : []), ...(opts.text ? ['--text'] : [])];
  const board = await startBoardServer({
    env,
    root,
    registry: {
      argv: watchArgv,
      cwd: process.cwd(),
      env: safeEnvSubset(env),
      explicitBackground: true,
      ...registryModeFields(serverMode({ explicitBackground: true }), { explicitBackground: true }),
    },
  });
  attachSupervisorToBoard(board, { env, ...supervisorOptions });
  write(`Swarm Watch board (every project on this machine)\n${board.url}\nRead-only, on this machine only. Opening a run starts that run's own page. Stops after 30 minutes idle. Ctrl-C stops it now. (swarm watch --all --text prints the live runs instead.)\n`);
  if (opts.open) openUrl(board.url);
  const stop = () => { board.server.close(); board.api.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await board.server.done;
  await board.api.close();
  return { stdout: '', exitCode: 0 };
}

export async function runAutopilotPrefCommand(root, args) {
  const verb = args[0];
  if (verb === 'off') {
    await setAutopilotOff(root, true);
    return { stdout: 'autopilot: off\n', exitCode: 0 };
  }
  if (verb === 'on') {
    await setAutopilotOff(root, false);
    return { stdout: 'autopilot: on\n', exitCode: 0 };
  }
  if (verb === 'status') {
    const state = await autopilotStatusForRoot(root);
    return { stdout: `autopilot: ${state}\n`, exitCode: 0 };
  }
  return { stdout: 'Usage: swarm autopilot off|on|status [--root]\n', exitCode: 2 };
}
