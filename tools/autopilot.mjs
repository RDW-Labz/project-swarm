// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { O_NOFOLLOW, O_RDONLY } from 'node:constants';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stopGuard } from './stop-all.mjs';
import { matchesFile, ELEVATED_GIT_OPS } from './handbuild.mjs';
import { runPolicyPass, appendAutoDecision } from './policy-run.mjs';
import { resolveDailyLimit } from './daily-limit.mjs';
import { filterGeneratedStatus, formatDirtyListing, integrateCheckoutGitState } from './generated-state.mjs';
import { planWaveBatch } from './wave-batch.mjs';
import { isAskRun, isNonIntegratingRun, runHasNoOutputs, runIntegratedFromState } from './run-kind.mjs';
import { noteAutopilotStep } from './orchestrator-context.mjs';
import {
  appendIntegrateBlockerIfNeeded,
  integrateBlockerFields,
  integrateBlockerId,
  integrateBlockerKindFromId,
  integrateBlockerResolutionEvent,
  integrateBlockerRunIdFromId,
  integrateBlockerSuppressed,
  openBlockerIds,
} from './journal.mjs';
import { runNeedsYouTriagePass } from './needs-you-triage.mjs';
import { readLockOwner, isAlive as defaultIsAlive } from './autopilot-lock.mjs';

/** Pids of go --scope children spawned by this autopilot process (not orphaned predecessors). */
const spawnedScopeLoopPids = new Set();

const POLICY_PASS_KINDS = new Set([
  'hand-build-request',
  'ticket-set-status',
  'ticket-park',
  'ticket-retry',
  'ticket-release',
  'change-order-path-fix',
  'change-order-split',
]);

function elevatedGitInItem(item) {
  const git = item?.facts?.git ?? item?.git;
  if (git == null || git === '') return false;
  const entries = Array.isArray(git) ? git : [git];
  return entries.some(g => {
    const name = typeof g === 'string' ? g : g?.op ?? g?.name;
    return typeof name === 'string' && ELEVATED_GIT_OPS.includes(name);
  });
}

export function filterPolicyPassItems(items) {
  return (Array.isArray(items) ? items : []).filter(item => {
    if (!item || typeof item !== 'object') return false;
    if (!POLICY_PASS_KINDS.has(item.kind)) return false;
    if (item.kind === 'hand-build-request' && elevatedGitInItem(item)) return false;
    return true;
  });
}

export function policyPassFacts({ billedTodayUsd, settings, factsOf, item }) {
  const base = typeof factsOf === 'function' ? (factsOf(item) ?? {}) : {};
  const { dailyLimitUsd } = resolveDailyLimit(settings ?? {});
  const billed = Number(billedTodayUsd) || 0;
  return { ...base, pastDailyAutoLimit: billed >= dailyLimitUsd };
}

export async function executePolicyPass(root, deps, { now = Date.now } = {}) {
  const cfg = deps?.policyPass;
  if (!cfg || typeof cfg !== 'object') return null;
  if (typeof cfg.loadRules !== 'function') return null;
  const rules = await cfg.loadRules();
  if (rules == null) return { decided: [], left: [], skipped: true };
  const listOpen = cfg.openRequests ?? cfg.listOpenRequests;
  const items = typeof listOpen === 'function' ? await listOpen(root) : [];
  const filtered = filterPolicyPassItems(items);
  if (Object.hasOwn(cfg, 'billedTodayUsd') && typeof cfg.billedTodayUsd !== 'function') {
    return { decided: [], left: filtered, skipped: true };
  }
  const billedTodayUsd = typeof cfg.billedTodayUsd === 'function' ? await cfg.billedTodayUsd(root) : 0;
  const settings = typeof cfg.dailyLimitSettings === 'function' ? await cfg.dailyLimitSettings(root) : {};
  const factsOf = item => policyPassFacts({ billedTodayUsd, settings, factsOf: cfg.factsOf, item });
  if (typeof cfg.apply !== 'function') return null;
  if (Object.hasOwn(cfg, 'events') && typeof cfg.events !== 'function') {
    return { decided: [], left: filtered, skipped: true };
  }
  const readHandled = typeof cfg.readHandled === 'function' ? cfg.readHandled : () => [];
  const appendDeps = typeof cfg.appendAutoDecisionDeps === 'object' ? cfg.appendAutoDecisionDeps : {};
  const journal = entry => appendAutoDecision({ root, entry, deps: { now, ...appendDeps } });
  const events = typeof cfg.events === 'function' ? cfg.events : () => {};
  const billed = Number(billedTodayUsd) || 0;
  const { dailyLimitUsd } = resolveDailyLimit(settings ?? {});
  const limits = cfg.limits ?? {
    pastDailyAutoLimit: () => billed >= dailyLimitUsd,
  };
  return runPolicyPass({
    root,
    items: filtered,
    rules,
    factsOf,
    apply: cfg.apply,
    journal,
    events,
    now,
    machine: cfg.machine ?? '',
    readHandled,
    limits,
  });
}
export const DEFAULT_AUTOPILOT_ACTIONS = ['integrate', 'resume', 'retry-failed', 'unlock-tickets', 'start-ready'];
export const LEGACY_PLAN_ACTIONS = ['start-wave', 'start-deferred', 'start-backlog'];
export const ACTIONS = [...DEFAULT_AUTOPILOT_ACTIONS, ...LEGACY_PLAN_ACTIONS];

function ticketFiles(ticket) {
  if (!ticket || typeof ticket !== 'object') return [];
  if (Array.isArray(ticket.files)) return ticket.files.map(String);
  if (typeof ticket.file === 'string' && ticket.file) return [ticket.file];
  return [];
}

function isReadyForStart(ticket) {
  return ticket && typeof ticket.id === 'string' && ticket.status === 'ready';
}

function pendingApproval(approval) {
  return approval && typeof approval === 'object' && approval.status === 'pending';
}

function heldByApproval(ticket, approval) {
  const approvalPatterns = Array.isArray(approval.files) ? approval.files : [];
  const ticketPatterns = ticketFiles(ticket);
  if (!approvalPatterns.length || !ticketPatterns.length) return false;
  if (ticketPatterns.some(rel => matchesFile(approvalPatterns, rel))) return true;
  if (approvalPatterns.some(rel => matchesFile(ticketPatterns, rel))) return true;
  return false;
}

/** Ready tickets split by pending hand-build / ticket approvals that name overlapping files. */
export function pickReadyTickets({ tickets, approvals }) {
  const list = Array.isArray(tickets) ? tickets : [];
  const pending = (Array.isArray(approvals) ? approvals : []).filter(pendingApproval);
  const ready = list.filter(t => isReadyForStart(t));
  const startable = [];
  const held = [];
  for (const ticket of ready) {
    if (pending.some(a => heldByApproval(ticket, a))) held.push(ticket);
    else startable.push(ticket);
  }
  return { startable, held };
}

const MINUTE = 60_000;
const START_READY_MIN_MS = 120_000;
const START_READY_STALE_MS = 10 * MINUTE;
export const START_READY_HOLD_BACKOFF_MS = 60_000;
const MAX_ACTIONS_PER_RUN = 3;
const MAX_RUNS = 10;
const RESULT_LIMIT = 500;

function nowValue(now) {
  return typeof now === 'function' ? now() : now;
}

function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function actionEvents(events, action, runId) {
  return events.filter(e => e && e.kind === 'action' && e.action === action && (runId === undefined || e.run === runId));
}

