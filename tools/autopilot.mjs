// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';
import { stopGuard } from './stop-all.mjs';
import { matchesFile } from './handbuild.mjs';
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
    integrated: Boolean(state.integratedFiles?.length) || state.integrated === true,
    integrable: integrableFromJobs(state.jobs),
  };
}

function integrateBlockerRunId(blockerId) {
  if (typeof blockerId !== 'string') return null;
  if (blockerId.startsWith('integrate-checkout-')) return blockerId.slice('integrate-checkout-'.length);
  if (blockerId.startsWith('integrate-')) return blockerId.slice('integrate-'.length);
  return null;
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

  if (run.status === 'complete' && !run.integrated) {
    if (run.integrable === false) return null;
    const failures = actionEvents(events, 'integrate', id).filter(failedResult);
    if (failures.length) {
      const last = failures[failures.length - 1];
      const reason = typeof last.result === 'string' ? last.result : (last.result?.error ?? 'failed');
      return { action: 'block', run: id, id: `integrate-${id}`, text: `Integration of run ${id} needs a decision: ${reason}` };
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
    const retried = actionEvents(events, 'retry-failed', id).length > 0;
    const isRetry = events.some(e => e && e.kind === 'run' && e.id === id && e.retryOf);
    if (retried) {
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

function startReadyCooldownOpen(memory, nowMs) {
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

// Every once-only rule (one retry, one start per wave, no repeated integration) is read from the journal.
// So the step fails closed: a journal that cannot be read or written means no actions, never a repeat of
// paid work. `memory` also remembers what this process already did, whatever the journal says.
// Integration only runs from a swarm/* branch or a linked worktree that is not main/master, and only when
// there is no uncommitted work. Anything else (or a checkout that cannot be read) becomes a blocker.
export function integrationBlocker(checkout) {
  if (!checkout || typeof checkout !== 'object') return 'the checkout could not be inspected';
  const branch = typeof checkout.branch === 'string' ? checkout.branch : '';
  if (checkout.dirty !== false) return 'the checkout has uncommitted changes (or could not be checked)';
  if (!branch) return 'the checkout is not on a branch';
  if (branch === 'main' || branch === 'master') return `the checkout is on ${branch}`;
  if (!branch.startsWith('swarm/') && checkout.linkedWorktree !== true) return `the checkout is on ${branch}, not a swarm/* branch or its own worktree`;
  return null;
}

export async function autopilotStep(root, deps, { now = Date.now, memory = new Set(), legacyPlan = false } = {}) {
  const nowMs = nowValue(now);
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
  // Tickets that were only waiting on dependencies become ready again, whatever else happens this pass.
  if (typeof deps.unlockTickets === 'function') {
    const unlocked = await safe(() => deps.unlockTickets(root), []);
    if (Array.isArray(unlocked) && unlocked.length) {
      const result = `${unlocked.length} ticket(s) ready: ${unlocked.slice(0, 8).join(', ')}`;
      await write({ kind: 'action', action: 'unlock-tickets', reason: 'dependencies are done', result });
      actions.push({ action: 'unlock-tickets', ok: true, result });
    }
  }

  async function write(event) {
    try { await deps.appendEvent(root, event); }
    catch (error) { journalBroken ??= `journal-unwritable: ${String(error?.message ?? error).slice(0, 200)}`; }
    events.push({ ...event, ts: new Date(nowMs).toISOString() });
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
        await write({ kind: 'integration', run: runId, status: 'complete', ...(Number.isFinite(out?.files) ? { files: out.files } : {}) });
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
    await write({ kind: 'run', id: run.id, status: run.status, ...(run.counts ? { counts: run.counts } : {}), ...(Number.isFinite(run.costUsd) ? { costUsd: run.costUsd } : {}), ...(manifest ? { manifest } : {}), ...(retryOf ? { retryOf } : {}) });
  }

  if (!journalBroken) {
    const open = openIds(events);
    for (const run of runs) {
      if (run.integrable !== false) continue;
      for (const id of open) {
        if (integrateBlockerRunId(id) !== run.id) continue;
        const prior = latestBlockerEvent(events, id);
        await write({ kind: 'blocker', id, resolved: true, text: prior?.text ?? '' });
      }
    }
  }

  for (const run of runs) {
    if (journalBroken) break;
    const count = perRun.get(run.id) ?? 0;
    if (count >= MAX_ACTIONS_PER_RUN) continue;
    const decision = decide(run, { now: nowMs, events, plan });
    if (!decision || decision.action === 'wait') continue;
    if (decision.action === 'block') {
      if (!openIds(events).has(decision.id)) {
        await write({ kind: 'blocker', id: decision.id, text: decision.text });
        blocked.push(decision.id);
      }
      continue;
    }
    if (decision.action === 'integrate') {
      let checkout = null;
      try { checkout = await deps.checkout(root); } catch { checkout = null; }
      const why = integrationBlocker(checkout);
      if (why) {
        const id = `integrate-checkout-${run.id}`;
        if (!openIds(events).has(id)) {
          await write({ kind: 'blocker', id, text: `Run ${run.id} is complete but not integrated: ${why}. Move to a swarm/* branch with a clean tree, then run: swarm integrate ${run.id}` });
          blocked.push(id);
        }
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
    const { startable } = pickReadyTickets({
      tickets: Array.isArray(ticketList) ? ticketList : [],
      approvals: Array.isArray(approvalList) ? approvalList : [],
    });
    let live = [];
    let busy = [];
    let capRoom = true;
    if (!depError && typeof deps.liveRuns === 'function') {
      try {
        live = await deps.liveRuns(root);
        if (!Array.isArray(live)) live = [];
      } catch { depError = true; live = []; }
    }
    if (!depError && typeof deps.busyMarkers === 'function') {
      try {
        busy = await deps.busyMarkers();
        if (!Array.isArray(busy)) busy = [];
      } catch { depError = true; busy = []; }
    }
    if (!depError && typeof deps.capRoom === 'function') {
      try { capRoom = await deps.capRoom(root); } catch { depError = true; capRoom = false; }
    }
    if (!depError) noteStartReadyLive(memory, nowMs, { live, busy, runs });

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
        const ids = startable.map(t => t.id).slice(0, 8);
        const reason = `${startable.length} startable ticket(s)${ids.length ? `: ${ids.join(', ')}` : ''}`;
        let ok = true;
        let result = 'ok';
        try {
          const out = await deps.startScope({ root });
          ok = out?.ok !== false;
          if (ok) {
            result = out?.result ?? 'ok';
            memory.startReadyLastAt = nowMs;
          } else result = String(out?.result ?? 'failed').slice(0, RESULT_LIMIT);
        } catch (error) {
          ok = false;
          result = String(error?.message ?? error).slice(0, RESULT_LIMIT);
        }
        await write({ kind: 'action', action: 'start-ready', reason, result });
        actions.push({ action: 'start-ready', ok, result, reason });
      }
    }
  }

  if (typeof deps.notify === 'function') { try { await deps.notify(root); } catch { /* a notifier never stops the loop */ } }

  return { actions, blocked, idle: actions.length === 0 && blocked.length === 0, ...(journalBroken ? { error: journalBroken } : {}) };
}

async function defaultSleep(ms, signal) {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export const MIN_INTERVAL_MS = 5000;

export async function runAutopilot(root, deps, { intervalMs = 30000, once = false, maxSteps = Infinity, signal, sleep = defaultSleep, now = Date.now, legacyPlan = false } = {}) {
  const results = [];
  const memory = new Set();
  const wait = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
  while (!signal?.aborted && results.length < maxSteps) {
    // The panic button (swarm stop --all): a loop that is still alive stops at the next step instead of starting more work.
    if (await stopGuard(root).catch(() => null)) { results.push({ action: 'stopped', note: 'stopped: swarm stop --all marker present' }); break; }
    let step;
    try {
      try { await deps.busy?.begin?.(); } catch { /* marker must never stop the loop */ }
      step = await autopilotStep(root, deps, { now, memory, legacyPlan });
    } finally {
      try { await deps.busy?.end?.(); } catch { /* marker must never stop the loop */ }
    }
    results.push(step);
    // A broken journal ends the loop: nothing it does could be remembered across steps by anyone else.
    if (step.error) break;
    if (once) break;
    if (signal?.aborted || results.length >= maxSteps) break;
    await sleep(wait, signal);
  }
  return results;
}
