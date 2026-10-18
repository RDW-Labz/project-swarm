// SPDX-License-Identifier: Apache-2.0
// `swarm go --scope` as a loop: wave after wave until the ledger is finished or something needs the owner.
// Each wave does what the owner used to do by hand: build the wave, run it, integrate and commit it (go), move the tickets (scope sync),
// mark the integrated ones done (scope sync --integrated) and run the security / acceptance reviews that step asks for.
// Every effect is injected, so the loop is tested with fakes and no model call.

export const DEFAULT_MAX_WAVES = 50;
const STALL_WAVES = 4;               // waves in a row that finish no ticket
const REVIEW_ROUNDS = 3;             // review runs per integrated run before it is left for the owner
const REVIEW_FILE = /swarm run (\.swarm\/(security|acceptance)-reviews\/[A-Za-z0-9._-]+\.json)/g;

export const WAVE_STOPS = Object.freeze(['complete', 'waiting-human', 'stuck', 'paused', 'stopped', 'cap', 'failed', 'no-progress', 'max-waves']);

const count = (tickets, status) => tickets.filter(t => t.status === status).length;
export function ledgerSummary(ledger) {
  const tickets = ledger?.tickets ?? [];
  const live = tickets.filter(t => t.status !== 'cancelled');
  return {
    total: live.length,
    done: count(live, 'done'),
    ready: count(live, 'ready') + count(live, 'todo'),
    running: count(live, 'running'),
    review: count(live, 'review'),
    blocked: count(live, 'blocked'),
    humans: live.filter(t => t.type === 'human' && t.status !== 'done').length,
  };
}

// Why the loop cannot start another wave, read from the ledger and the error the wave builder gave.
export function classifyIdle(summary, error) {
  if (summary.total > 0 && summary.done === summary.total) return { status: 'complete', reason: `all ${summary.total} tickets are done` };
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
  let stalled = 0;
  const finish = (status, reason, extra = {}) => ({ status, reason, waves, ...extra });
  const summaryNow = async () => ledgerSummary(await deps.ledger());
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
    const wave = { n, ids: prepared.ids, runId: null, status: null, reviews: 0 };
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
          const reviewed = await guarded(async () => { const review = await deps.review(kind, `.swarm/${kind}-reviews/${wave.runId}.json`); await deps.record(kind, review.runId); return review; });
          if (reviewed.stop) return stopHere(reviewed);
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