function lastActionAt(events, action, runId) {
  let latest = null;
  for (const e of actionEvents(events, action, runId)) {
    const at = timeOf(e.ts);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function cooledDown(events, action, runId, now, minutes) {
  const last = lastActionAt(events, action, runId);
  return last === null || now - last >= minutes * MINUTE;
}

function failedResult(event) {
  return event.result !== undefined && event.result !== 'ok' && event.result?.ok !== true;
}

function openIds(events) {
  const latest = new Map();
  for (const e of events) {
    if (e && (e.kind === 'blocker' || e.kind === 'human') && e.id) latest.set(e.id, e);
  }
  const open = new Set();
  for (const [id, e] of latest) {
    const closed = e.kind === 'blocker' ? e.resolved === true : e.done === true;
    if (!closed) open.add(id);
  }
  return open;
}

/** True when at least one job declares a non-empty `outputs` list (review-only / ask runs stay false). */
export function integrableFromJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : (jobs && typeof jobs === 'object' ? Object.values(jobs) : []);
  return list.some(job => job && Array.isArray(job.outputs) && job.outputs.length > 0);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Run summary for autopilot (`loadRuns` shape plus `integrable`) from a saved `state.json`. */
export function autopilotRunFromState(state, directoryName) {
  const jobList = state.jobs && typeof state.jobs === 'object'
    ? (Array.isArray(state.jobs) ? state.jobs : Object.values(state.jobs))
    : [];
  const costs = jobList.map(job => numberOrNull(job?.costUsd)).filter(value => value !== null);
  return {
    id: state.id ?? directoryName,
    status: state.status ?? null,
    startedAt: state.startedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    counts: state.summary?.counts ?? null,
    costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
    pause: state.pause ?? null,
    integrated: runIntegratedFromState(state),
    integratedAt: state.integratedAt ?? null,
    integrationStatus: state.integrationStatus ?? null,
    handled: state.handled === true,
    integrable: integrableFromJobs(state.jobs),
  };
}

function runCountsAsIntegrated(run) {
  if (!run || typeof run !== 'object') return false;
  if (run.integrationStatus === 'partial' || run.integrationStatus === 'queued') return false;
  return run.integrated === true;
}

function retryFailedCounted(events, runId) {
  return actionEvents(events, 'retry-failed', runId).some(event => !failedResult(event));
}

function retryRunInFlight(events, runId) {
  return events.some(e => e && e.kind === 'run' && e.retryOf === runId && e.status === 'running');
}

function runIsHandled(run, events) {
  if (run?.handled === true) return true;
  const id = run?.id;
  if (!id) return false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'run' && event.id === id && event.handled === true) return true;
  }
  return false;
}

/** Another run already completed the same manifest work (hand rerun / integrated sibling). */
export function supersedingSuccessfulRun(run, { runs, events, manifest } = {}) {
  const fp = manifest && typeof manifest === 'object' ? manifestWorkFingerprint(manifest) : null;
  if (!fp?.jobIds?.length) return false;
  const list = Array.isArray(runs) ? runs : [];
  for (const other of list) {
    if (!other || other.id === run.id) continue;
    const done = other.status === 'complete' || other.status === 'integrated' || other.integrated === true;
    if (!done) continue;
    const otherManifest = runManifest(other, events);
    if (!otherManifest) continue;
    const otherFp = manifestWorkFingerprint(otherManifest);
    if (fingerprintsMatch(fp, otherFp)) return true;
    if (fp.outputsHash === otherFp.outputsHash && fp.jobIds.length === otherFp.jobIds.length) return true;
  }
  return false;
}

function integrateBlockerRunId(blockerId) {
  return integrateBlockerRunIdFromId(blockerId);
}

function runManifest(run, events) {
  if (run?.manifest && typeof run.manifest === 'object') return run.manifest;
  const history = Array.isArray(events) ? events.filter(e => e && e.kind === 'run' && e.id === run?.id) : [];
  const hit = history.find(e => e.manifest && typeof e.manifest === 'object');
  return hit?.manifest ?? null;
}

export function runSkipsIntegrateAttention(run, events, { runs, root, readRunFolder } = {}) {
  if (!run || typeof run !== 'object') return true;
  if (runCountsAsIntegrated(run)) return true;
  if (['cancelled', 'abandoned'].includes(run.status)) return true;
  const manifest = runManifest(run, events);
  if (isAskRun(run, manifest) && runHasNoOutputs({ id: run.id, jobs: run.jobs })) return true;
  if (run.integrable === false) return true;
  if (runHasNoOutputs({ id: run.id, jobs: run.jobs })) {
    if (run.integrable === true && runHasCompleteJob(run)) return false;
    return true;
  }
  return isNonIntegratingRun(run, manifest);
}

function runJobCount(run) {
  if (!run || typeof run !== 'object') return 0;
  if (Number.isFinite(run.jobCount)) return run.jobCount;
  const counts = run.counts;
  if (counts && Number.isFinite(counts.total)) return counts.total;
  if (counts && Number.isFinite(counts.complete) && Number.isFinite(counts.failed)) {
    return counts.complete + counts.failed + (Number(counts.running) || 0);
  }
  return 1;
}

function latestBlockerEvent(events, id) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === 'blocker' && e.id === id) return e;
  }
  return null;
}

function waveDone(waveId, waves, events) {
  const wave = waves.find(w => w && w.id === waveId);
  if (!wave) return false;
  return events.some(run => run && run.kind === 'run' && run.status === 'complete' && run.manifest === wave.manifest
    && events.some(i => i && i.kind === 'integration' && i.run === run.id && (i.status === 'complete' || i.status === 'integrated')));
}

export function nextWave(events, plan) {
  const waves = Array.isArray(plan?.waves) ? plan.waves : [];
  for (const wave of waves) {
    if (!wave || typeof wave !== 'object') continue;
    if (events.some(e => e && e.kind === 'action' && e.action === 'start-wave' && e.wave === wave.id)) continue;
    const after = Array.isArray(wave.after) ? wave.after : [];
    if (after.every(dep => waveDone(dep, waves, events))) return wave;
  }
  return null;
}

