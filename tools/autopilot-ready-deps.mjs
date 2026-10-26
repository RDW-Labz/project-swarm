// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMachine } from './autotune.mjs';
import { listRequests } from './handbuild.mjs';
import { loadLocalConfig, resolveAutopilotStartReady } from './local-config.mjs';
import {
  effectiveMachineLimit,
  memoryPressureHoldLine,
  memoryPressureLevel,
} from './machine-limit.mjs';
import { addGoal } from './backlog.mjs';
import { markDone } from './inbox.mjs';
import { inboxDeps } from './inbox-commands.mjs';
import {
  integrateBlockerRunIdFromId,
} from './journal.mjs';
import {
  integrationBlocker,
  integrableFromJobs,
  runIntegrateOutputPaths,
} from './autopilot.mjs';
import { integrateCheckoutGitState } from './generated-state.mjs';
import { buildHandlersMap } from './needs-you-triage.mjs';
import { assertRegularOrMissing, safeWritableDir } from './journal.mjs';

async function defaultGitExec(root, cmd, args, opts) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8', ...opts });
  return { stdout };
}

async function resolveIntegrateCheckoutView(root, checkout, outputPaths, deps) {
  if (typeof deps.integrateCheckoutGitState === 'function') {
    try {
      const gitState = await deps.integrateCheckoutGitState(root, { outputPaths });
      if (gitState && typeof gitState === 'object') return { ...checkout, ...gitState, dirty: false };
    } catch { /* fall through */ }
  }
  try {
    const exec = typeof deps.gitExecForIntegrate === 'function'
      ? (cmd, args, opts) => deps.gitExecForIntegrate(root, cmd, args, opts)
      : (cmd, args, opts) => defaultGitExec(root, cmd, args, opts);
    const gitState = await integrateCheckoutGitState(root, {
      exec,
      runStatus: typeof deps.runIntegrateGitStatus === 'function'
        ? opts => deps.runIntegrateGitStatus(root, opts)
        : undefined,
      outputPaths,
    });
    if (gitState) return { ...checkout, ...gitState, dirty: false };
  } catch { /* use raw checkout */ }
  return checkout;
}

function runAlreadyIntegrated(events, runId) {
  const list = Array.isArray(events) ? events : [];
  return list.some(event => event
    && event.kind === 'integration'
    && event.run === runId
    && (event.status === 'complete' || event.status === 'integrated'));
}

function runManifestFromEvents(run, events) {
  if (run?.manifest && typeof run.manifest === 'object') return run.manifest;
  const history = Array.isArray(events) ? events.filter(e => e && e.kind === 'run' && e.id === run?.id) : [];
  const hit = history.find(e => e.manifest && typeof e.manifest === 'object');
  return hit?.manifest ?? null;
}

function jobsFromRun(run, manifest) {
  const fromManifest = Array.isArray(manifest?.jobs) ? manifest.jobs : [];
  const raw = run?.jobs;
  const fromRun = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  if (!fromManifest.length) return fromRun;
  if (!fromRun.length) return fromManifest;
  const seen = new Set(fromManifest.map(j => j?.id).filter(Boolean));
  return [...fromManifest, ...fromRun.filter(j => j?.id && !seen.has(j.id))];
}

function runHasCompleteJob(run) {
  if (!run || typeof run !== 'object') return false;
  const complete = Number(run.counts?.complete);
  if (Number.isFinite(complete) && complete > 0) return true;
  const raw = run.jobs;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  return list.some(job => job && (job.status === 'complete' || job.state === 'complete'));
}

async function resolveRunForIntegrate(root, runId, deps, events) {
  const listRuns = typeof deps.listRuns === 'function' ? deps.listRuns : deps.loadRuns;
  if (typeof listRuns === 'function') {
    const runs = await listRuns(root);
    const list = Array.isArray(runs) ? runs : [];
    const hit = list.find(r => r && r.id === runId);
    if (hit) return { run: hit, runs: list };
  }
  const runEvents = (Array.isArray(events) ? events : []).filter(e => e?.kind === 'run' && e?.id === runId);
  const run = runEvents.length ? runEvents[runEvents.length - 1] : null;
  return { run, runs: run ? [run] : [] };
}

