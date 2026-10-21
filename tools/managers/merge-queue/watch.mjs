// SPDX-License-Identifier: Apache-2.0
// Merge queue manager: watch integration runs for batch, conflict and check-failure signals (T-0211).

import { assertMergeable } from '../../merge-guard.mjs';
import { mergeSwarmPrStandingEnabled } from '../../handbuild.mjs';

/** @typedef {import('../types.mjs').ManagerFinding} ManagerFinding */

/**
 * @typedef {'batch'|'conflict'|'check-failed'|'flagged'|'security'|'merge-ready'|'queue'} MergeQueueWatchKind
 */

/**
 * @typedef {object} MergeQueueWatchItem
 * @property {MergeQueueWatchKind} kind
 * @property {string} code
 * @property {'info'|'warn'|'needs_you'} severity
 * @property {string} action
 * @property {string} reason
 * @property {string} [job]
 * @property {string} [run]
 * @property {string|number} [batchId]
 * @property {string} [ticket]
 * @property {number} [pr]
 * @property {readonly string[]} [checks]
 * @property {readonly string[]} [files]
 * @property {string} [recommendation]
 * @property {string} [followUp]
 */

/**
 * @typedef {object} MergeQueueGreenMergeCandidate
 * @property {string} job
 * @property {string} [ticket]
 * @property {number} pr
 * @property {number} order
 * @property {boolean} standingMergeApproval
 * @property {boolean} prChecksGreen
 * @property {readonly string[]} [blockedReasons]
 */

/**
 * @typedef {object} MergeQueueWatchResult
 * @property {string|null} runId
 * @property {string|null} queueState
 * @property {boolean} queueActive
 * @property {readonly MergeQueueWatchItem[]} items
 * @property {readonly MergeQueueGreenMergeCandidate[]} greenMerges
 */

const FAILED_CHECK_STATUSES = new Set(['failed', 'error', 'timeout', 'cancelled', 'crashed']);

/**
 * @param {unknown} entry
 * @returns {string|null}
 */
export function jobIdOf(entry) {
  if (typeof entry === 'string' && entry.length > 0) return entry;
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0) {
    return entry.id;
  }
  if (entry && typeof entry === 'object' && typeof entry.job === 'string' && entry.job.length > 0) {
    return entry.job;
  }
  return null;
}

/**
 * @param {string} text
 * @param {number} max
 */
function clipReason(text, max) {
  const value = String(text ?? '').trim() || 'merge-queue-watch';
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/**
 * @param {unknown} ticket
 * @returns {number|null}
 */
export function prNumberFromTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return null;
  const pr = ticket.pr;
  if (typeof pr === 'number' && Number.isFinite(pr) && pr >= 1) return Math.trunc(pr);
  if (pr && typeof pr === 'object' && pr.number != null) {
    const n = Number(pr.number);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null;
  }
  return null;
}

/**
 * Exact post-merge state for journal follow-ups (lesson L-0130).
 *
 * @param {{ pr: number, repo?: string|null, baseRefName?: string|null, headRefOid?: string|null, defaultBranch?: string|null }} input
 * @returns {string}
 */
export function formatPostMergeFollowUp({ pr, repo, baseRefName, headRefOid, defaultBranch }) {
  const parts = [`PR #${pr} merged`];
  if (repo) parts.push(`on ${repo}`);
  const base = baseRefName ?? defaultBranch;
  if (base) parts.push(`into ${base}`);
  if (headRefOid) parts.push(`at ${headRefOid.slice(0, 12)}`);
  return clipReason(parts.join(' '), 500);
}

/**
 * @param {unknown} mq
 */
function mergeQueueSummary(mq) {
  if (!mq || typeof mq !== 'object') return null;
  const summary = mq.summary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) return summary;
  return null;
}

/**
 * @param {unknown} state
 * @returns {readonly string[]}
 */