/** Stable job-id list and outputs fingerprint for comparing plan waves to saved runs. */
export function manifestWorkFingerprint(manifest) {
  const jobs = Array.isArray(manifest?.jobs) ? manifest.jobs : [];
  const jobIds = jobs.map(job => job?.id).filter(id => typeof id === 'string' && id).sort();
  const outputsPayload = jobs
    .filter(job => job && typeof job.id === 'string')
    .map(job => ({
      id: job.id,
      outputs: [...(Array.isArray(job.outputs) ? job.outputs : [])].map(String).sort(),
      outputDirs: [...(Array.isArray(job.outputDirs) ? job.outputDirs : [])].map(String).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const outputsHash = crypto.createHash('sha256').update(JSON.stringify(outputsPayload)).digest('hex');
  return { jobIds, outputsHash };
}

function fingerprintsMatch(a, b) {
  return a && b && a.outputsHash === b.outputsHash && a.jobIds.length === b.jobIds.length
    && a.jobIds.every((id, index) => id === b.jobIds[index]);
}

/**
 * True when a plan wave manifest should not start again (hand rerun, integrated run, or stale file).
 * `existing` entries come from saved runs (any starter): fingerprint, completed job ids, status, times.
 */
export function legacyWaveAlreadyRun({ manifest, manifestMtimeMs, existing }) {
  if (!manifest || typeof manifest !== 'object') return false;
  const fingerprint = manifestWorkFingerprint(manifest);
  if (!fingerprint.jobIds.length) return false;
  const waveJobSet = new Set(fingerprint.jobIds);
  const mtime = Number.isFinite(manifestMtimeMs) ? manifestMtimeMs : null;
  let newestOverlapMs = null;
  for (const run of Array.isArray(existing) ? existing : []) {
    if (!run || typeof run !== 'object') continue;
    const runFp = run.fingerprint;
    const runJobIds = Array.isArray(runFp?.jobIds) ? runFp.jobIds : [];
    const overlaps = runJobIds.some(id => waveJobSet.has(id));
    if (overlaps) {
      const runTime = Number.isFinite(run.timeMs) ? run.timeMs : null;
      if (runTime !== null && (newestOverlapMs === null || runTime > newestOverlapMs)) newestOverlapMs = runTime;
    }
    const completed = new Set(Array.isArray(run.completedJobIds) ? run.completedJobIds : []);
    const allWaveJobsComplete = fingerprint.jobIds.every(id => completed.has(id));
    const status = run.status ?? null;
    const integrated = run.integrated === true;
    const runComplete = status === 'complete' || status === 'integrated' || integrated || run.allJobsComplete === true;
    if (runFp && fingerprintsMatch(fingerprint, runFp) && runComplete) return true;
    if (allWaveJobsComplete) return true;
  }
  if (mtime !== null && newestOverlapMs !== null && mtime < newestOverlapMs) return true;
  return false;
}

export function decide(run, ctx) {
  if (!run || typeof run !== 'object') return null;
  const c = ctx ?? {};
  const events = Array.isArray(c.events) ? c.events : [];
  const now = nowValue(c.now ?? Date.now);
  const id = run.id;
  const pause = run.pause ?? null;
  const reasons = Array.isArray(pause?.reasons) ? pause.reasons.map(String) : [];
  const failedCount = Number(run.counts?.failed) || 0;

  if (run.status === 'complete' && !runCountsAsIntegrated(run)) {
    if (runIsHandled(run, events)) return null;
    if (run.integrable === false) return null;
    if (runSkipsIntegrateAttention(run, events, { runs: c.runs })) return null;
    const failures = actionEvents(events, 'integrate', id).filter(failedResult);
    if (failures.length) {
      const last = failures[failures.length - 1];
      const reason = typeof last.result === 'string' ? last.result : (last.result?.error ?? 'failed');
      const integrateCause = reason;
      const blockerId = integrateBlockerId('integrate', id, integrateCause, { events });
      return {
        action: 'block',
        run: id,
        id: blockerId,
        text: `Integration of run ${id} needs a decision: ${reason}`,
        integrateKind: 'integrate',
        integrateCause,
      };
    }
    return { action: 'integrate', run: id, reason: 'run complete, not integrated' };
  }

  if (run.status === 'paused') {
    if (reasons.includes('run-cap') || reasons.includes('child-paused')) {
      return { action: 'block', run: id, id: `cap-${id}`, text: `Run ${id} is paused on a spend cap. Raising a cap needs the owner: swarm resume ${id} --raise maxUsd=<N> --reason TEXT` };
    }
    if (reasons.includes('human')) return { action: 'wait', run: id, reason: 'waiting for human jobs' };
    if (reasons.includes('lane-cap')) {
      if (cooledDown(events, 'resume', id, now, 15)) return { action: 'resume', run: id, reason: 'lane cap, retry after 15 minutes' };
      return { action: 'wait', run: id, reason: 'lane-cap cooldown' };
    }
    const quotaOnly = reasons.length > 0 && reasons.every(r => r === 'quota' || r.startsWith('after '));
    if (quotaOnly) {
      const until = timeOf(pause.until);
      if (until !== null && until > now) return { action: 'wait', run: id, reason: `quota until ${pause.until}` };
      if (cooledDown(events, 'resume', id, now, 5)) return { action: 'resume', run: id, reason: 'quota window passed' };
      return { action: 'wait', run: id, reason: 'resume cooldown' };
    }
    return null;
  }

  if (run.status === 'failed') {
    const manifest = c.manifest ?? runManifest(run, events);
    if (runIsHandled(run, events)) return null;
    if (supersedingSuccessfulRun(run, { runs: c.runs, events, manifest })) return null;
    const retried = retryFailedCounted(events, id);
    const isRetry = events.some(e => e && e.kind === 'run' && e.id === id && e.retryOf);
    if (retried) {
      if (retryRunInFlight(events, id)) return { action: 'wait', run: id, reason: 'retry run in flight' };
      // The retry is a new run linked by retryOf. If it finished, this original run is handled.
      if (events.some(e => e && e.kind === 'run' && e.retryOf === id && e.status === 'complete')) return null;
      return { action: 'block', run: id, id: `failed-${id}`, text: `Run ${id} still has failed jobs after one retry: swarm inspect ${id} --results` };
    }
    // A retry run is never retried again, so a run that keeps failing cannot start a chain of retries.
    if (isRetry) return { action: 'block', run: id, id: `failed-${id}`, text: `Retry run ${id} still has failed jobs: swarm inspect ${id} --results` };
    if (failedCount >= 1) return { action: 'retry-failed', run: id, reason: `${failedCount} failed job(s)` };
  }

  return null;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

export function startReadyCooldownOpen(memory, nowMs) {
  const holdAt = memory.startReadyHoldAt;
  if (holdAt != null && Number.isFinite(holdAt) && nowMs - holdAt < START_READY_HOLD_BACKOFF_MS) return false;
  const last = memory.startReadyLastAt;
  if (last == null || !Number.isFinite(last)) return true;
  const elapsed = nowMs - last;
  if (elapsed < START_READY_MIN_MS) return false;
  if ((memory.startReadyLastLiveAt ?? 0) > last) return true;
  return elapsed >= START_READY_STALE_MS;
}

function noteStartReadyLive(memory, nowMs, { live, busy, runs }) {
  const hasLiveRun = (Array.isArray(live) && live.length > 0) || runs.some(r => r.status === 'running');
  const hasBusy = Array.isArray(busy) && busy.some(m => m != null && m !== false);
  if (hasLiveRun || hasBusy) memory.startReadyLastLiveAt = nowMs;
}

export function integrateCheckoutDirtyFromPorcelain(stdout) {
  const lines = filterGeneratedStatus(String(stdout ?? '').split('\n'));
  return lines.some(line => {
    const code = line.length >= 2 ? line.slice(0, 2) : '';
    if (code === '??' || code.startsWith('?')) return false;
    return Boolean(line.trim());
  });
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

function jobListFromSaved(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function jobIsComplete(job) {
  return job && (job.status === 'complete' || job.state === 'complete');
}

/** Drop absolute paths, `..`, and anything that resolves outside `projectRoot`. */
export function filterValidIntegrateOutputPaths(paths, projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    return (Array.isArray(paths) ? paths : []).map(String).filter(p => typeof p === 'string' && p && !path.isAbsolute(p) && !p.split(/[/\\]/).includes('..'));
  }
  const rootResolved = path.resolve(projectRoot);
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const rel = String(raw);
    if (!rel || path.isAbsolute(rel)) continue;
    const normalized = path.normalize(rel);
    if (normalized.startsWith('..') || normalized.split(/[/\\]/).includes('..')) continue;
    const resolved = path.resolve(rootResolved, normalized);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) continue;
    out.push(normalized.split(path.sep).join('/'));
  }
  return out;
}

const INTEGRATE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_RUN_FOLDER_JSON_BYTES = 2 * 1024 * 1024;

function isValidIntegrateRunId(runId) {
  return typeof runId === 'string'
    && runId
    && !runId.includes('..')
    && INTEGRATE_RUN_ID_RE.test(runId);
}

function lstatPathNotSymlink(filePath) {
  try {
    const st = lstatSync(filePath);
    return !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function readJsonFileNoSymlink(filePath) {
  let fd;
  try {
    fd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RUN_FOLDER_JSON_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) {
        if (error?.code !== 'EBADF') console.error('[tools/autopilot.mjs] readJsonFileNoSymlink close:', error?.message ?? error);
      }
    }
  }
}

/** Default reader for saved run folder `state.json` / `manifest.json` (never throws). */
export function defaultReadRunFolderSources(root, runId) {
  if (!root || !isValidIntegrateRunId(runId)) return { state: null, manifest: null };
  const swarmDir = path.join(root, '.swarm');
  const runsDir = path.join(swarmDir, 'runs');
  if (!lstatPathNotSymlink(swarmDir) || !lstatPathNotSymlink(runsDir)) {
    return { state: null, manifest: null };
  }
  const runDir = path.join(runsDir, runId);
  if (!lstatPathNotSymlink(runDir)) return { state: null, manifest: null };
  return {
    state: readJsonFileNoSymlink(path.join(runDir, 'state.json')),
    manifest: readJsonFileNoSymlink(path.join(runDir, 'manifest.json')),
  };
}

function collectFolderJobOutputs(jobs, { completeOnly } = {}) {
  const paths = [];
  const childRunIds = [];
  for (const job of jobListFromSaved(jobs)) {
    if (!job || typeof job !== 'object') continue;
    if (completeOnly && !jobIsComplete(job)) continue;
    if (Array.isArray(job.outputs) && job.outputs.length) paths.push(...job.outputs.map(String));
    const childId = job.childRun ?? job.child_run;
    if (isValidIntegrateRunId(childId)) childRunIds.push(childId);
  }
  return { paths, childRunIds };
}

function runFolderIntegrateOutputPaths(runId, root, readRunFolder, visited = new Set()) {
  if (!root || !isValidIntegrateRunId(runId) || visited.has(runId)) return [];
  visited.add(runId);
  const reader = typeof readRunFolder === 'function' ? readRunFolder : defaultReadRunFolderSources;
  let sources;
  try {
    sources = reader(root, runId);
  } catch {
    sources = { state: null, manifest: null };
  }
  let state = sources?.state;
  const manifest = sources?.manifest;
  if (state && typeof state.id === 'string' && state.id && !isValidIntegrateRunId(state.id)) {
    state = null;
  }
  const fromState = collectFolderJobOutputs(state?.jobs, { completeOnly: true });
  let paths = [...fromState.paths];
  const childIds = new Set(fromState.childRunIds);
  if (!paths.length) {
    const fromManifest = collectFolderJobOutputs(manifest?.jobs, { completeOnly: false });
    paths = [...fromManifest.paths];
    for (const id of fromManifest.childRunIds) childIds.add(id);
  } else {
    for (const job of jobListFromSaved(state?.jobs)) {
      const childId = job?.childRun ?? job?.child_run;
      if (isValidIntegrateRunId(childId)) childIds.add(childId);
    }
  }
  for (const childId of childIds) {
    paths.push(...runFolderIntegrateOutputPaths(childId, root, readRunFolder, visited));
  }
  return filterValidIntegrateOutputPaths(paths, root);
}

/** Declared integrate output paths from manifest, run jobs, lead-job child runs, and saved run files. */
export function runIntegrateOutputPaths(run, events, { runs, root, readRunFolder } = {}) {
  const manifest = runManifest(run, events);
  const paths = [];
  const visitedChildRuns = new Set();

  function collectFromJobs(jobs) {
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (!job || typeof job !== 'object') continue;
      if (Array.isArray(job.outputs) && job.outputs.length) paths.push(...job.outputs.map(String));
      const childId = job.childRun ?? job.child_run;
      if (typeof childId !== 'string' || !childId || visitedChildRuns.has(childId)) continue;
      visitedChildRuns.add(childId);
      const child = (Array.isArray(runs) ? runs : []).find(r => r && r.id === childId);
      if (!child) continue;
      const childManifest = runManifest(child, events);
      collectFromJobs(jobsFromRun(child, childManifest));
    }
  }

  collectFromJobs(jobsFromRun(run, manifest));
  let validated = filterValidIntegrateOutputPaths(paths, root);
  if (!validated.length && root && isValidIntegrateRunId(run?.id)) {
    validated = runFolderIntegrateOutputPaths(run.id, root, readRunFolder);
  }
  return [...new Set(validated)].sort();
}

function runHasCompleteJob(run) {
  if (!run || typeof run !== 'object') return false;
  const complete = Number(run.counts?.complete);
  if (Number.isFinite(complete) && complete > 0) return true;
  const raw = run.jobs;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  return list.some(job => job && (job.status === 'complete' || job.state === 'complete'));
}

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
    } catch (error) {
      console.error('[tools/autopilot.mjs] resolveIntegrateCheckoutView override:', error?.message ?? error);
    }
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
  } catch (error) {
    console.error('[tools/autopilot.mjs] resolveIntegrateCheckoutView fallback:', error?.message ?? error);
  }
  return checkout;
}

