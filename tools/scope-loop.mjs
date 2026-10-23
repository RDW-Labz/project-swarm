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
import {
  acceptanceReviewSkipNote,
  acceptanceReviewSkipWarning,
  prepareAcceptanceReviewFile,
  readReviewManifest,
} from './acceptance.mjs';
import { validateManifest } from './swarm/core-31.mjs';
import { effectiveTargetWorktree, resolveTargetWorktree } from './tickets.mjs';
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

const reviewStartReason = error => String(error?.message ?? error).split('\n')[0].slice(0, 400);

const isAcceptanceMetWithoutReview = error => error?.code === 'acceptance-review-skip'
  || reviewStartReason(error).includes('acceptance review has nothing to review');

const isEmptyAcceptanceManifest = error => reviewStartReason(error).includes('acceptance review manifest has zero jobs')
  || reviewStartReason(error).includes('Manifest has zero jobs');

const isRetryableReviewStartFailure = error => {
  if (isAcceptanceMetWithoutReview(error) || isEmptyAcceptanceManifest(error)) return false;
  const text = reviewStartReason(error);
  return error?.code === 'review-manifest'
    || text.includes('review manifest ');
};

const projectRootForReview = (mainRoot, rootOptions) => mainRoot ?? rootOptions?.root ?? null;

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
export async function scopeLoop({ maxWaves = DEFAULT_MAX_WAVES, deps, root: requestedRoot } = {}) {
  const waves = [];
  const mainRoot = requestedRoot ?? deps?.root ?? deps?.mainRoot ?? null;
  // A successful review is recorded here before the next loop iteration. This is deliberately
  // separate from ticket.runId: that is the build run, not proof that a review was started.
  const reviewRecord = new Set();
  const acceptanceReviewDeferred = new Set();
  let resumeReviewNumber = 0;
  let stalled = 0;
  let waveAcceptanceSkipped = new Set();
  const finish = (status, reason, extra = {}) => ({ status, reason, waves, ...extra });
  const summaryNow = async () => ledgerSummary(await deps.ledger());

  const rootsForTickets = async tickets => {
    const ledger = await deps.ledger();
    const targets = new Map(tickets.map(ticket => [ticket.id, effectiveTargetWorktree(ledger, ticket)]));
    const explicit = tickets.filter(ticket => targets.get(ticket.id) !== undefined);
    if (!explicit.length && !mainRoot) return null;
    const roots = {};
    for (const ticket of tickets) {
      const target = targets.get(ticket.id);
      if (target === undefined) {
        if (mainRoot) roots[ticket.id] = mainRoot;
        continue;
      }
      if (!mainRoot) throw Object.assign(new Error(`target-worktree-unknown: ${target}`), { code: 'target-worktree-unknown' });
      roots[ticket.id] = await resolveTargetWorktree(mainRoot, target);
    }
    const unique = [...new Set(Object.values(roots))];
    return {
      ...(unique.length === 1 ? { root: unique[0] } : {}),
      roots,
      ticketRoots: roots,
      tickets: tickets.map(ticket => ({ ...ticket, root: roots[ticket.id] })),
    };
  };

  const reviewContext = (tickets, source, waveId, rootOptions = null) => ({
    source,
    waveId,
    ticketIds: tickets.map(ticket => ticket.id),
    // The review dependency owns manifest creation. Passing a fresh snapshot on every start
    // prevents it from reusing a manifest generated for an earlier ticket context.
    tickets: tickets.map(ticket => ({
      ...ticket,
      ...(rootOptions?.ticketRoots?.[ticket.id] ? { root: rootOptions.ticketRoots[ticket.id] } : {}),
    })),
    generatedAt: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
    ...(rootOptions ? { root: rootOptions.root, roots: rootOptions.roots, ticketRoots: rootOptions.ticketRoots } : {}),
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

  const liveTicket = async id => {
    const ledger = await deps.ledger();
    return (ledger?.tickets ?? []).find(ticket => ticket.id === id) ?? null;
  };

  const bumpReviewStartFailure = async ticket => {
    const live = await liveTicket(ticket.id) ?? ticket;
    const count = (live.reviewStartFailCount ?? 0) + 1;
    live.reviewStartFailCount = count;
    if (typeof deps.setTicketField === 'function') {
      await deps.setTicketField(ticket.id, 'reviewStartFailCount', count);
    }
    return count;
  };

  const parkReviewStartBlocked = async (ticket, error, waveId) => {
    const note = reviewStartReason(error);
    const live = await liveTicket(ticket.id) ?? ticket;
    live.status = 'blocked';
    live.blockNote = note;
    reviewRecord.add(ticket.id);
    if (typeof deps.parkTicket === 'function') {
      await deps.parkTicket(ticket.id, { status: 'blocked', blockNote: note });
    } else if (typeof deps.setTicketField === 'function') {
      await deps.setTicketField(ticket.id, 'status', 'blocked');
      await deps.setTicketField(ticket.id, 'blockNote', note);
    }
    const id = `review-start-${safeReviewId(ticket.id ?? waveId)}`;
    await writeBlocker(id, reviewStartText(ticket.id, error), ticket, waveId);
  };

  const handleAcceptanceReviewStartFailure = async (ticket, error, wave, source, waveId) => {
    if (source === 'resume' && isRetryableReviewStartFailure(error)) {
      const attempts = await bumpReviewStartFailure(ticket);
      if (attempts >= 2) {
        await parkReviewStartBlocked(ticket, error, waveId);
        return { parked: true };
      }
      if (typeof deps.log === 'function') {
        deps.log(`${ticket.id}: acceptance review start failed (${attempts}/2): ${reviewStartReason(error)}`);
      }
      return { parked: false, retry: true };
    }
    await skipAcceptanceReview(ticket, error, wave);
    return { parked: false, retry: false };
  };

  const markAcceptanceMetWithoutReview = async ticket => {
    const live = await liveTicket(ticket.id) ?? ticket;
    live.status = 'done';
    reviewRecord.add(ticket.id);
    if (typeof deps.setTicketField === 'function') {
      await deps.setTicketField(ticket.id, 'status', 'done');
    } else if (typeof deps.parkTicket === 'function') {
      await deps.parkTicket(ticket.id, { status: 'done' });
    }
  };

  const skipAcceptanceReview = async (ticket, error, wave) => {
    const reason = String(error?.message ?? error).split('\n')[0].slice(0, 400);
    const note = acceptanceReviewSkipNote(reason);
    const warning = acceptanceReviewSkipWarning(ticket.id, reason);
    waveAcceptanceSkipped.add(ticket.id);
    acceptanceReviewDeferred.add(ticket.id);
    reviewRecord.add(ticket.id);
    if (typeof deps.ticketNote === 'function') {
      try { await deps.ticketNote(ticket.id, note); } catch (noteError) {
        if (typeof deps.log === 'function') deps.log(`ticket note for ${ticket.id} failed: ${noteError.message}`);
      }
    }
    if (wave) {
      wave.warnings = wave.warnings ?? [];
      wave.warnings.push(warning);
    }
    if (typeof deps.log === 'function') deps.log(warning);
  };

  const recordGroupedReview = async ({ kind, file, tickets, source, waveId, wave }) => {
    const rootOptions = await rootsForTickets(tickets);
    const groups = [];
    for (const ticket of tickets) {
      const root = rootOptions?.ticketRoots?.[ticket.id] ?? null;
      const group = groups.find(candidate => candidate.root === root);
      if (group) group.tickets.push(ticket);
      else groups.push({ root, tickets: [ticket] });
    }
    const reviews = [];
    for (const group of groups) {
      const groupOptions = await rootsForTickets(group.tickets);
      const context = reviewContext(group.tickets, source, waveId, groupOptions);
      let review;
      try {
        review = await deps.review(kind, file, context, groupOptions ?? undefined);
      } catch (error) {
        return { stop: await reviewStartStop(error, group.tickets[0], waveId) };
      }
      if (!review?.runId) {
        return { stop: await reviewStartStop(new Error('review dependency returned no run id'), group.tickets[0], waveId) };
      }
      try {
        await deps.record(kind, review.runId, context, groupOptions ?? undefined);
      } catch (error) {
        return { stop: stepStop(error) };
      }
      for (const ticket of group.tickets) reviewRecord.add(ticket.id);
      reviews.push({ review, context });
    }
    return { ...reviews[0], reviews };
  };

  const recordAcceptanceReviews = async ({ file, tickets, source, waveId, wave }) => {
    const ledger = await deps.ledger();
    const reviews = [];
    const eligible = tickets.filter(ticket => !waveAcceptanceSkipped.has(ticket.id) && !acceptanceReviewDeferred.has(ticket.id));
    for (const ticket of eligible) {
      let groupOptions;
      try {
        groupOptions = await rootsForTickets([ticket]);
      } catch (error) {
        await skipAcceptanceReview(ticket, error, wave);
        continue;
      }
      const ticketFile = eligible.length === 1 && file
        ? file
        : `.swarm/acceptance-reviews/${waveId}-${safeReviewId(ticket.id)}.json`;
      const projectRoot = projectRootForReview(mainRoot, groupOptions);
      if (projectRoot && ticketFile && typeof deps.prepareAcceptanceReview !== 'function') {
        const existing = await readReviewManifest(projectRoot, ticketFile).catch(() => null);
        if (existing && !existing.jobs?.length) {
          await skipAcceptanceReview(ticket, new Error('acceptance review manifest has zero jobs'), wave);
          continue;
        }
      }
      try {
        if (typeof deps.prepareAcceptanceReview === 'function') {
          await deps.prepareAcceptanceReview({
            ticket,
            file: ticketFile,
            waveId,
            source,
            ledger,
            root: projectRoot ?? mainRoot,
          });
        } else if (projectRoot) {
          await prepareAcceptanceReviewFile(projectRoot, {
            runId: waveId,
            ticket,
            relativeFile: ticketFile,
            ledger,
          });
        }
      } catch (error) {
        if (isAcceptanceMetWithoutReview(error)) {
          await skipAcceptanceReview(ticket, error, wave);
          await markAcceptanceMetWithoutReview(ticket);
          continue;
        }
        await skipAcceptanceReview(ticket, error, wave);
        continue;
      }
      if (projectRoot && ticketFile && typeof deps.prepareAcceptanceReview !== 'function') {
        try {
          const raw = await readReviewManifest(projectRoot, ticketFile);
          if (!raw.jobs?.length) {
            await skipAcceptanceReview(ticket, new Error('acceptance review manifest has zero jobs'), wave);
            continue;
          }
          validateManifest(raw);
        } catch (error) {
          if (isAcceptanceMetWithoutReview(error)) {
            await skipAcceptanceReview(ticket, error, wave);
            await markAcceptanceMetWithoutReview(ticket);
            continue;
          }
          if (isEmptyAcceptanceManifest(error)) {
            await skipAcceptanceReview(ticket, error, wave);
            continue;
          }
          if (error?.code === 'review-manifest') {
            await skipAcceptanceReview(ticket, error, wave);
            continue;
          }
          await skipAcceptanceReview(ticket, error, wave);
          continue;
        }
      }
      const context = reviewContext([ticket], source, waveId, groupOptions);
      let review;
      try {
        review = await deps.review('acceptance', ticketFile, context, groupOptions ?? undefined);
      } catch (error) {
        if (isAcceptanceMetWithoutReview(error)) {
          await skipAcceptanceReview(ticket, error, wave);
          await markAcceptanceMetWithoutReview(ticket);
          continue;
        }
        if (isEmptyAcceptanceManifest(error)) {
          await skipAcceptanceReview(ticket, error, wave);
          continue;
        }
        const stop = stepStop(error);
        if (stop.status !== 'failed') return { stop };
        const handled = await handleAcceptanceReviewStartFailure(ticket, error, wave, source, waveId);
        if (handled.retry) continue;
        continue;
      }
      if (!review?.runId) {
        await skipAcceptanceReview(ticket, new Error('review dependency returned no run id'), wave);
        continue;
      }
      try {
        await deps.record('acceptance', review.runId, context, groupOptions ?? undefined);
      } catch (error) {
        return { stop: stepStop(error) };
      }
      reviewRecord.add(ticket.id);
      reviews.push({ review, context });
    }
    return reviews.length ? { ...reviews[0], reviews } : { reviews: [] };
  };

  const recordReview = async ({ kind, file, tickets, source, waveId, wave }) => {
    if (kind === 'acceptance') {
      return recordAcceptanceReviews({ file, tickets, source, waveId, wave });
    }
    return recordGroupedReview({ kind, file, tickets, source, waveId, wave });
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
        wave: null,
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
    const waveLedger = await deps.ledger();
    const waveTickets = (waveLedger?.tickets ?? []).filter(ticket => prepared.ids.includes(ticket.id));
    const rootOptions = await rootsForTickets(waveTickets);
    deps.log(`wave ${n}: ${prepared.ids.length} ticket(s) (${prepared.ids.slice(0, 6).join(', ')}${prepared.ids.length > 6 ? ', ...' : ''}); ${before.done}/${before.total} done`);
    waveAcceptanceSkipped = new Set();
    const wave = { n, ids: prepared.ids, runId: null, status: null, reviews: 0, reviewRecord: [], warnings: [] };
    waves.push(wave);
    let result;
    try { result = await deps.runWave(prepared.file, rootOptions ?? undefined); }
    catch (error) { result = { status: 'failed', stage: 'run', reason: error.message, runId: null }; }
    wave.runId = result.runId ?? null; wave.status = result.status; wave.stage = result.stage ?? null;
    if (!wave.runId) {
      // The run never started: the wave's tickets go back to ready, and a cap or stop says so instead of looking like a failure.
      await deps.revert(prepared.ids, rootOptions ?? undefined);
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
    const synced = await step(() => deps.sync(wave.runId, { integrated: false, ...(rootOptions ?? {}) }));
    if (synced.stop) return stopHere(synced);
    wave.sync = synced.value;
    let integrated = Boolean(result.integrate) && result.status !== 'failed';
    if (result.status === 'failed' && result.stage === 'run') {
      // Some jobs failed: the finished ones are integrated and committed on their own, the failed tickets went back up the ladder in the sync above.
      const salvaged = await guarded(() => deps.salvage(wave.runId, n, rootOptions ?? undefined));
      if (salvaged.stop) return finish(salvaged.stop.status, `wave ${n}: the finished jobs were not integrated: ${salvaged.stop.reason}`, { summary: await summaryNow() });
      wave.salvaged = salvaged.value.jobs ?? 0;
      integrated = Boolean(salvaged.value.integrated);
    } else if (result.status === 'failed') {
      return finish('failed', `wave ${n} stopped at ${result.stage ?? 'run'}: ${result.reason ?? 'failed'}${(await summaryNow()).review ? `; its tickets wait in review (fix it, then swarm scope sync ${wave.runId} --integrated)` : ''}`, { summary: await summaryNow() });
    }
    if (integrated) {
      const first = await step(() => deps.sync(wave.runId, { integrated: true, ...(rootOptions ?? {}) }));
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
            wave,
          }));
          if (guardedReview.stop) return stopHere(guardedReview);
          const reviewed = guardedReview.value;
          if (reviewed.stop) {
            if (reviewed.stop.status === 'stuck') return finish('stuck', `wave ${n}: ${reviewed.stop.reason}`, { summary: await summaryNow() });
            return finish(reviewed.stop.status, `wave ${n}: ${reviewed.stop.reason}`, { summary: await summaryNow() });
          }
          for (const entry of reviewed.reviews ?? [reviewed]) {
            wave.reviewRecord.push({ kind, runId: entry.review.runId, ticketIds: entry.context.ticketIds });
            wave.reviews += 1;
          }
        }
        const again = await step(() => deps.sync(wave.runId, { integrated: true, ...(rootOptions ?? {}) }));
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