function integratedJobOrder(state) {
  const mq = state?.mergeQueue;
  const fromQueue = Array.isArray(mq?.integrated) ? mq.integrated.map((j) => jobIdOf(j)).filter(Boolean) : [];
  if (fromQueue.length > 0) return fromQueue;
  const summary = mergeQueueSummary(mq);
  if (summary && Array.isArray(summary.integrated)) {
    const fromSummary = summary.integrated
      .map((row) => jobIdOf(row) ?? (row && typeof row === 'object' ? jobIdOf(row.job) : null))
      .filter(Boolean);
    if (fromSummary.length > 0) return fromSummary;
  }
  return [];
}

/**
 * @param {unknown} state
 * @returns {Set<string>}
 */
function jobsWithCheckFailures(state) {
  const out = new Set();
  const mq = state?.mergeQueue;
  const lists = [mq?.checkFailed, mergeQueueSummary(mq)?.checkFailed];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const id = jobIdOf(row);
      if (id) out.add(id);
    }
  }
  return out;
}

/**
 * @param {unknown} state
 * @returns {Set<string>}
 */
function jobsWithConflicts(state) {
  const out = new Set();
  const mq = state?.mergeQueue;
  if (!Array.isArray(mq?.conflicts)) return out;
  for (const row of mq.conflicts) {
    const id = jobIdOf(row);
    if (id) out.add(id);
  }
  return out;
}

/**
 * @param {unknown} state
 * @returns {Map<string, string>}
 */
function flaggedJobs(state) {
  const out = new Map();
  const summary = mergeQueueSummary(state?.mergeQueue);
  if (!summary || !Array.isArray(summary.flagged)) return out;
  for (const row of summary.flagged) {
    const id = jobIdOf(row);
    if (!id) continue;
    const reason = row && typeof row === 'object' && typeof row.reason === 'string' ? row.reason : 'flagged';
    out.set(id, reason);
  }
  return out;
}

/**
 * @param {unknown} batch
 * @returns {readonly string[]}
 */
function failedCheckNames(batch) {
  if (!batch || typeof batch !== 'object') return [];
  const names = [];
  const results = batch.checkResults;
  if (Array.isArray(results)) {
    for (const row of results) {
      if (row && FAILED_CHECK_STATUSES.has(row.status) && row.name) names.push(String(row.name));
    }
  }
  if (!names.length && batch.checks && batch.checks !== 'passed' && batch.checks !== 'skipped') {
    names.push(String(batch.checks));
  }
  if (!names.length && batch.security === 'blocked') names.push('security-gate');
  return names;
}

/**
 * @param {unknown} state
 * @param {string} runId
 * @returns {MergeQueueWatchItem[]}
 */
function watchBatches(state, runId) {
  const mq = state?.mergeQueue;
  if (!mq || typeof mq !== 'object') return [];
  const items = [];
  const batches = Array.isArray(mq.batches) ? mq.batches : [];
  for (const batch of batches) {
    if (!batch || typeof batch !== 'object') continue;
    const batchId = batch.id ?? '?';
    const jobs = (Array.isArray(batch.jobs) ? batch.jobs : Array.isArray(batch.jobIds) ? batch.jobIds : [])
      .map((j) => jobIdOf(j))
      .filter(Boolean);
    const jobLabel = jobs.length === 1 ? jobs[0] : jobs.join(', ');
    if (batch.checks === 'failed') {
      const checks = failedCheckNames(batch);
      const bisected = Boolean(batch.bisected);
      items.push({
        kind: 'batch',
        code: bisected ? 'batch-bisected' : 'batch-failed',
        severity: jobs.length === 1 ? 'warn' : 'info',
        action: jobs.length === 1 ? 'open-fix-ticket' : 'bisect-batch',
        reason: clipReason(
          bisected
            ? `batch ${batchId} failed (${checks.join(', ') || 'checks'}) and was bisected; jobs: ${jobLabel}`
            : `batch ${batchId} failed checks (${checks.join(', ') || 'unknown'}) for jobs: ${jobLabel}`,
          2000,
        ),
        run: runId,
        batchId,
        ...(jobs.length === 1 ? { job: jobs[0] } : {}),
        checks,
        recommendation:
          jobs.length === 1
            ? 'Open a fix ticket with the failing output; never re-run the same check to get green.'
            : 'Bisect or shrink the batch before retrying integration.',
      });
    }
  }
  const queueState = typeof mq.state === 'string' ? mq.state : null;
  if (queueState === 'final-check-failed') {
    items.push({
      kind: 'queue',
      code: 'queue-final-check-failed',
      severity: 'warn',
      action: 'open-fix-ticket',
      reason: clipReason(`merge queue run ${runId} ended with final-check-failed`, 2000),
      run: runId,
      recommendation: 'Fix the failing full check, then re-run integrate --queue; do not merge past a red check.',
    });
  }
  return items;
}