/** True when integrateRun finished with checks passed (matches autopilot integrate completion). */
export function integrateTriageSucceeded(out) {
  if (!out || typeof out !== 'object') {
    return { ok: false, error: 'integrate: empty result' };
  }
  if (out.status === 'failed' || out.integrationStatus === 'failed-check') {
    return { ok: false, error: String(out.message ?? 'integrate failed') };
  }
  if (out.checksPassed === false) {
    return { ok: false, error: String(out.message ?? 'integration checks failed') };
  }
  if (out.status === 'partial' || out.integrationStatus === 'partial' || out.integrationStatus === 'queued') {
    return { ok: false, error: 'integration incomplete' };
  }
  if (out.status === 'checks-failed') {
    return { ok: false, error: String(out.message ?? 'integration checks failed') };
  }
  const status = out.status;
  if (status !== 'integrated' && status !== 'merged') {
    return { ok: false, error: String(out.message ?? `integrate did not complete (status ${status ?? 'unknown'})`) };
  }
  return { ok: true, error: null };
}

const swarmEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'swarm.mjs');
const realpathCache = new Map();
let memoryProbeWarningLogged = false;

function logMemoryProbeWarningOnce(warning, log) {
  if (!warning || memoryProbeWarningLogged) return;
  memoryProbeWarningLogged = true;
  log(warning);
}

function canonicalRoot(root) {
  if (typeof root !== 'string' || !root) return null;
  const resolved = path.resolve(root);
  if (realpathCache.has(resolved)) return realpathCache.get(resolved);
  let canonical;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  realpathCache.set(resolved, canonical);
  return canonical;
}

export function sameRoot(a, b) {
  const ca = canonicalRoot(a);
  const cb = canonicalRoot(b);
  if (ca === null || cb === null) return false;
  return ca === cb;
}

function ticketFiles(ticket) {
  if (!ticket || typeof ticket !== 'object') return [];
  if (Array.isArray(ticket.files)) return ticket.files.map(String);
  if (typeof ticket.file === 'string' && ticket.file) return [ticket.file];
  return [];
}

function splitParkIngestRunId(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.ingestRun) return String(item.ingestRun);
  if (item.runId) return String(item.runId);
  const blob = `${item.text ?? ''} ${item.title ?? ''}`;
  const match = blob.match(/--ingest\s+([A-Za-z0-9][A-Za-z0-9._-]+)/);
  return match ? match[1] : null;
}

