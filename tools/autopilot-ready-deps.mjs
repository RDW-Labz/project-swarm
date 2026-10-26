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
  safeWritableDir,
} from './journal.mjs';
import {
  integrationBlocker,
  integrableFromJobs,
  runIntegrateOutputPaths,
} from './autopilot.mjs';
import { integrateCheckoutGitState } from './generated-state.mjs';
import { buildHandlersMap } from './needs-you-triage.mjs';
import { readLockOwner, isAlive as defaultIsAlive } from './autopilot-lock.mjs';

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
export function readyAutopilotDeps(projectRoot, {
  env = process.env,
  memoryAware = true,
  spawnImpl,
  selfPid = process.pid,
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
  startScopeExitGraceMs = 300,
  waitStartScopeExitGrace = ms => new Promise(resolve => setTimeout(resolve, ms)),
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

    readScopeLoopLock: root => readLockOwner(root, 'scope-loop'),
    isAlive: defaultIsAlive,

    async startScope({ root, maxJobs, skipSkeleton = false, exitGraceMs, waitExitGrace } = {}) {
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
      const graceMs = Number.isFinite(exitGraceMs) ? exitGraceMs : startScopeExitGraceMs;
      const waitGrace = typeof waitExitGrace === 'function' ? waitExitGrace : waitStartScopeExitGrace;
      let stderrFd;
      let logPath;
      // Opening the log file is best-effort: a root that doesn't exist on disk (as in many
      // unit-test fixtures) must not block spawning go --scope, only the early-failure tail read.
      try {
        const scratchDir = await safeWritableDir(cwd, ['.swarm', 'project']);
        logPath = path.join(scratchDir, 'go-scope-spawn.log');
        stderrFd = fs.openSync(logPath, 'a');
      } catch {
        stderrFd = undefined;
        logPath = undefined;
      }
      try {
        const child = spawnImpl(process.execPath, args, {
          detached: true,
          stdio: ['ignore', 'ignore', stderrFd !== undefined ? stderrFd : 'ignore'],
          env: { ...env, SWARM_AUTOPILOT_PID: String(selfPid) },
          cwd,
        });
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (out) => {
            if (settled) return;
            settled = true;
            try { fs.closeSync(stderrFd); } catch { /* ignore */ }
            resolve(out);
          };
          const readLogTail = () => {
            try {
              const buf = fs.readFileSync(logPath);
              const tail = buf.length > 4096 ? buf.subarray(buf.length - 4096) : buf;
              return tail.toString('utf8').trim();
            } catch {
              return '';
            }
          };
          const spawnFailure = (code, signal) => {
            if (signal != null && signal !== '') return true;
            if (typeof code === 'number' && code !== 0) return true;
            return false;
          };
          child.once('error', (error) => finish({ ok: false, result: String(error?.message ?? error) }));
          child.once('exit', (code, signal) => {
            if (!spawnFailure(code, signal)) return;
            const tail = readLogTail();
            const suffix = tail ? `: ${tail}` : '';
            if (signal != null && signal !== '') {
              finish({ ok: false, result: `killed by ${signal}${suffix}` });
            } else {
              finish({ ok: false, result: `exit code ${code}${suffix}` });
            }
          });
          waitGrace(graceMs).then(() => {
            if (settled) return;
            child.unref();
            const pid = child.pid;
            finish({ ok: true, pid, result: `started go --scope (pid ${pid})` });
          });
        });
      } catch (error) {
        if (stderrFd !== undefined) {
          try { fs.closeSync(stderrFd); } catch { /* ignore */ }
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
