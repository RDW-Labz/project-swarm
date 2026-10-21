// SPDX-License-Identifier: Apache-2.0
import {
  buildProgressStats,
  isHumanTicket,
  isLiveTicket,
  ledgerBuildSummary,
  waveBlockingCount,
  waveBlockingTicketIds,
  wavePlanningTickets,
} from './human-progress.mjs';
// `swarm go --scope` as a loop: wave after wave until the ledger is finished or something needs the owner.
// Each wave does what the owner used to do by hand: build the wave, run it, integrate and commit it (go), move the tickets (scope sync),
// mark the integrated ones done (scope sync --integrated) and run the security / acceptance reviews that step asks for.
// Every effect is injected, so the loop is tested with fakes and no model call.

export const DEFAULT_MAX_WAVES = 50;
const STALL_WAVES = 4;               // waves in a row that finish no ticket
const REVIEW_ROUNDS = 3;             // review runs per integrated run before it is left for the owner
const REVIEW_FILE = /swarm run (\.swarm\/(security|acceptance)-reviews\/[A-Za-z0-9._-]+\.json)/g;

const reviewRunOnTicket = ticket => ticket?.reviewRunId
  ?? ticket?.reviewRun
  ?? ticket?.acceptanceReview?.runId
  ?? ticket?.securityReview?.runId
  ?? ticket?.review?.runId
  ?? (Array.isArray(ticket?.reviewRuns) && ticket.reviewRuns.length ? ticket.reviewRuns.at(-1) : null);

const safeReviewId = value => String(value ?? 'review').replace(/[^A-Za-z0-9._-]+/g, '-') || 'review';