/**
 * @param {unknown} state
 * @param {string} runId
 * @returns {MergeQueueWatchItem[]}
 */
function watchConflicts(state, runId) {
  const mq = state?.mergeQueue;
  if (!mq || !Array.isArray(mq.conflicts)) return [];
  const items = [];
  for (const row of mq.conflicts) {
    const job = jobIdOf(row);
    if (!job) continue;
    const files = Array.isArray(row.files) ? row.files.map(String) : [];
    const reasonText =
      row && typeof row === 'object' && typeof row.reason === 'string' ? row.reason : 'changed since worker snapshot';
    items.push({
      kind: 'conflict',
      code: 'merge-conflict',
      severity: 'warn',
      action: 'requeue-after-rebase',
      reason: clipReason(`job ${job} conflicts (${reasonText}): ${files.join(', ') || 'declared outputs'}`, 2000),
      job,
      run: runId,
      files,
      recommendation: 'Requeue on a fresh worker snapshot after the checkout moved; do not overwrite newer content.',
    });
  }
  return items;
}

/**
 * @param {unknown} state
 * @param {string} runId
 * @returns {MergeQueueWatchItem[]}
 */
function watchCheckFailures(state, runId) {
  const mq = state?.mergeQueue;
  const lists = [
    { source: mq?.checkFailed, run: runId },
    { source: mergeQueueSummary(mq)?.checkFailed, run: null },
  ];
  /** @type {MergeQueueWatchItem[]} */
  const items = [];
  const seen = new Set();
  for (const { source, run: rowRun } of lists) {
    if (!Array.isArray(source)) continue;
    for (const row of source) {
      const job = jobIdOf(row);
      if (!job) continue;
      const key = `${job}\0${(row.checks ?? []).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const checks = Array.isArray(row.checks) ? row.checks.map(String) : [];
      const tail = row && typeof row === 'object' && typeof row.tail === 'string' ? row.tail.trim() : '';
      items.push({
        kind: 'check-failed',
        code: 'batch-check-failed',
        severity: 'warn',
        action: 'open-fix-ticket',
        reason: clipReason(
          `job ${job} failed ${checks.join(', ') || 'checks'} in merge queue${tail ? `: ${tail.slice(0, 400)}` : ''}`,
          2000,
        ),
        job,
        run: rowRun ?? (typeof row.run === 'string' ? row.run : runId),
        checks,
        recommendation: 'Open a fix ticket with the batch output; never re-run the same failing check to get green.',
      });
    }
  }
  if (Array.isArray(mq?.securityBlocked)) {
    for (const row of mq.securityBlocked) {
      const job = jobIdOf(row);
      if (!job) continue;
      items.push({
        kind: 'security',
        code: 'security-gate-blocked',
        severity: 'needs_you',
        action: 'open-fix-ticket',
        reason: clipReason(`job ${job} was blocked by the security gate in the merge queue`, 2000),
        job,
        run: runId,
        recommendation: 'Resolve the security gate finding or get an explicit owner override before merging.',
      });
    }
  }
  return items;
}

/**
 * @param {unknown} state
 * @param {string} runId
 * @returns {MergeQueueWatchItem[]}
 */
function watchFlagged(state, runId) {
  const flagged = flaggedJobs(state);
  const items = [];
  for (const [job, reason] of flagged) {
    items.push({
      kind: 'flagged',
      code: 'merge-flagged',
      severity: 'needs_you',
      action: 'open-fix-ticket',
      reason: clipReason(`job ${job} flagged: ${reason}`, 2000),
      job,
      run: runId,
      recommendation: 'Review the merge or requeue outcome before merging related PRs.',
    });
  }
  return items;
}

/**
 * @param {{
 *   runId?: string|null,
 *   state: unknown,
 *   ticketsById?: Record<string, unknown>,
 *   prViews?: Record<string, unknown>,
 *   defaultBranch?: string|null,
 *   standingMergeApproval?: boolean|null,
 *   home?: string,
 * }} input
 * @returns {MergeQueueWatchResult}
 */
export function watchMergeQueue(input) {
  const state = input?.state;
  const runId = input?.runId != null ? String(input.runId) : typeof state?.id === 'string' ? state.id : null;
  const mq = state?.mergeQueue;
  const queueState = mq && typeof mq === 'object' && typeof mq.state === 'string' ? mq.state : null;
  const queueActive = queueState === 'running';

  const ticketsById = input?.ticketsById && typeof input.ticketsById === 'object' ? input.ticketsById : {};
  const prViews = input?.prViews && typeof input.prViews === 'object' ? input.prViews : {};
  const defaultBranch = input?.defaultBranch ?? null;
  const standing =
    input?.standingMergeApproval === null || input?.standingMergeApproval === undefined
      ? mergeSwarmPrStandingEnabled(input?.home)
      : Boolean(input.standingMergeApproval);

  const checkFailedJobs = jobsWithCheckFailures(state);
  const conflictJobs = jobsWithConflicts(state);
  const flagged = flaggedJobs(state);

  const items = [
    ...watchBatches(state, runId ?? ''),
    ...watchConflicts(state, runId ?? ''),
    ...watchCheckFailures(state, runId ?? ''),
    ...watchFlagged(state, runId ?? ''),
  ];

  const integrated = integratedJobOrder(state);
  const manifestOrder = Array.isArray(state?.jobs)
    ? state.jobs.map((j) => jobIdOf(j)).filter(Boolean)
    : [];
  const orderIndex = new Map();
  let n = 0;
  for (const id of manifestOrder) {
    if (!orderIndex.has(id)) orderIndex.set(id, n++);
  }
  for (const id of integrated) {
    if (!orderIndex.has(id)) orderIndex.set(id, n++);
  }

  /** @type {MergeQueueGreenMergeCandidate[]} */
  const greenMerges = [];
  if (integrated.length > 0) {
    const sorted = integrated.slice().sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    for (const job of sorted) {
      if (checkFailedJobs.has(job) || conflictJobs.has(job) || flagged.has(job)) continue;
      const ticket = ticketsById[job] ?? ticketsById[job.toUpperCase()] ?? null;
      const pr = prNumberFromTicket(ticket);
      if (pr === null) continue;
      const view = prViews[String(pr)] ?? prViews[pr];
      let prChecksGreen = false;
      let blockedReasons = [];
      if (view && typeof view === 'object') {
        const verdict = assertMergeable(view, { defaultBranch });
        prChecksGreen = verdict.ok;
        if (!verdict.ok) blockedReasons = verdict.reasons;
      }
      const candidate = {
        job,
        ticket: ticket && typeof ticket === 'object' && typeof ticket.id === 'string' ? ticket.id : job,
        pr,
        order: orderIndex.get(job) ?? greenMerges.length,
        standingMergeApproval: standing,
        prChecksGreen,
        ...(blockedReasons.length ? { blockedReasons } : {}),
      };
      greenMerges.push(candidate);
      if (prChecksGreen && standing) {
        items.push({
          kind: 'merge-ready',
          code: 'green-merge-ready',
          severity: 'needs_you',
          action: 'merge-pr',
          reason: clipReason(`PR #${pr} for job ${job} is green and next in merge queue order`, 2000),
          job,
          ticket: candidate.ticket,
          pr,
          run: runId ?? undefined,
          recommendation: `swarm merge ${pr} (standing approval merge-swarm-pr)`,
          followUp: formatPostMergeFollowUp({
            pr,
            baseRefName: view && typeof view === 'object' ? view.baseRefName : null,
            headRefOid: view && typeof view === 'object' ? view.headRefOid : null,
            defaultBranch,
          }),
        });
      } else if (prChecksGreen && !standing) {
        items.push({
          kind: 'merge-ready',
          code: 'green-merge-blocked',
          severity: 'needs_you',
          action: 'merge-pr',
          reason: clipReason(`PR #${pr} for job ${job} is green but merge-swarm-pr standing approval is off`, 2000),
          job,
          ticket: candidate.ticket,
          pr,
          run: runId ?? undefined,
          recommendation: 'Enable merge-swarm-pr in policy.json or merge manually with swarm merge after owner approval.',
        });
      } else if (!view) {
        items.push({
          kind: 'merge-ready',
          code: 'green-merge-awaiting-pr-status',
          severity: 'info',
          action: 'merge-pr',
          reason: clipReason(`job ${job} integrated with PR #${pr}; fetch CI status before merging`, 2000),
          job,
          ticket: candidate.ticket,
          pr,
          run: runId ?? undefined,
          recommendation: 'Run swarm merge N only after GitHub checks are green on the default branch.',
        });
      } else if (blockedReasons.length) {
        items.push({
          kind: 'merge-ready',
          code: 'green-merge-blocked',
          severity: 'warn',
          action: 'merge-pr',
          reason: clipReason(`PR #${pr} for job ${job} is not mergeable: ${blockedReasons.join('; ')}`, 2000),
          job,
          ticket: candidate.ticket,
          pr,
          run: runId ?? undefined,
          recommendation: 'Wait for CI or resolve conflicts before merging; never merge past a failing check.',
        });
      }
    }
  }

  return {
    runId,
    queueState,
    queueActive,
    items,
    greenMerges,
  };
}

