// SPDX-License-Identifier: Apache-2.0
// Integrate complete scope-wave jobs through the merge queue while failed jobs stay out (R-017, T-0072).

import { integrateRun, readState } from './swarm.mjs';
import { isNonIntegratingRun } from './run-kind.mjs';

/**
 * Job ids for workers that finished successfully in a scope wave run.
 *
 * @param {{ jobs?: { id: string, status: string }[] }} state
 * @returns {string[]}
 */
export function passingScopeWaveJobIds(state) {
  return (state.jobs ?? []).filter(job => job.status === 'complete').map(job => job.id);
}

/**
 * Job ids left out of merge-queue integration (failed, timed out, still running, and so on).
 *
 * @param {{ jobs?: { id: string, status: string }[] }} state
 * @returns {string[]}
 */
export function skippedScopeWaveJobIds(state) {
  return (state.jobs ?? []).filter(job => job.status !== 'complete').map(job => job.id);
}

/**
 * Whether a merge-queue integrate result kept every integrated job green (bisect may have isolated a red one).
 *
 * @param {{ mergeQueue?: { state?: string, integrated?: string[], checkFailed?: unknown[], securityBlocked?: unknown[] } }} result
 * @returns {boolean}
 */
export function mergeQueueIntegrationSucceeded(result) {
  const queue = result?.mergeQueue;
  if (!queue || queue.state === 'final-check-failed') return false;
  if ((queue.checkFailed ?? []).length) return false;
  if ((queue.securityBlocked ?? []).length) return false;
  return (queue.integrated ?? []).length > 0;
}

/**
 * @typedef {Object} IntegratePassingScopeWaveOptions
 * @property {boolean} [mutants] Passed through when the merge queue allows it (plain `--queue` integration does not).
 * @property {boolean} [noFlakeCheck]
 * @property {number} [batchSize]
 * @property {boolean} [adaptive]
 * @property {boolean} [noChecks]
 * @property {import('node:child_process').SpawnOptions} [spawnImpl]
 * @property {Record<string, unknown>} [securityGate]
 */

/**
 * @typedef {Object} IntegratePassingScopeWaveResult
 * @property {boolean} integrated True when at least one complete job integrated and every integrated job passed queue checks.
 * @property {number} jobs Count of jobs recorded in {@link IntegratePassingScopeWaveResult.mergeQueue}.
 * @property {string[]} files Project-relative paths written by the merge queue.
 * @property {boolean} checksPassed False when a batch check or final full check failed (failed job bisected out).
 * @property {boolean} [mutantsPassed] Present when the integrate run reported mutants.
 * @property {string[]} passingJobIds Complete jobs that were eligible to integrate.
 * @property {string[]} skippedJobIds Jobs left out because they did not complete.
 * @property {string[]} [warnings]
 * @property {object} [mergeQueue] Persisted merge-queue snapshot from the run state.
 */

/**
 * Integrate every complete job in a scope wave through the merge queue. Incomplete jobs are
 * skipped (not integrated) while red batches are bisected so passing tickets still land.
 *
 * @param {string} root Project root.
 * @param {string} runId Scope wave run id.
 * @param {IntegratePassingScopeWaveOptions} [options] Integrate options (`queue` is always enabled).
 * @returns {Promise<IntegratePassingScopeWaveResult>}
 */
export async function integratePassingScopeWaveJobs(root, runId, options = {}) {
  const state = await readState(root, runId);
  if (isNonIntegratingRun(state, options.manifest ?? null)) {
    return {
      integrated: false,
      jobs: 0,
      files: [],
      checksPassed: true,
      passingJobIds: [],
      skippedJobIds: skippedScopeWaveJobIds(state),
      skipped: 'non-integrating-run',
    };
  }
  const passingJobIds = passingScopeWaveJobIds(state);
  const skippedJobIds = skippedScopeWaveJobIds(state);
  if (!passingJobIds.length) {
    return {
      integrated: false,
      jobs: 0,
      files: [],
      checksPassed: true,
      passingJobIds,
      skippedJobIds,
    };
  }
  const { queue: _queue, jobs: _jobs, salvage: _salvage, ...rest } = options;
  const result = await integrateRun(root, runId, { ...rest, queue: true });
  const checksPassed = mergeQueueIntegrationSucceeded(result);
  const jobs = result.mergeQueue?.integrated?.length ?? 0;
  return {
    integrated: jobs > 0 && checksPassed,
    jobs,
    files: result.files ?? [],
    checksPassed,
    ...(result.mutantsPassed !== undefined ? { mutantsPassed: result.mutantsPassed } : {}),
    passingJobIds,
    skippedJobIds,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.mergeQueue ? { mergeQueue: result.mergeQueue } : {}),
  };
}