function reviewPathFromError(message) {
  const text = String(message ?? '');
  const explicit = text.match(/\bpath\s*(?:is|=|:)?\s*["'`]?([^\s"'`,;)]+)["'`]*/i)?.[1];
  if (explicit) return explicit.replace(/[.)]+$/, '');
  return [...text.matchAll(/["'`]([^"'`\n]*\/[^"'`\n]*)["'`]/g)][0]?.[1]
    ?? [...text.matchAll(/(?:^|\s)((?:\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]+)/g)][0]?.[1];
}

const reviewStartText = (ticketId, error) => {
  const reason = String(error?.message ?? error).split('\n')[0].slice(0, 400);
  const path = reviewPathFromError(reason);
  return `${ticketId}: review could not start: ${reason}${path ? ` (path ${path})` : ''}`;
};

export const WAVE_STOPS = Object.freeze(['complete', 'waiting-human', 'stuck', 'paused', 'stopped', 'cap', 'failed', 'no-progress', 'max-waves']);

export { waveBlockingCount };

/** Live tickets for wave simulation (human tickets omitted; human deps stripped). */
export function wavePlanningLedger(ledger) {
  return wavePlanningTickets(ledger?.tickets ?? []);
}

/** Non-human tickets that block wave planning. */
export function waveBlockingIds(ledger) {
  return waveBlockingTicketIds(ledger?.tickets ?? []);
}

export function ledgerSummary(ledger) {
  const tickets = ledger?.tickets ?? [];
  const live = tickets.filter(isLiveTicket);
  const build = ledgerBuildSummary(ledger);
  const humanLive = live.filter(isHumanTicket);
  const humanDone = humanLive.filter((t) => t.status === 'done').length;
  const humanReady = humanLive.filter((t) => t.status === 'ready' || t.status === 'todo').length;
  const { percentDone } = buildProgressStats(tickets);
  const human = { open: build.humans, done: humanDone, total: humanLive.length };
  const summary = {
    total: live.length,
    done: build.done,
    ready: build.ready + humanReady,
    running: build.running,
    review: build.review,
    blocked: build.blocked,
    humans: build.humans,
    proposed: build.proposed,
  };
  Object.defineProperty(summary, 'percentDone', { value: percentDone, enumerable: false });
  Object.defineProperty(summary, 'human', { value: human, enumerable: false });
  return summary;
}

// Why the loop cannot start another wave, read from the ledger and the error the wave builder gave.
export function classifyIdle(summary, error) {
  const buildTotal = summary.total - (summary.human?.total ?? 0);
  const buildDone = summary.done;
  if (buildTotal > 0 && buildDone === buildTotal && !summary.humans) return { status: 'complete', reason: `all ${buildTotal} tickets are done${summary.proposed ? `; ${summary.proposed} proposed ticket(s) wait for your approval (swarm tickets --status proposed)` : ''}` };
  const code = error?.code;
  if (code === 'scope-skeleton') return { status: 'stuck', reason: error.message };
  if (summary.humans > 0 && summary.running === 0 && summary.review === 0) return { status: 'waiting-human', reason: `${summary.humans} human ticket(s) need you (swarm tickets ID --set done); everything else that can run is done` };
  const parts = [summary.review && `${summary.review} in review`, summary.blocked && `${summary.blocked} blocked`, summary.running && `${summary.running} still marked running`].filter(Boolean);
  return { status: 'stuck', reason: `nothing is ready: ${parts.join(', ') || 'the remaining tickets wait on others'}` };
}

const CAP_CODES = new Set(['project-cap', 'project-cap-invalid', 'spend-cap', 'resume-over-cap']);
const isCapStop = (text, code) => CAP_CODES.has(code) || /^(project-cap|spend-cap|resume-over-cap)/.test(String(text ?? ''));
const isStopMarker = (text, code) => code === 'stopped' || /^stopped:/.test(String(text ?? ''));
const isCancelled = text => /^run (cancelled|stopped)/.test(String(text ?? ''));
// A step that threw (a refused sync, a review run that failed or hit a cap) ends the loop with a named reason; nothing escapes without the final summary.
const stepStop = error => ({ status: isStopMarker(error?.message, error?.code) ? 'stopped' : error?.code === 'paused' ? 'paused' : isCapStop(error?.message, error?.code) ? 'cap' : 'failed', reason: String(error?.message ?? error).split('\n')[0].slice(0, 400) });

/**
 * deps:
 *   prepare()                   -> { file, ids } ; throws (with .code) when nothing is ready
 *   runWave(file)               -> go result { status, stage, runId, reason, integrate }
 *   sync(runId, { integrated }) -> text
 *   salvage(runId, n)           -> { integrated, jobs } integrates and commits the finished jobs of a run where some failed
 *   review(kind, file)          -> { runId } the review run, finished
 *   record(kind, runId)         -> text (scope security-review / acceptance-review RUNID)
 *   ledger()                    -> the ledger
 *   revert(ids)                 -> puts tickets still marked running for a wave that never started back to ready
 *   stopped()                   -> null | message
 *   log(text)
 */
export async function scopeLoop({ maxWaves = DEFAULT_MAX_WAVES, deps }) {
  const waves = [];
  // A successful review is recorded here before the next loop iteration. This is deliberately
  // separate from ticket.runId: that is the build run, not proof that a review was started.
  const reviewRecord = new Set();
  let resumeReviewNumber = 0;
  let stalled = 0;
  const finish = (status, reason, extra = {}) => ({ status, reason, waves, ...extra });
  const summaryNow = async () => ledgerSummary(await deps.ledger());

  const reviewContext = (tickets, source, waveId) => ({
    source,
    waveId,
    ticketIds: tickets.map(ticket => ticket.id),
    // The review dependency owns manifest creation. Passing a fresh snapshot on every start
    // prevents it from reusing a manifest generated for an earlier ticket context.
    tickets: tickets.map(ticket => ({ ...ticket })),
    generatedAt: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
  });

  const writeBlocker = async (id, text, ticket, waveId) => {
    const event = {
      event: 'blocker',
      id,
      text,
      ticket: ticket?.id,
      wave: waveId,
      at: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
    };
    try {
      const blocker = deps.blocker ?? deps.raiseBlocker;
      if (typeof blocker === 'function') {
        if (blocker.length <= 1) await blocker(event);
        else await blocker(id, text, event);
      }
      if (typeof deps.journal === 'function') await deps.journal(event);
      else if (typeof deps.log === 'function') deps.log(`blocker ${id}: ${text}`);
    } catch (error) {
      // A journal adapter must not turn a named review-start failure into an unhandled loop error.
      if (typeof deps.log === 'function') deps.log(`blocker ${id}: ${text}; journal failed: ${error.message}`);
    }
  };

  const reviewStartStop = async (error, ticket, waveId) => {
    const ordinary = stepStop(error);
    // Caps and explicit stop markers retain their existing loop semantics. A normal start
    // failure is different: it is actionable state and must be named in the journal.
    if (ordinary.status !== 'failed') return { status: ordinary.status, reason: ordinary.reason };
    const id = `review-start-${safeReviewId(ticket?.id ?? waveId)}`;
    const text = reviewStartText(ticket?.id ?? waveId, error);
    await writeBlocker(id, text, ticket, waveId);
    return { status: 'stuck', reason: `${id}: ${text}` };
  };

  const recordReview = async ({ kind, file, tickets, source, waveId }) => {
    const context = reviewContext(tickets, source, waveId);
    let review;
    try {
      review = await deps.review(kind, file, context);
    } catch (error) {
      return { stop: await reviewStartStop(error, tickets[0], waveId) };
    }
    if (!review?.runId) {
      return { stop: await reviewStartStop(new Error('review dependency returned no run id'), tickets[0], waveId) };
    }
    try {
      await deps.record(kind, review.runId, context);
    } catch (error) {
      return { stop: stepStop(error) };
    }
    for (const ticket of tickets) reviewRecord.add(ticket.id);
    return { review, context };
  };

  const queueResumeReviews = async () => {
    const ledger = await deps.ledger();
    const pending = (ledger?.tickets ?? []).filter(ticket => ticket?.status === 'review'
      && !reviewRecord.has(ticket.id)
      && !reviewRunOnTicket(ticket));
    for (const ticket of pending) {
      const stop = await deps.stopped();
      if (stop) return { stop: { status: 'stopped', reason: stop } };
      resumeReviewNumber += 1;
      const waveId = `resume-${resumeReviewNumber}`;
      const file = `.swarm/acceptance-reviews/${waveId}-${safeReviewId(ticket.id)}.json`;
      const started = await recordReview({
        kind: 'acceptance',
        file,
        tickets: [ticket],
        source: 'resume',
        waveId,
      });
      if (started.stop) return started;
    }
    return {};
  };

  try { return await loop(); }
  catch (error) {
    // Nothing escapes without the final summary.
    let summary = null;
    try { summary = await summaryNow(); } catch { /* the ledger itself is the problem */ }
    const stop = stepStop(error);
    return finish(stop.status, stop.reason, { summary });
  }

  async function loop() {
  for (let n = 1; n <= maxWaves; n += 1) {
    const stop = await deps.stopped();
    if (stop) return finish('stopped', stop, { summary: await summaryNow() });
    const resumed = await queueResumeReviews();
    if (resumed.stop) {
      if (resumed.stop.status === 'stuck') return finish('stuck', resumed.stop.reason, { summary: await summaryNow() });
      return finish(resumed.stop.status, resumed.stop.reason, { summary: await summaryNow() });
    }
    let prepared;
    try { prepared = await deps.prepare(); }
    catch (error) {
      const summary = await summaryNow();
      const idle = classifyIdle(summary, error);
      if (!['scope-nothing', 'scope-skeleton'].includes(error?.code)) return finish('failed', error.message, { summary });
      return finish(idle.status, idle.reason, { summary });
    }
    const before = await summaryNow();
    deps.log(`wave ${n}: ${prepared.ids.length} ticket(s) (${prepared.ids.slice(0, 6).join(', ')}${prepared.ids.length > 6 ? ', ...' : ''}); ${before.done}/${before.total} done`);
    const wave = { n, ids: prepared.ids, runId: null, status: null, reviews: 0, reviewRecord: [] };
    waves.push(wave);
    let result;
    try { result = await deps.runWave(prepared.file); }
    catch (error) { result = { status: 'failed', stage: 'run', reason: error.message, runId: null }; }
    wave.runId = result.runId ?? null; wave.status = result.status; wave.stage = result.stage ?? null;
    if (!wave.runId) {
      // The run never started: the wave's tickets go back to ready, and a cap or stop says so instead of looking like a failure.
      await deps.revert(prepared.ids);
      const text = result.reason ?? '';
      const kind = isStopMarker(text, result.code) ? 'stopped' : isCapStop(text, result.code) ? 'cap' : 'failed';
      return finish(kind, text || 'the wave did not start', { summary: await summaryNow() });
    }
    // A cancelled run (Ctrl-C, swarm stop --all) is the owner's stop: nothing is synced, salvaged or reviewed, and no wave follows.
    if (isCancelled(result.reason)) return finish('stopped', `run ${wave.runId} was cancelled; its tickets stay running (swarm scope sync ${wave.runId} moves them when you decide)`, { summary: await summaryNow() });
    // A paused run (quota or cap) keeps its tickets running: it is resumed, not synced.
    if (result.status === 'paused' || /^run paused/.test(result.reason ?? '')) return finish('paused', `run ${wave.runId} is paused; swarm resume ${wave.runId} (the wave's tickets stay running)`, { summary: await summaryNow() });
    const step = async fn => { try { return { value: await fn() }; } catch (error) { return { stop: stepStop(error) }; } };
    const guarded = async fn => { const halt = await deps.stopped(); if (halt) return { stop: { status: 'stopped', reason: halt } }; return step(fn); };
    const stopHere = async hit => finish(hit.stop.status, `wave ${n}: ${hit.stop.reason}`, { summary: await summaryNow() });
    const synced = await step(() => deps.sync(wave.runId, { integrated: false }));
    if (synced.stop) return stopHere(synced);
    wave.sync = synced.value;
    let integrated = Boolean(result.integrate) && result.status !== 'failed';
    if (result.status === 'failed' && result.stage === 'run') {
      // Some jobs failed: the finished ones are integrated and committed on their own, the failed tickets went back up the ladder in the sync above.
      const salvaged = await guarded(() => deps.salvage(wave.runId, n));
      if (salvaged.stop) return finish(salvaged.stop.status, `wave ${n}: the finished jobs were not integrated: ${salvaged.stop.reason}`, { summary: await summaryNow() });
      wave.salvaged = salvaged.value.jobs ?? 0;
      integrated = Boolean(salvaged.value.integrated);
    } else if (result.status === 'failed') {
      return finish('failed', `wave ${n} stopped at ${result.stage ?? 'run'}: ${result.reason ?? 'failed'}${(await summaryNow()).review ? `; its tickets wait in review (fix it, then swarm scope sync ${wave.runId} --integrated)` : ''}`, { summary: await summaryNow() });
    }
    if (integrated) {
      const first = await step(() => deps.sync(wave.runId, { integrated: true }));
      if (first.stop) return stopHere(first);
      wave.integratedSync = first.value;
      for (let round = 0; round < REVIEW_ROUNDS; round += 1) {
        const kinds = [...new Set([...String(wave.integratedSync).matchAll(REVIEW_FILE)].map(m => m[2]))];
        if (!kinds.length) break;
        for (const kind of kinds) {
          // The file is named from this wave's run, never from the text the sync printed.
          const ledger = await deps.ledger();
          const currentTickets = (ledger?.tickets ?? []).filter(ticket => ticket.status === 'review');
          const contextTickets = currentTickets.length
            ? currentTickets
            : (ledger?.tickets ?? []).filter(ticket => wave.ids.includes(ticket.id));
          const guardedReview = await guarded(() => recordReview({
            kind,
            file: `.swarm/${kind}-reviews/${wave.runId}.json`,
            tickets: contextTickets,
            source: 'integrated',
            waveId: wave.runId,
          }));
          if (guardedReview.stop) return stopHere(guardedReview);
          const reviewed = guardedReview.value;
          if (reviewed.stop) {
            if (reviewed.stop.status === 'stuck') return finish('stuck', `wave ${n}: ${reviewed.stop.reason}`, { summary: await summaryNow() });
            return finish(reviewed.stop.status, `wave ${n}: ${reviewed.stop.reason}`, { summary: await summaryNow() });
          }
          wave.reviewRecord.push({ kind, runId: reviewed.review.runId, ticketIds: reviewed.context.ticketIds });
          wave.reviews += 1;
        }
        const again = await step(() => deps.sync(wave.runId, { integrated: true }));
        if (again.stop) return stopHere(again);
        wave.integratedSync = again.value;
      }
    }
    const after = await summaryNow();
    wave.done = after.done;
    stalled = after.done > before.done ? 0 : stalled + 1;
    deps.log(`wave ${n}: ${after.done}/${after.total} done${after.review ? `, ${after.review} in review` : ''}${after.blocked ? `, ${after.blocked} blocked` : ''}`);
    if (stalled >= STALL_WAVES) return finish('no-progress', `${STALL_WAVES} waves in a row finished no ticket (${after.review} in review, ${after.blocked} blocked); look at swarm tickets --status review`, { summary: after });
  }
  const last = await summaryNow();
  const idle = classifyIdle(last);
  if (['complete', 'waiting-human'].includes(idle.status) && last.running === 0) return finish(idle.status, idle.reason, { summary: last });
  return finish('max-waves', `stopped after ${maxWaves} waves (--max-waves); run it again to continue`, { summary: last });
  }
}

// 75 (try again) for a run that is paused or a loop that hit --max-waves: both continue when run again.
export const loopExitCode = status => (status === 'complete' || status === 'waiting-human' ? 0 : status === 'paused' || status === 'max-waves' ? 75 : 1);
