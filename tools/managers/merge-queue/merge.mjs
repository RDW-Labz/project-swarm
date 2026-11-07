// SPDX-License-Identifier: Apache-2.0
// T-0212: ordered merge actions under standing approvals.

import { runMerge as defaultRunMerge } from '../../merge-guard.mjs';
import { formatPostMergeFollowUp } from './watch.mjs';

/**
 * Execute queue candidates serially. The merge guard refreshes GitHub checks and
 * pins the merge to the checked head; a cached green verdict never bypasses it.
 * An unapproved or non-green candidate blocks every later candidate.
 *
 * @param {{
 *   root: string,
 *   greenMerges: readonly import('./watch.mjs').MergeQueueGreenMergeCandidate[],
 *   prViews?: Record<string, unknown>,
 *   defaultBranch?: string|null,
 *   alreadyMergedPrs?: readonly number[],
 *   runMerge?: typeof defaultRunMerge,
 * }} input
 * @returns {Promise<{
 *   applied: import('./watch.mjs').MergeQueueAppliedMerge[],
 *   items: import('./watch.mjs').MergeQueueWatchItem[],
 * }>}
 */
export async function mergeGreenPullRequestsInOrder(input) {
  if (typeof input?.root !== 'string' || !input.root.trim()) {
    throw new Error('merge-queue-root-invalid');
  }
  const runMerge = input.runMerge ?? defaultRunMerge;
  const already = new Set(input.alreadyMergedPrs ?? []);
  const candidates = [...(input.greenMerges ?? [])];
  // Validate the complete ordering before taking any irreversible action.
  for (const candidate of candidates) {
    if (!candidate || !Number.isFinite(candidate.order)
      || !Number.isSafeInteger(candidate.pr) || candidate.pr < 1
      || typeof candidate.job !== 'string' || !candidate.job.trim()) {
      throw new Error('merge-queue-candidate-invalid');
    }
  }
  candidates.sort((a, b) => a.order - b.order);

  /** @type {import('./watch.mjs').MergeQueueAppliedMerge[]} */
  const applied = [];
  /** @type {import('./watch.mjs').MergeQueueWatchItem[]} */
  const items = [];
  for (const candidate of candidates) {
    if (already.has(candidate.pr)) continue;
    const reasons = [];
    if (candidate.standingMergeApproval !== true) reasons.push('merge-swarm-pr standing approval is off');
    if (candidate.prChecksGreen !== true) reasons.push('PR checks are not green');
    reasons.push(...(candidate.blockedReasons ?? []));

    let status = 'refused';
    let followUp;
    if (reasons.length === 0) {
      try {
        const result = await runMerge(input.root, [String(candidate.pr)]);
        if (result.status === 'merged') {
          status = 'merged';
          const view = input.prViews?.[String(candidate.pr)];
          followUp = formatPostMergeFollowUp({
            pr: candidate.pr,
            repo: result.repo ?? null,
            baseRefName: view && typeof view === 'object' && 'baseRefName' in view
              && typeof view.baseRefName === 'string' ? view.baseRefName : null,
            headRefOid: result.sha ?? null,
            defaultBranch: input.defaultBranch ?? null,
          });
        } else {
          status = result.status === 'refused' ? 'refused' : 'merge-failed';
          reasons.push(...(Array.isArray(result.reasons) && result.reasons.length
            ? result.reasons.map(String) : [String(result.reason ?? 'merge failed')]));
        }
      } catch (error) {
        status = 'merge-failed';
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (status === 'merged') {
      applied.push({ job: candidate.job, pr: candidate.pr, status, followUp });
      already.add(candidate.pr);
    } else {
      applied.push({ job: candidate.job, pr: candidate.pr,
        status: status === 'refused' ? 'refused' : 'merge-failed', reasons });
    }
    items.push({
      kind: 'merge-ready',
      code: status === 'merged' ? 'green-merge-merged'
        : status === 'refused' ? 'green-merge-refused' : 'green-merge-failed',
      severity: status === 'merged' ? 'info' : 'warn',
      action: 'merge-pr',
      reason: (status === 'merged'
        ? `merged PR #${candidate.pr} for job ${candidate.job} (standing approval merge-swarm-pr)`
        : `PR #${candidate.pr} for job ${candidate.job} was not merged: ${reasons.join('; ')}`).slice(0, 2000),
      job: candidate.job,
      ...(candidate.ticket ? { ticket: candidate.ticket } : {}),
      pr: candidate.pr,
      ...(followUp ? { followUp } : {}),
      recommendation: followUp ?? 'Resolve the blocked queue entry before merging later PRs.',
    });
    if (status !== 'merged') break;
  }
  return { applied, items };
}