// Every once-only rule (one retry, one start per wave, no repeated integration) is read from the journal.
// So the step fails closed: a journal that cannot be read or written means no actions, never a repeat of
// paid work. `memory` also remembers what this process already did, whatever the journal says.
// Integration only runs from a swarm/* branch or a linked worktree that is not main/master, and only when
// there is no uncommitted work. Anything else (or a checkout that cannot be read) becomes a blocker.
export function integrationBlocker(checkout, { outputPaths = [] } = {}) {
  if (!checkout || typeof checkout !== 'object') return 'the checkout could not be inspected';
  const branch = typeof checkout.branch === 'string' ? checkout.branch : '';
  if (!branch) return 'the checkout is not on a branch';
  if (branch === 'main' || branch === 'master') return `the checkout is on ${branch}`;
  if (!branch.startsWith('swarm/') && checkout.linkedWorktree !== true) {
    return `the checkout is on ${branch}, not a swarm/* branch or its own worktree`;
  }
  if (checkout.mergeInProgress === true) return 'a merge is in progress in the checkout';
  if (checkout.cherryPickInProgress === true) return 'a cherry-pick is in progress in the checkout';
  if (checkout.revertInProgress === true) return 'a revert is in progress in the checkout';
  if (checkout.rebaseInProgress === true) return 'a rebase is in progress in the checkout';
  const unmerged = Array.isArray(checkout.unmergedPaths) ? checkout.unmergedPaths : [];
  if (unmerged.length) {
    return `the checkout has unmerged paths${formatDirtyListing(unmerged)}`;
  }
  const collisions = Array.isArray(checkout.integrateCollisions)
    ? checkout.integrateCollisions
    : [];
  if (collisions.length) {
    return `the checkout has local changes on integrate output path(s)${formatDirtyListing(collisions)}`;
  }
  const trackedDirty = Array.isArray(checkout.integrateTrackedDirty) ? checkout.integrateTrackedDirty : [];
  if (trackedDirty.length) {
    return `the checkout has uncommitted tracked changes${formatDirtyListing(trackedDirty.map(e => e.path ?? e))}; commit or move them before integrating`;
  }
  if (checkout.dirty !== false) return 'the checkout has uncommitted changes (or could not be checked)';
  return null;
}