/** Production needs-you triage handlers (safe scope commands only; never executes item text). */
export function buildNeedsYouTriageHandlers(projectRoot, inject = {}) {
  const handlers = Object.create(null);
  const env = inject.env ?? process.env;

  handlers['split-park'] = async ({ root, item, deps }) => {
    const runId = splitParkIngestRunId(item);
    if (!runId) return { ok: false, error: 'split-park: missing ingest run id' };
    const { runScopeCommand } = await import('./scope-commands.mjs');
    const res = await runScopeCommand(root, 'split', ['--ingest', runId, '--merge', '--max-repairs', '3'], deps.scopeDeps ?? {});
    const ok = res?.exitCode === 0;
    return { ok, error: ok ? null : String(res?.stdout ?? 'split ingest failed').slice(0, 500) };
  };

  const integrateRunForRoot = async (root, runId) => {
    if (typeof inject.integrate === 'function') return inject.integrate(root, runId);
    const { integrateRun } = await import('./swarm.mjs');
    return integrateRun(root, runId, {});
  };

  const guardedIntegrateRun = async ({ root, item, deps, runId }) => {
    if (typeof deps.readJournal !== 'function') {
      return { ok: false, error: 'integrate: journal unavailable' };
    }
    const events = await deps.readJournal(root, { limit: Infinity });
    if (runAlreadyIntegrated(events, runId)) {
      return { ok: false, error: `run ${runId} is already integrated` };
    }
    const { run, runs } = await resolveRunForIntegrate(root, runId, deps, events);
    if (!run) {
      return { ok: false, error: 'run not found' };
    }
    const outputPaths = runIntegrateOutputPaths(run, events, { runs });
    {
      const manifest = runManifestFromEvents(run, events);
      const jobs = jobsFromRun(run, manifest);
      const hasIntegratableJobs = integrableFromJobs(jobs)
        || (run.integrable === true && runHasCompleteJob(run));
      if (hasIntegratableJobs && outputPaths.length === 0) {
        return { ok: false, error: 'integratable jobs have no declared output paths' };
      }
    }
    let checkout = null;
    try {
      if (typeof deps.checkout === 'function') checkout = await deps.checkout(root);
    } catch { checkout = null; }
    const checkoutView = await resolveIntegrateCheckoutView(root, checkout, outputPaths, deps);
    const why = integrationBlocker(checkoutView, { outputPaths });
    if (why) return { ok: false, error: why };
    try {
      const out = await integrateRunForRoot(root, runId);
      return integrateTriageSucceeded(out);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };

  handlers.integrate = async ({ root, item, deps }) => {
    const runId = integrateBlockerRunIdFromId(String(item?.id ?? ''));
    if (!runId) return { ok: false, error: 'integrate: missing run id' };
    return guardedIntegrateRun({ root, item, deps, runId });
  };

  handlers['integrate-checkout'] = async ({ root, item, deps }) => {
    const runId = integrateBlockerRunIdFromId(String(item?.id ?? ''));
    if (!runId) return { ok: false, error: 'integrate-checkout: missing run id' };
    return guardedIntegrateRun({ root, item, deps, runId });
  };

  return buildHandlersMap(handlers);
}

/** Dependency bundle for autopilot start-ready (live runs, busy markers, cap, go --scope). */
const SCOPE_CHILD_ERR_TRIM_ABOVE = 256 * 1024;
const SCOPE_CHILD_ERR_KEEP_TAIL = 64 * 1024;
const SCOPE_CHILD_ERR_SNIPPET = 300;

async function trimScopeChildErrLog(filePath) {
  try {
    const st = await fsPromises.stat(filePath);
    if (!st.isFile() || st.size <= SCOPE_CHILD_ERR_TRIM_ABOVE) return;
    const tailStart = Math.max(0, st.size - SCOPE_CHILD_ERR_KEEP_TAIL);
    const tailLen = st.size - tailStart;
    const handle = await fsPromises.open(filePath, 'r');
    const buf = Buffer.alloc(tailLen);
    await handle.read(buf, 0, tailLen, tailStart);
    await handle.close();
    await fsPromises.writeFile(filePath, buf, { mode: 0o600 });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

async function readScopeChildErrSnippet(filePath, startOffset) {
  try {
    const st = await fsPromises.stat(filePath);
    if (!st.isFile() || st.size <= startOffset) return '';
    const len = st.size - startOffset;
    const handle = await fsPromises.open(filePath, 'r');
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, startOffset);
    await handle.close();
    const slice = buf.subarray(Math.max(0, buf.length - SCOPE_CHILD_ERR_SNIPPET));
    return slice.toString('utf8');
  } catch {
    return '';
  }
}

async function openScopeChildStderrLog(root, {
  scopeChildStderrPath = null,
  scopeChildStderrFd = null,
} = {}) {
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const filePath = scopeChildStderrPath ?? path.join(dir, 'scope-child.err');
  await assertRegularOrMissing(filePath);
  await trimScopeChildErrLog(filePath);
  let startOffset = 0;
  try {
    const st = await fsPromises.stat(filePath);
    if (st.isFile()) startOffset = st.size;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let fd = scopeChildStderrFd;
  let openedHere = false;
  if (fd === null || fd === undefined) {
    fd = fs.openSync(filePath, 'a', 0o600);
    openedHere = true;
  }
  return { filePath, fd, startOffset, openedHere };
}

export function readyAutopilotDeps(projectRoot, {
  env = process.env,
  memoryAware = true,
  spawnImpl,
  selfPid = process.pid,
  spawnEarlyExitMs = 1500,
  liveBusyMarkers,
  listLiveRuns,
  checkProjectCap,
  readTickets,
  readPending,
  readMachine: readMachineImpl = readMachine,
  log = line => process.stderr.write(`${line}\n`),
  installRoot = null,
  loadRuns = null,
  listRuns = null,
  scopeChildStderrPath = null,
  scopeChildStderrFd = null,
  openScopeChildStderr = openScopeChildStderrLog,
} = {}) {
  const runLoader = typeof listRuns === 'function' ? listRuns : loadRuns;
  const rootForMarkers = projectRoot;

  async function allTickets(root) {
    return readTickets(root);
  }

  const bundle = {
    readTickets: allTickets,

    async readyTickets(root) {
      const tickets = await readTickets(root);
      const list = Array.isArray(tickets) ? tickets : [];
      return list.filter(t => t && t.status === 'ready').map(t => ({ ...t, files: ticketFiles(t) }));
    },

    async pendingApprovals(root) {
      const hand = listRequests(root)
        .filter(r => r && r.status === 'pending')
        .map(r => ({ status: 'pending', files: Array.isArray(r.files) ? r.files.map(String) : [] }));
      const pending = await readPending(root);
      const ticketApprovals = (Array.isArray(pending) ? pending : [])
        .filter(a => a && a.status === 'pending')
        .map(a => ({ status: 'pending', files: Array.isArray(a.files) ? a.files.map(String) : [] }));
      return [...hand, ...ticketApprovals];
    },

    async liveRuns(root) {
      const runs = await listLiveRuns();
      const list = Array.isArray(runs) ? runs : [];
      return list.filter(run => run && sameRoot(run.root, root));
    },

    async busyMarkers() {
      const markers = await liveBusyMarkers();
      const list = Array.isArray(markers) ? markers : [];
      return list.filter(m => m && m.pid !== selfPid && rootForMarkers && sameRoot(m.root, rootForMarkers));
    },

    async capRoom(root) {
      const capped = await checkProjectCap(root, { env });
      return capped == null;
    },

    async autopilotStartReadySettings(root, { freeSlots } = {}) {
      let autopilotCfg = null;
      try { autopilotCfg = loadLocalConfig({ env })?.autopilot ?? null; } catch { autopilotCfg = null; }
      let project = null;
      try {
        const pointer = JSON.parse(await fsPromises.readFile(path.join(path.resolve(root), '.project-swarm.json'), 'utf8'));
        project = pointer?.autopilot ?? null;
      } catch { project = null; }
      const tickets = await allTickets(root);
      const doneTicketCount = (Array.isArray(tickets) ? tickets : []).filter(t => t?.status === 'done').length;
      const settings = resolveAutopilotStartReady({ machine: autopilotCfg, project, freeSlots, doneTicketCount });
      if (!memoryAware) return settings;
      let config = {};
      try { config = loadLocalConfig({ env }) ?? {}; } catch { config = {}; }
      let hw;
      try { hw = await readMachineImpl(); } catch { return settings; }
      logMemoryProbeWarningOnce(hw?.warning, log);
      const ceiling = Number.isInteger(settings?.maxJobs) && settings.maxJobs > 0 ? settings.maxJobs : 1;
      const { effective } = effectiveMachineLimit({ limit: ceiling, machine: hw, config });
      return { ...settings, maxJobs: Math.min(ceiling, effective) };
    },

    async startScope({ root, maxJobs, skipSkeleton = false }) {
      const cwd = path.resolve(typeof root === 'string' && root ? root : projectRoot);
      let jobs = Number.isInteger(maxJobs) && maxJobs > 0 ? maxJobs : 1;
      if (memoryAware) {
        let config = {};
        try { config = loadLocalConfig({ env }) ?? {}; } catch { config = {}; }
        let hw;
        try { hw = await readMachineImpl(); } catch { hw = null; }
        if (hw) logMemoryProbeWarningOnce(hw.warning, log);
        if (hw && memoryPressureLevel(hw) === 'hard') {
          log(memoryPressureHoldLine(hw));
          return { ok: true, result: 'held-memory' };
        }
        if (hw) {
          const { effective } = effectiveMachineLimit({ limit: jobs, machine: hw, config });
          jobs = Math.min(jobs, effective);
        }
      }
      const args = [swarmEntry, '--root', cwd, 'go', '--scope', '--max-jobs', String(jobs)];
      if (skipSkeleton) args.push('--skip-skeleton');
      const childEnv = { ...env, SWARM_AUTOPILOT_PID: String(selfPid) };
      let stderrLog = null;
      try {
        stderrLog = await openScopeChildStderr(cwd, {
          scopeChildStderrPath,
          scopeChildStderrFd,
        });
        const { filePath: stderrFilePath, fd: stderrFd, startOffset, openedHere } = stderrLog;
        const child = spawnImpl(process.execPath, args, {
          detached: true,
          stdio: ['ignore', 'ignore', stderrFd],
          env: childEnv,
          cwd,
        });
        if (openedHere) {
          try { fs.closeSync(stderrFd); } catch { /* ignore */ }
        }
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (out) => {
            if (settled) return;
            settled = true;
            resolve(out);
          };
          const earlyExitTimer = setTimeout(() => {
            if (settled) return;
            child.unref?.();
            finish({ ok: true, result: `started go --scope (pid ${child?.pid})` });
          }, spawnEarlyExitMs);
          const settleEarlyExit = async (out) => {
            clearTimeout(earlyExitTimer);
            finish(out);
          };
          child.once('error', (error) => {
            settleEarlyExit({ ok: false, result: String(error?.message ?? error) });
          });
          child.once('exit', (code, signal) => {
            if (settled) return;
            void (async () => {
              const exitFailed = Boolean(signal)
                || (typeof code === 'number' && code !== 0);
              if (exitFailed) {
                const parts = [`exit code ${code ?? 'null'}`];
                if (signal) parts.push(`signal ${signal}`);
                const errText = await readScopeChildErrSnippet(stderrFilePath, startOffset);
                if (errText) parts.push(errText);
                await settleEarlyExit({ ok: false, result: parts.join(': ') });
                return;
              }
              await settleEarlyExit({ ok: true, result: `started go --scope (pid ${child?.pid})` });
            })();
          });
        });
      } catch (error) {
        if (stderrLog?.openedHere && Number.isInteger(stderrLog.fd)) {
          try { fs.closeSync(stderrLog.fd); } catch { /* ignore */ }
        }
        return { ok: false, result: String(error?.message ?? error) };
      }
    },

    async markDone(root, id, extra = {}) {
      const now = typeof extra.now === 'function' ? extra.now : () => Date.now();
      return markDone(root, id, inboxDeps({ now, channel: 'agent' }));
    },

    async addGoal(root, spec, opts = {}) {
      const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
      return addGoal(root, spec, { ...opts, now });
    },

    installRoot,
    ...(typeof runLoader === 'function' ? { loadRuns: runLoader, listRuns: runLoader } : {}),
  };

  bundle.needsYouTriage = {
    handlers: buildNeedsYouTriageHandlers(projectRoot, {
      env,
      spawnImpl,
      installRoot,
      startScope: opts => bundle.startScope(opts),
    }),
    ...(typeof runLoader === 'function' ? { listRuns: runLoader } : {}),
  };

  return bundle;
}
