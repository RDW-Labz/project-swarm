// SPDX-License-Identifier: Apache-2.0
export const ACTIONS = ['integrate', 'resume', 'retry-failed', 'start-wave', 'start-deferred', 'start-backlog'];

const MINUTE = 60_000;
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

export async function autopilotStep(root, deps, { now = Date.now, memory = new Set() } = {}) {
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
    perRun.set(run.id, count + 1);
    actions.push(await execute(decision));
  }

  const wave = journalBroken ? null : nextWave(events, plan);
  if (wave && !memory.has(`start-wave:${wave.id}`)) {
    memory.add(`start-wave:${wave.id}`);
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

  // Jobs that waited for human tasks start once every task is done and the run that held them is integrated.
  if (!journalBroken && typeof deps.humanGroups === 'function') {
    const groups = await safe(() => deps.humanGroups(root), []);
    const integratedIds = new Set(events.filter(e => e && e.kind === 'integration' && (e.status === 'complete' || e.status === 'integrated')).map(e => e.run));
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || group.started || !Array.isArray(group.humans) || !group.humans.length || !group.humans.every(h => h.done) || !group.hasDeferred) continue;
      const run = runs.find(r => r.id === group.id);
      if (!group.runless && !(run?.status === 'complete' && (run.integrated === true || integratedIds.has(group.id)))) continue;
      const key = `start-deferred:${group.id}`;
      if (memory.has(key) || actions.filter(x => x.action === 'start-deferred').length >= 1) continue;
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
    }
  }

  // Never sit idle: when every live run is waiting (on a person or a quota window), start the next backlog goal.
  if (!journalBroken && typeof deps.nextBacklog === 'function' && !actions.some(x => ['start-deferred', 'start-backlog'].includes(x.action))) {
    const waiting = runs.some(r => r.status === 'paused');
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

export async function runAutopilot(root, deps, { intervalMs = 30000, once = false, maxSteps = Infinity, signal, sleep = defaultSleep, now = Date.now } = {}) {
  const results = [];
  const memory = new Set();
  const wait = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
  while (!signal?.aborted && results.length < maxSteps) {
    const step = await autopilotStep(root, deps, { now, memory });
    results.push(step);
    // A broken journal ends the loop: nothing it does could be remembered across steps by anyone else.
    if (step.error) break;
    if (once) break;
    if (signal?.aborted || results.length >= maxSteps) break;
    await sleep(wait, signal);
  }
  return results;
}