export async function autopilotStep(root, deps, { now = Date.now, memory = new Set(), legacyPlan = false } = {}) {
  const nowFn = typeof now === 'function' ? now : () => nowValue(now);
  const nowMs = nowFn();
  const mem = memory && typeof memory === 'object' ? memory : {};
  let pollObserveContext = null;
  let pollDigestBefore = null;
  try {
    if (typeof deps.readyTickets === 'function') {
      const observeRuns = (await safe(() => deps.loadRuns(root), [])).slice(0, MAX_RUNS);
      let live = [];
      let busy = [];
      let observeDepError = false;
      if (typeof deps.liveRuns === 'function') {
        try { live = await deps.liveRuns(root); if (!Array.isArray(live)) live = []; } catch { observeDepError = true; live = []; }
      }
      if (typeof deps.busyMarkers === 'function') {
        try { busy = await deps.busyMarkers(); if (!Array.isArray(busy)) busy = []; } catch { observeDepError = true; busy = []; }
      }
      pollObserveContext = { live, busy, runs: observeRuns, depError: observeDepError };
      if (!observeDepError) noteStartReadyLive(mem, nowMs, pollObserveContext);
    }
    const pollSnapshot = await buildAutopilotPollDigest(root, deps, {
      now: nowFn, legacyPlan, memory: mem, observeContext: pollObserveContext,
    });
    pollDigestBefore = pollSnapshot?.digest ?? null;
    const storedDigest = pollDigestBefore ? await readAutopilotPollDigest(root) : null;
    if (pollSnapshot?.idle && pollDigestBefore && storedDigest !== null && storedDigest === pollDigestBefore) {
      return {
        actions: [],
        blocked: [],
        idle: true,
        stepWroteJournal: false,
        pollUnchanged: true,
      };
    }
  } catch (error) {
    console.error('[tools/autopilot.mjs] autopilot poll digest:', error?.message ?? error);
  }
  let loadedEvents;
  try { loadedEvents = await deps.readJournal(root); }
  catch (error) { return { actions: [], blocked: [], idle: true, error: `journal-unreadable: ${String(error?.message ?? error).slice(0, 200)}` }; }
  const events = Array.isArray(loadedEvents) ? [...loadedEvents] : [];
  let journalBroken = null;
  const loadedRuns = await safe(() => deps.loadRuns(root), []);
  const runs = (Array.isArray(loadedRuns) ? loadedRuns : []).slice(0, MAX_RUNS);
  const plan = await safe(() => deps.readPlan(root), null);
  const actions = [];
  const blocked = [];
  const perRun = new Map();
  let stepWroteJournal = false;
  // Tickets that were only waiting on dependencies become ready again, whatever else happens this pass.
  if (typeof deps.unlockTickets === 'function') {
    const unlocked = await safe(() => deps.unlockTickets(root), []);
    if (Array.isArray(unlocked) && unlocked.length) {
      const result = `${unlocked.length} ticket(s) ready: ${unlocked.slice(0, 8).join(', ')}`;
      await write({ kind: 'action', action: 'unlock-tickets', reason: 'dependencies are done', result });
      actions.push({ action: 'unlock-tickets', ok: true, result });
    }
  }

  async function write(event, { incidental = false } = {}) {
    if (!incidental) stepWroteJournal = true;
    try { await deps.appendEvent(root, event); }
    catch (error) { journalBroken ??= `journal-unwritable: ${String(error?.message ?? error).slice(0, 200)}`; }
    events.push({ ...event, ts: new Date(nowMs).toISOString() });
  }

  async function resolveIntegrateBlockersForRun(runId, { resolvedBy, integrateCause = null, allowPartial = false, force = false } = {}) {
    const runRecord = runs.find(r => r.id === runId);
    if (!force && !allowPartial && runRecord && !runCountsAsIntegrated(runRecord)) return;
    for (const integrateKind of ['integrate', 'integrate-checkout']) {
      const candidates = events.filter(event => event?.kind === 'blocker' && event.resolved !== true
        && (event.integrateRun === runId || integrateBlockerRunIdFromId(event.id) === runId)
        && (integrateBlockerKindFromId(event.id) === integrateKind || event.integrateKind === integrateKind));
      for (const prior of candidates) {
        const kind = prior.integrateKind ?? integrateBlockerKindFromId(prior.id);
        if (!kind) continue;
        const cause = integrateCause ?? prior.integrateCause ?? prior.text ?? '';
        await write(integrateBlockerResolutionEvent(prior, { integrateKind: kind, integrateRun: runId, integrateCause: cause, resolvedBy }));
      }
    }
  }

  async function raiseIntegrateBlocker(draft) {
    const integrateKind = draft.integrateKind;
    const integrateRun = draft.integrateRun ?? draft.run;
    const integrateCause = draft.integrateCause ?? draft.text ?? '';
    const id = draft.id ?? integrateBlockerId(integrateKind, integrateRun, integrateCause);
    if (integrateBlockerSuppressed(events, { id, integrateKind, integrateRun, integrateCause }, { now: nowFn })) return false;
    if (openBlockerIds(events).has(id)) return false;
    const payload = {
      kind: 'blocker',
      id,
      text: draft.text,
      ...integrateBlockerFields({ integrateKind, integrateRun, integrateCause }),
    };
    if (typeof deps.appendIntegrateBlockerIfNeeded === 'function') {
      let out;
      try { out = await deps.appendIntegrateBlockerIfNeeded(root, payload, { now: nowFn }); }
      catch { return false; }
      if (!out?.appended) return false;
      events.push({ ...payload, ts: new Date(nowMs).toISOString() });
      blocked.push(id);
      return true;
    }
    await write(payload);
    blocked.push(id);
    return true;
  }

  async function execute(decision) {
    const runId = decision.run;
    const key = `${decision.action}:${runId}`;
    if (['integrate', 'retry-failed'].includes(decision.action)) {
      if (memory.has(key)) return { action: decision.action, run: runId, reason: decision.reason, ok: false, result: 'already done by this autopilot process' };
      memory.add(key);
    }
    let ok = true;
    let message = 'ok';
    try {
      if (decision.action === 'integrate') {
        const out = await deps.integrate(root, runId);
        const integrationIncomplete = out?.status === 'partial' || out?.integrationStatus === 'partial' || out?.integrationStatus === 'queued' || out?.integrationStatus === 'failed-check';
        const integrationComplete = !integrationIncomplete;
        await write({
          kind: 'integration',
          run: runId,
          status: integrationComplete ? 'complete' : 'partial',
          ...(Number.isFinite(out?.files) ? { files: out.files } : {}),
        });
        if (integrationComplete) await resolveIntegrateBlockersForRun(runId, { resolvedBy: 'integrate', force: true });
      } else if (decision.action === 'resume') await deps.resume(root, runId);
      else if (decision.action === 'retry-failed') {
        const out = await deps.retryFailed(root, runId);
        if (typeof out?.run === 'string') await write({ kind: 'run', id: out.run, status: out.status ?? 'running', retryOf: runId });
      } else throw new Error(`unknown-action: ${decision.action}`);
    } catch (error) {
      ok = false;
      message = String(error?.message ?? error);
    }
    const result = ok ? 'ok' : message.slice(0, RESULT_LIMIT);
    await write({ kind: 'action', action: decision.action, run: runId, reason: decision.reason, result });
    return { action: decision.action, run: runId, reason: decision.reason, ok, result };
  }

  // Keep the journal's idea of each run current, so waves and the brief see status changes even for
  // runs that were started outside autopilot.
  for (const run of runs) {
    const history = events.filter(e => e && e.kind === 'run' && e.id === run.id);
    const last = history[history.length - 1];
    if (last?.status === run.status) continue;
    const manifest = history.find(e => e.manifest)?.manifest;
    const retryOf = history.find(e => e.retryOf)?.retryOf;
    await write({ kind: 'run', id: run.id, status: run.status, ...(run.counts ? { counts: run.counts } : {}), ...(Number.isFinite(run.costUsd) ? { costUsd: run.costUsd } : {}), ...(manifest ? { manifest } : {}), ...(retryOf ? { retryOf } : {}) }, { incidental: true });
    if (runCountsAsIntegrated(run)) {
      await resolveIntegrateBlockersForRun(run.id, { resolvedBy: 'integrate' });
    } else if (['cancelled', 'abandoned'].includes(run.status)) {
      await resolveIntegrateBlockersForRun(run.id, { resolvedBy: run.status === 'cancelled' ? 'cancel' : 'abandoned', allowPartial: true });
    }
  }

  const integrateCtx = { runs, root, readRunFolder: deps.readRunFolder };

  if (!journalBroken) {
    const open = openIds(events);
    for (const run of runs) {
      const nonIntegrating = run.integrable === false
        || runSkipsIntegrateAttention(run, events, integrateCtx)
        || (run.status === 'failed' && !runHasCompleteJob(run))
        || ['cancelled', 'abandoned'].includes(run.status);
      if (!nonIntegrating) continue;
      for (const id of open) {
        if (integrateBlockerRunId(id) !== run.id) continue;
        const kind = integrateBlockerKindFromId(id);
        if (kind !== 'integrate' && kind !== 'integrate-checkout') continue;
        const prior = latestBlockerEvent(events, id);
        await write(integrateBlockerResolutionEvent(prior ?? { id, text: '' }, {
          integrateKind: kind ?? 'integrate',
          integrateRun: run.id,
          integrateCause: prior?.integrateCause ?? prior?.text ?? '',
          resolvedBy: 'non-integrable',
        }));
      }
    }
  }

  for (const run of runs) {
    if (journalBroken) break;
    if (runSkipsIntegrateAttention(run, events, integrateCtx)) continue;
    const count = perRun.get(run.id) ?? 0;
    if (count >= MAX_ACTIONS_PER_RUN) continue;
    const decision = decide(run, { now: nowMs, events, plan, manifest: runManifest(run, events), runs });
    if (!decision || decision.action === 'wait') continue;
    if (decision.action === 'block') {
      if (decision.integrateKind) {
        await raiseIntegrateBlocker({
          id: decision.id,
          text: decision.text,
          integrateKind: decision.integrateKind,
          integrateRun: decision.run,
          integrateCause: decision.integrateCause ?? decision.text,
        });
      } else if (!openIds(events).has(decision.id)) {
        await write({ kind: 'blocker', id: decision.id, text: decision.text });
        blocked.push(decision.id);
      }
      continue;
    }
    if (decision.action === 'integrate') {
      if (runSkipsIntegrateAttention(run, events, integrateCtx) || run.integrable === false) continue;
      const outputPaths = runIntegrateOutputPaths(run, events, integrateCtx);
      const manifest = runManifest(run, events);
      const jobs = jobsFromRun(run, manifest);
      const hasIntegratableJobs = integrableFromJobs(jobs)
        || (run.integrable === true && runHasCompleteJob(run));
      if (hasIntegratableJobs && outputPaths.length === 0) {
        const text = `Run ${run.id} is complete but not integrated: integratable jobs are present but no output paths could be resolved from the run manifest or job state. Inspect the run and fix job outputs, then run: swarm integrate ${run.id}`;
        await raiseIntegrateBlocker({
          id: `integrate-checkout-${run.id}`,
          text,
          integrateKind: 'integrate-checkout',
          integrateRun: run.id,
          integrateCause: 'integratable jobs have no declared output paths',
        });
        continue;
      }
      let checkout = null;
      try { checkout = await deps.checkout(root); } catch { checkout = null; }
      const checkoutView = await resolveIntegrateCheckoutView(root, checkout, outputPaths, deps);
      const why = integrationBlocker(checkoutView, { outputPaths });
      if (why) {
        const integrateCause = why;
        const text = `Run ${run.id} is complete but not integrated: ${why}. Move to a swarm/* branch with a clean tree, then run: swarm integrate ${run.id}`;
        await raiseIntegrateBlocker({
          id: `integrate-checkout-${run.id}`,
          text,
          integrateKind: 'integrate-checkout',
          integrateRun: run.id,
          integrateCause,
        });
        continue;
      }
    }
    // A failed job is classified before it is retried. Only the verdict is used here: needs-human becomes a blocker for the
    // owner (an inbox item) instead of a retry; the hint is for the owner's eyes and is never put into a prompt.
    // A run with an open triage blocker is the owner's to look at; it is not triaged again every step.
    if (decision.action === 'retry-failed' && [...openIds(events)].some(id => id.startsWith(`triage-${run.id}-`))) continue;
    if (decision.action === 'retry-failed' && typeof deps.triage === 'function') {
      const verdicts = await safe(() => deps.triage(root, run.id), []);
      const list = Array.isArray(verdicts) ? verdicts : [];
      if (list.length) await write({ kind: 'action', action: 'triage', run: run.id, reason: list.map(v => `${v.job}:${v.verdict}`).join(' ').slice(0, 300), result: 'ok' });
      const human = list.filter(v => v && v.verdict === 'needs-human');
      if (human.length) {
        for (const v of human) {
          const id = `triage-${run.id}-${v.job}`;
          if (!openIds(events).has(id)) {
            await write({ kind: 'blocker', id, text: `Job ${v.job} of run ${run.id} needs a person (local triage): swarm inspect ${run.id} --results${v.hint ? `. Hint (untrusted): ${String(v.hint).slice(0, 200)}` : ''}` });
            blocked.push(id);
          }
        }
        continue;
      }
    }
    perRun.set(run.id, count + 1);
    actions.push(await execute(decision));
  }

  const wave = journalBroken || !legacyPlan ? null : nextWave(events, plan);
  if (wave && !memory.has(`start-wave:${wave.id}`)) {
    memory.add(`start-wave:${wave.id}`);
    let manifestInfo = null;
    if (typeof deps.readCoordinationManifest === 'function') {
      manifestInfo = await safe(() => deps.readCoordinationManifest(root, wave.manifest), null);
    }
    const existing = typeof deps.existingRunWork === 'function'
      ? await safe(() => deps.existingRunWork(root, runs), [])
      : [];
    const skip = legacyWaveAlreadyRun({
      manifest: manifestInfo?.manifest ?? null,
      manifestMtimeMs: manifestInfo?.mtimeMs,
      existing,
    });
    if (skip) {
      await write({ kind: 'action', action: 'start-wave', wave: wave.id, reason: 'already-run', result: 'ok' });
      actions.push({ action: 'start-wave', wave: wave.id, ok: true, result: 'ok', reason: 'already-run' });
    } else {
      let ok = true;
      let message = 'ok';
      try {
        const out = await deps.startWave(root, wave);
        if (typeof out?.run === 'string') await write({ kind: 'run', id: out.run, status: out.status ?? 'running', manifest: wave.manifest });
      } catch (error) {
        ok = false;
        message = String(error?.message ?? error);
      }
      const result = ok ? 'ok' : message.slice(0, RESULT_LIMIT);
      await write({ kind: 'action', action: 'start-wave', wave: wave.id, reason: 'dependencies complete', result });
      actions.push({ action: 'start-wave', wave: wave.id, ok, result });
    }
  }

  // Jobs that waited for human tasks start once every task is done and the run that held them is integrated.
  if (legacyPlan && !journalBroken && typeof deps.humanGroups === 'function') {
    const groups = await safe(() => deps.humanGroups(root), []);
    const integratedIds = new Set(events.filter(e => e && e.kind === 'integration' && (e.status === 'complete' || e.status === 'integrated')).map(e => e.run));
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || group.started || !Array.isArray(group.humans) || !group.humans.length || !group.humans.every(h => h.done) || !group.hasDeferred) continue;
      const run = runs.find(r => r.id === group.id);
      if (!group.runless && !(run?.status === 'complete' && (run.integrated === true || integratedIds.has(group.id)))) continue;
      const key = `start-deferred:${group.id}`;
      if (memory.has(key) || actions.filter(x => x.action === 'start-deferred').length >= 1) continue;
      // Same gate as integration and backlog starts: a clean swarm/* branch, and nothing running.
      if (runs.some(r => r.status === 'running')) continue;
      let safeCheckout = false;
      try { safeCheckout = integrationBlocker(await deps.checkout(root)) === null; } catch { safeCheckout = false; }
      if (!safeCheckout) continue;
      memory.add(key);
      let ok = true;
      let message = 'ok';
      try {
        const out = await deps.startDeferred(root, group);
        if (typeof out?.run === 'string') await write({ kind: 'run', id: out.run, status: out.status ?? 'running', deferredFrom: group.id });
      } catch (error) { ok = false; message = String(error?.message ?? error); }
      const result = ok ? 'ok' : message.slice(0, RESULT_LIMIT);
      await write({ kind: 'action', action: 'start-deferred', run: group.id, reason: 'human jobs done', result });
      actions.push({ action: 'start-deferred', run: group.id, ok, result });
      if (!ok) await write({ kind: 'blocker', id: `deferred-${group.id}`, text: `Jobs held for human tasks of run ${group.id} could not start: ${result}. They are saved in .swarm/project/human-jobs.json` });
    }
  }

  // Never sit idle: when every live run is waiting (on a person or a quota window), start the next backlog goal.
  if (legacyPlan && !journalBroken && typeof deps.nextBacklog === 'function' && !actions.some(x => ['start-deferred', 'start-backlog'].includes(x.action))) {
    // Waiting means a quota window or an open human task. A run paused on a spend cap is the owner's call, not idle time.
    const capped = r => (r.pause?.reasons ?? []).some(reason => ['run-cap', 'child-paused', 'lane-cap'].includes(reason));
    const groupsWaiting = typeof deps.humanGroups === 'function' && (await safe(() => deps.humanGroups(root), [])).some(group => !group.started && group.humans?.some(human => !human.done));
    const waiting = runs.some(r => r.status === 'paused' && !capped(r)) || groupsWaiting;
    const running = runs.some(r => r.status === 'running');
    if (waiting && !running) {
      let safeCheckout = false;
      try { safeCheckout = integrationBlocker(await deps.checkout(root)) === null; } catch { safeCheckout = false; }
      const item = safeCheckout ? await safe(() => deps.nextBacklog(root, runs), null) : null;
      const key = item ? `start-backlog:${item.id}` : null;
      if (item && !memory.has(key)) {
        memory.add(key);
        let ok = true;
        let message = 'ok';
        try {
          const out = await deps.startBacklog(root, item);
          if (typeof out?.run === 'string') await write({ kind: 'run', id: out.run, status: out.status ?? 'running', backlog: item.id });
        } catch (error) { ok = false; message = String(error?.message ?? error); }
        const result = ok ? 'ok' : message.slice(0, RESULT_LIMIT);
        await write({ kind: 'action', action: 'start-backlog', reason: `backlog goal ${item.id}`, result });
        actions.push({ action: 'start-backlog', backlog: item.id, ok, result });
        if (!ok) await write({ kind: 'blocker', id: `backlog-${item.id}`, text: `Backlog goal ${item.id} could not start: ${result}` });
      }
    }
  }

  if (!journalBroken && typeof deps.readyTickets === 'function' && actions.length < MAX_ACTIONS_PER_RUN) {
    let ticketList;
    let approvalList = [];
    let depError = false;
    let readyTicketsError = false;
    try { ticketList = await deps.readyTickets(root); } catch { depError = true; readyTicketsError = true; ticketList = []; }
    if (!depError && typeof deps.pendingApprovals === 'function') {
      try { approvalList = await deps.pendingApprovals(root); } catch { depError = true; approvalList = []; }
    }
    const { startable, held } = pickReadyTickets({
      tickets: Array.isArray(ticketList) ? ticketList : [],
      approvals: Array.isArray(approvalList) ? approvalList : [],
    });
    let live = [];
    let busy = [];
    let capRoom = true;
    if (pollObserveContext?.depError) depError = true;
    if (!depError && pollObserveContext) {
      live = Array.isArray(pollObserveContext.live) ? pollObserveContext.live : [];
      busy = Array.isArray(pollObserveContext.busy) ? pollObserveContext.busy : [];
    } else if (!depError && typeof deps.liveRuns === 'function') {
      try {
        live = await deps.liveRuns(root);
        if (!Array.isArray(live)) live = [];
      } catch { depError = true; live = []; }
    }
    if (!depError && !pollObserveContext && typeof deps.busyMarkers === 'function') {
      try {
        busy = await deps.busyMarkers();
        if (!Array.isArray(busy)) busy = [];
      } catch { depError = true; busy = []; }
    }
    if (!depError && typeof deps.capRoom === 'function') {
      try { capRoom = await deps.capRoom(root); } catch { depError = true; capRoom = false; }
    }
    if (!depError) noteStartReadyLive(mem, nowMs, { live, busy, runs });

    const hasLiveRun = (Array.isArray(live) && live.length > 0) || runs.some(r => r.status === 'running');
    const hasBusy = Array.isArray(busy) && busy.some(m => m != null && m !== false);
    const cooldownOpen = startReadyCooldownOpen(memory, nowMs);
    const passIdle = actions.length === 0;

    if (passIdle && (startable.length || readyTicketsError) && (depError || startable.length)) {
      if (depError) {
        const reason = 'start-ready skipped';
        await write({ kind: 'action', action: 'start-ready', reason, result: 'dependency-error' });
        actions.push({ action: 'start-ready', ok: false, result: 'dependency-error', reason });
      } else if (cooldownOpen && !hasLiveRun && !hasBusy && capRoom !== false && typeof deps.startScope === 'function') {
        let workerSlots = null;
        if (typeof deps.workerSlots === 'function') {
          try { workerSlots = await deps.workerSlots(root); } catch { workerSlots = null; }
        }
        const freeSlots = Number.isInteger(workerSlots?.free) ? workerSlots.free
          : (Number.isInteger(workerSlots?.max) ? workerSlots.max : null);
        let doneTicketIds = new Set();
        if (typeof deps.readTickets === 'function') {
          const allTickets = await safe(() => deps.readTickets(root), []);
          doneTicketIds = new Set((Array.isArray(allTickets) ? allTickets : []).filter(t => t?.status === 'done').map(t => t.id));
        } else {
          doneTicketIds = new Set((Array.isArray(ticketList) ? ticketList : []).filter(t => t?.status === 'done').map(t => t.id));
        }
        const heldIds = new Set((held ?? []).map(t => t.id));
        let waveSettings = { skipSkeleton: false, maxJobs: freeSlots ?? 1 };
        if (typeof deps.autopilotStartReadySettings === 'function') {
          waveSettings = await safe(() => deps.autopilotStartReadySettings(root, { freeSlots }), waveSettings);
        }
        const slotLimit = Number.isInteger(waveSettings?.maxJobs) && waveSettings.maxJobs > 0
          ? waveSettings.maxJobs
          : (Number.isInteger(freeSlots) && freeSlots > 0 ? freeSlots : 1);
        const waveTickets = planWaveBatch(startable, { slots: slotLimit, doneTicketIds, heldIds });
        const ids = waveTickets.map(t => t.id).slice(0, 8);
        const reason = `${startable.length} startable ticket(s)${ids.length ? `: ${ids.join(', ')}` : ''}`;
        let ok = true;
        let result = 'ok';
        try {
          const readScopeLoopLock = typeof deps.readScopeLoopLock === 'function'
            ? deps.readScopeLoopLock
            : rootArg => readLockOwner(rootArg, 'scope-loop');
          const isAliveCheck = typeof deps.isAlive === 'function' ? deps.isAlive : defaultIsAlive;
          const lockOwner = await safe(() => readScopeLoopLock(root), null);
          const orphanedScopeLoop = lockOwner
            && Number.isInteger(lockOwner.pid)
            && lockOwner.pid > 0
            && isAliveCheck(lockOwner.pid)
            && !spawnedScopeLoopPids.has(lockOwner.pid);
          if (orphanedScopeLoop) {
            ok = true;
            result = 'held-orphaned-scope-loop';
          } else {
            if (typeof deps.waitBeforeLaunchingWork === 'function') await deps.waitBeforeLaunchingWork(root);
            const out = await deps.startScope({
              root,
              ticketIds: waveTickets.map(t => t.id),
              maxJobs: waveTickets.length || slotLimit,
              skipSkeleton: waveSettings?.skipSkeleton === true,
              batched: waveTickets.length > 1,
            });
            ok = out?.ok !== false;
            if (ok) {
              result = out?.result ?? 'ok';
              if (Number.isInteger(out?.pid) && out.pid > 0) spawnedScopeLoopPids.add(out.pid);
              if (result === 'held-memory') memory.startReadyHoldAt = nowMs;
              else memory.startReadyLastAt = nowMs;
            } else result = String(out?.result ?? 'failed').slice(0, RESULT_LIMIT);
          }
        } catch (error) {
          ok = false;
          result = String(error?.message ?? error).slice(0, RESULT_LIMIT);
        }
        if (ok && waveTickets.length > 1) {
          await write({ kind: 'note', text: `batched ${waveTickets.length} tickets into one wave` }, { incidental: true });
        }
        const startReadyIncidental = ok && (result === 'held-memory' || result === 'held-orphaned-scope-loop');
        await write({ kind: 'action', action: 'start-ready', reason, result }, { incidental: startReadyIncidental });
        actions.push({ action: 'start-ready', ok, result, reason });
      }
    }
  }

  if (deps.policyPass) {
    try { await executePolicyPass(root, deps, { now: nowMs }); } catch (error) {
      console.error('[tools/autopilot.mjs] policy pass:', error?.message ?? error);
    }
  }

  if (!journalBroken) {
    try { await runNeedsYouTriagePass(root, deps, { now: nowFn }); } catch (error) {
      console.error('[tools/autopilot.mjs] needs-you triage:', error?.message ?? error);
    }
  }

  if (typeof deps.notify === 'function') {
    try { await deps.notify(root); } catch (error) {
      console.error('[tools/autopilot.mjs] notify:', error?.message ?? error);
    }
  }

  if (!journalBroken) {
    try {
      const pollSnapshot = await buildAutopilotPollDigest(root, deps, {
        now: nowFn, legacyPlan, memory: mem, observeContext: pollObserveContext,
      });
      if (pollSnapshot?.digest) await writeAutopilotPollDigest(root, pollSnapshot.digest);
    } catch (error) {
      console.error('[tools/autopilot.mjs] write poll digest:', error?.message ?? error);
    }
  }

  return {
    actions,
    blocked,
    idle: actions.length === 0 && blocked.length === 0,
    ...(stepWroteJournal ? { stepWroteJournal } : {}),
    ...(journalBroken ? { error: journalBroken } : {}),
  };
}