/**
 * @param {readonly { runId: string, state: unknown }[]} runs
 * @param {Omit<Parameters<typeof watchMergeQueue>[0], 'runId'|'state'>} [options]
 * @returns {MergeQueueWatchResult}
 */
export function watchMergeQueueRuns(runs, options = {}) {
  const list = Array.isArray(runs) ? runs : [];
  /** @type {MergeQueueWatchItem[]} */
  const items = [];
  /** @type {MergeQueueGreenMergeCandidate[]} */
  const greenMerges = [];
  let queueState = null;
  let queueActive = false;
  let runId = null;
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const result = watchMergeQueue({ ...options, runId: row.runId, state: row.state });
    if (result.queueActive) {
      queueActive = true;
      queueState = result.queueState;
      runId = result.runId;
    }
    items.push(...result.items);
    greenMerges.push(...result.greenMerges);
  }
  greenMerges.sort((a, b) => a.order - b.order);
  return { runId, queueState, queueActive, items, greenMerges };
}

/**
 * Map watch items to manager finding shapes (orchestrator supplies ids and modes).
 *
 * @param {readonly MergeQueueWatchItem[]} items
 * @returns {Omit<ManagerFinding, 'id'|'managerId'|'mode'>[]}
 */
export function mergeQueueWatchItemsToFindingInputs(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item) => ({
    severity: item.severity,
    code: item.code,
    reason: item.reason,
    action: item.action,
    ...(item.ticket ? { ticket: item.ticket } : {}),
    ...(item.recommendation ? { recommendation: item.recommendation } : {}),
    ...(item.checks ? { gatesCount: item.checks.length } : {}),
  }));
}