async function defaultSleep(ms, signal) {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export const MIN_INTERVAL_MS = 5000;

export const AUTOPILOT_OFF_REL = path.join('.swarm', 'autopilot', 'off');

export function autopilotOffPath(root) {
  return path.join(root, AUTOPILOT_OFF_REL);
}

export async function isAutopilotOff(root) {
  try {
    await fs.access(autopilotOffPath(root));
    return true;
  } catch {
    return false;
  }
}

export async function setAutopilotOff(root, off) {
  const file = autopilotOffPath(root);
  if (off) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 }).catch(async error => {
      if (error?.code !== 'EEXIST') throw error;
    });
    return;
  }
  await fs.rm(file, { force: true });
}

const lockAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** `on` (enabled, idle), `off` (owner disabled), or `running` (a live autopilot holds the lock). */
export async function autopilotStatusForRoot(root, { isAlive = lockAlive } = {}) {
  if (await isAutopilotOff(root)) return 'off';
  const file = path.join(root, '.swarm', 'project', 'autopilot.lock');
  try {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && isAlive(owner.pid)) return 'running';
  } catch { /* no lock */ }
  return 'on';
}

/** Board/status idle rule: ready tickets, no live run, and free machine slots when max is known. */
export function computeIdleWithReady({ liveRunCount = 0, readyTickets = 0, freeMachineSlots = null } = {}) {
  if (liveRunCount > 0) return false;
  if (!(readyTickets > 0)) return false;
  if (freeMachineSlots !== null && freeMachineSlots !== undefined && freeMachineSlots <= 0) return false;
  return true;
}

export function countReadyTickets(ledger) {
  const list = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  return list.filter(t => t && t.status === 'ready').length;
}

const AUTOPILOT_POLL_DIGEST_FILE = path.join('.swarm', 'autopilot', 'last-poll-digest');

function stableDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function autopilotPollSnapshotIdle(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.wave) return false;
  for (const run of Array.isArray(payload.runs) ? payload.runs : []) {
    if ((run.journalStatus ?? null) !== (run.status ?? null)) return false;
    const action = run.decision?.action;
    if (action && action !== 'wait') return false;
  }
  const startReady = payload.startReady;
  if (startReady && !startReady.depError && startReady.startable > 0
    && startReady.cooldownOpen && !startReady.hasLiveRun && !startReady.hasBusy && startReady.capRoom) {
    return false;
  }
  return true;
}

function journalEventFinger(events) {
  const list = Array.isArray(events) ? events : [];
  return list.map(event => {
    if (!event || typeof event !== 'object') return null;
    const out = { kind: event.kind };
    if (event.id !== undefined) out.id = event.id;
    if (event.status !== undefined) out.status = event.status;
    if (event.action !== undefined) out.action = event.action;
    if (event.run !== undefined) out.run = event.run;
    if (event.resolved !== undefined) out.resolved = event.resolved;
    if (event.wave !== undefined) out.wave = event.wave;
    if (event.integrateKind !== undefined) out.integrateKind = event.integrateKind;
    if (event.integrateRun !== undefined) out.integrateRun = event.integrateRun;
    return out;
  });
}

export async function readAutopilotPollDigest(root) {
  try {
    const text = await fs.readFile(path.join(root, AUTOPILOT_POLL_DIGEST_FILE), 'utf8');
    const digest = text.trim();
    return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

export async function writeAutopilotPollDigest(root, digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return;
  const dir = path.join(root, '.swarm', 'autopilot');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(root, AUTOPILOT_POLL_DIGEST_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${digest}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Stable digest of autopilot inputs and pending decisions (no side effects). */
export async function buildAutopilotPollDigest(root, deps, { now = Date.now, legacyPlan = false, memory = null, observeContext = null } = {}) {
  const nowMs = typeof now === 'function' ? now() : nowValue(now);
  let events = [];
  try { events = await deps.readJournal(root); } catch { return null; }
  const eventList = Array.isArray(events) ? events : [];
  const loadedRuns = await safe(() => deps.loadRuns(root), []);
  const runs = (Array.isArray(loadedRuns) ? loadedRuns : []).slice(0, MAX_RUNS);
  const plan = await safe(() => deps.readPlan(root), null);
  const open = openIds(eventList);
  const runParts = [];
  for (const run of runs) {
    const history = eventList.filter(e => e && e.kind === 'run' && e.id === run.id);
    const last = history[history.length - 1];
    const decision = decide(run, {
      now: nowMs,
      events: eventList,
      plan,
      manifest: runManifest(run, eventList),
      runs,
    });
    runParts.push({
      id: run.id,
      status: run.status ?? null,
      integrated: run.integrated === true,
      integrable: run.integrable,
      counts: run.counts ?? null,
      pause: run.pause ?? null,
      journalStatus: last?.status ?? null,
      decision: decision
        ? {
          action: decision.action,
          run: decision.run ?? null,
          id: decision.id ?? null,
          integrateKind: decision.integrateKind ?? null,
        }
        : null,
    });
  }
  let startReady = null;
  if (typeof deps.readyTickets === 'function') {
    let ticketList = [];
    let approvalList = [];
    let depError = false;
    try { ticketList = await deps.readyTickets(root); } catch { depError = true; ticketList = []; }
    if (!depError && typeof deps.pendingApprovals === 'function') {
      try { approvalList = await deps.pendingApprovals(root); } catch { depError = true; approvalList = []; }
    }
    const { startable, held } = pickReadyTickets({
      tickets: Array.isArray(ticketList) ? ticketList : [],
      approvals: Array.isArray(approvalList) ? approvalList : [],
    });
    let live = [];
    let busy = [];
    let capRoom = true;
    const observed = observeContext && typeof observeContext === 'object' ? observeContext : null;
    if (observed?.depError) depError = true;
    if (!depError && observed && Array.isArray(observed.live)) {
      live = observed.live;
    } else if (!depError && typeof deps.liveRuns === 'function') {
      try { live = await deps.liveRuns(root); if (!Array.isArray(live)) live = []; } catch { depError = true; }
    }
    if (!depError && observed && Array.isArray(observed.busy)) {
      busy = observed.busy;
    } else if (!depError && typeof deps.busyMarkers === 'function') {
      try { busy = await deps.busyMarkers(); if (!Array.isArray(busy)) busy = []; } catch { depError = true; }
    }
    if (!depError && typeof deps.capRoom === 'function') {
      try { capRoom = await deps.capRoom(root); } catch { depError = true; capRoom = false; }
    }
    const mem = memory && typeof memory === 'object' ? memory : {};
    const hasLiveRun = (Array.isArray(live) && live.length > 0) || runs.some(r => r.status === 'running');
    const hasBusy = Array.isArray(busy) && busy.some(m => m != null && m !== false);
    startReady = {
      depError,
      startable: startable.length,
      held: (held ?? []).length,
      hasLiveRun,
      hasBusy,
      capRoom: capRoom !== false,
      cooldownOpen: startReadyCooldownOpen(mem, nowMs),
      lastAt: mem.startReadyLastAt ?? null,
      lastLiveAt: mem.startReadyLastLiveAt ?? null,
    };
  }
  const wave = legacyPlan ? nextWave(eventList, plan) : null;
  let unlockTickets = null;
  if (typeof deps.readTickets === 'function') {
    const tickets = await safe(() => deps.readTickets(root), []);
    unlockTickets = stableDigest(
      (Array.isArray(tickets) ? tickets : []).map(t => ({
        id: t?.id ?? null,
        status: t?.status ?? null,
        blockedBy: t?.blockedBy ?? null,
        dependsOn: t?.dependsOn ?? t?.deps ?? null,
      })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    );
  }
  let policyPass = null;
  const policyCfg = deps.policyPass;
  if (policyCfg && typeof policyCfg === 'object' && typeof policyCfg.loadRules === 'function') {
    const rules = await safe(() => policyCfg.loadRules(root), null);
    if (rules != null) {
      const listOpen = policyCfg.openRequests ?? policyCfg.listOpenRequests;
      if (typeof listOpen === 'function') {
        const items = await safe(() => listOpen(root), []);
        policyPass = stableDigest(
          filterPolicyPassItems(items).map(item => ({ kind: item.kind, id: item.id ?? null })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
        );
      }
    }
  }
  let notify = null;
  if (typeof deps.pendingNotifications === 'function') {
    const pending = await safe(() => deps.pendingNotifications(root), []);
    notify = stableDigest(Array.isArray(pending) ? pending : []);
  } else {
    notify = stableDigest(
      runs.map(r => ({ id: r.id, status: r.status ?? null, unblocks: r.unblocks ?? null })),
    );
  }
  const triage = stableDigest({
    failed: runs.filter(r => r.status === 'failed').map(r => ({
      id: r.id,
      counts: r.counts ?? null,
      handled: r.handled === true,
    })),
    openTriageBlockers: [...open].filter(id => id.startsWith('triage-')).sort(),
  });
  const payload = {
    v: 1,
    legacyPlan: Boolean(legacyPlan),
    events: journalEventFinger(eventList),
    openBlockers: [...open].sort(),
    runs: runParts,
    wave: wave?.id ?? null,
    startReady,
    unlockTickets,
    policyPass,
    notify,
    triage,
  };
  return { digest: stableDigest(payload), idle: autopilotPollSnapshotIdle(payload), payload };
}

export async function runAutopilot(root, deps, { intervalMs = 30000, once = false, maxSteps = Infinity, signal, sleep = defaultSleep, now = Date.now, legacyPlan = false } = {}) {
  const results = [];
  const memory = new Set();
  const wait = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
  while (!signal?.aborted && results.length < maxSteps) {
    // The panic button (swarm stop --all): a loop that is still alive stops at the next step instead of starting more work.
    if (await stopGuard(root).catch((error) => {
      console.error('[tools/autopilot.mjs] stopGuard check:', error?.message ?? error);
      return null;
    })) { results.push({ action: 'stopped', note: 'stopped: swarm stop --all marker present' }); break; }
    let step;
    try {
      try { await deps.busy?.begin?.(); } catch (error) {
        console.error('[tools/autopilot.mjs] busy begin:', error?.message ?? error);
      }
      step = await autopilotStep(root, deps, { now, memory, legacyPlan });
    } finally {
      try { await deps.busy?.end?.(); } catch (error) {
        console.error('[tools/autopilot.mjs] busy end:', error?.message ?? error);
      }
    }
    if (once && step && !step.stepWroteJournal) step.stepWroteJournal = false;
    noteAutopilotStep(root, step, { once });
    results.push(step);
    // A broken journal ends the loop: nothing it does could be remembered across steps by anyone else.
    if (step.error) break;
    if (once) break;
    if (signal?.aborted || results.length >= maxSteps) break;
    await sleep(wait, signal);
  }
  return results;
}
