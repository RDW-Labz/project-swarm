// SPDX-License-Identifier: Apache-2.0
// Attach quarantined wave-failure outputs to retry manifests as read-only context (R-017, T-0071).

import { ticketsToManifest } from './ticket-manifest.mjs';
import {
  quarantineReadOnlyContext,
  readWaveFailureRecordFromProject,
  normalizeProjectRel,
  WAVE_QUARANTINE_ROOT,
  isWaveQuarantinePath,
} from './wave-quarantine.mjs';

export { WAVE_QUARANTINE_ROOT, quarantineReadOnlyContextForRetry } from './wave-quarantine.mjs';

/** Owner reason so retry jobs may read quarantined copies under {@link WAVE_QUARANTINE_ROOT}. */
export const WAVE_QUARANTINE_READ_ONLY_REASON =
  'Quarantined outputs from the failed scope wave (read-only context for this retry).';

/**
 * @typedef {import('./wave-quarantine.mjs').WaveFailureRecord} WaveFailureRecord
 */

const arr = (value) => (Array.isArray(value) ? value : []);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingWaveFailureRecord(error) {
  return error?.code === 'ENOENT';
}

/**
 * Keep only paths under the wave quarantine tree (metadata and mirrored outputs).
 *
 * @param {string[]} paths
 * @returns {string[]}
 */
function quarantineContextPathsOnly(paths) {
  return arr(paths)
    .map((p) => normalizeProjectRel(p))
    .filter((rel) => rel && isWaveQuarantinePath(rel));
}

/**
 * Merge sorted quarantine paths into a job's `context` without overlapping declared `outputs`.
 *
 * @param {object} job
 * @param {string[]} readOnlyPaths Project-relative paths (quarantine metadata and mirrored files).
 * @returns {object}
 */
export function applyQuarantineReadOnlyContextToJob(job, readOnlyPaths) {
  const paths = quarantineContextPathsOnly(readOnlyPaths);
  if (!paths.length) return job;
  const outputs = new Set(arr(job?.outputs).map((p) => normalizeProjectRel(p)));
  const context = [...arr(job?.context)];
  for (const rel of paths) {
    if (outputs.has(rel)) continue;
    if (!context.includes(rel)) context.push(rel);
  }
  const allowProtectedContext = job?.allowProtectedContext
    ? `${job.allowProtectedContext}; ${WAVE_QUARANTINE_READ_ONLY_REASON}`
    : WAVE_QUARANTINE_READ_ONLY_REASON;
  return {
    ...job,
    context,
    allowProtectedContext,
  };
}

/**
 * @param {object} job
 * @param {WaveFailureRecord} record
 * @param {{ exists?: (rel: string) => boolean, warnings?: string[] }} [options]
 * @returns {object}
 */
export function attachQuarantineReadOnlyContextFromRecord(job, record, options = {}) {
  const { exists, warnings } = options;
  let readOnly = quarantineReadOnlyContext(record);
  if (typeof exists === 'function') {
    const kept = [];
    for (const rel of readOnly) {
      if (!isWaveQuarantinePath(rel)) {
        warnings?.push(`${record.ticketId}: quarantine context path outside ${WAVE_QUARANTINE_ROOT}: ${rel}`);
        continue;
      }
      if (exists(rel)) kept.push(rel);
      else warnings?.push(`${record.ticketId}: quarantine context path not readable: ${rel}`);
    }
    readOnly = kept;
  } else {
    readOnly = quarantineContextPathsOnly(readOnly);
  }
  return applyQuarantineReadOnlyContextToJob(job, readOnly);
}

/**
 * @param {object} job
 * @param {{ root: string, runId: string, ticketId: string, exists?: (rel: string) => boolean, warnings?: string[] }} ids
 * @returns {Promise<object>}
 */
export async function attachQuarantineReadOnlyContextToRetryJob(job, ids) {
  const { root, runId, ticketId, exists, warnings } = ids ?? {};
  if (!root || !runId || !ticketId) return job;
  try {
    const record = await readWaveFailureRecordFromProject({ root, runId, ticketId });
    return attachQuarantineReadOnlyContextFromRecord(job, record, { exists, warnings });
  } catch (error) {
    if (isMissingWaveFailureRecord(error)) return job;
    throw error;
  }
}

/**
 * Attach quarantined outputs as read-only context on every matching job in a retry manifest.
 *
 * @param {object} manifest
 * @param {{
 *   root: string,
 *   runId: string,
 *   jobIds?: string[],
 *   exists?: (rel: string) => boolean,
 * }} options
 * @returns {Promise<{ manifest: object, warnings: string[] }>}
 */
export async function attachQuarantineReadOnlyContextToRetryManifest(manifest, options = {}) {
  const { root, runId, jobIds, exists } = options;
  const warnings = [];
  if (!manifest || !root || !runId) {
    return { manifest, warnings };
  }
  const limit = jobIds ? new Set(arr(jobIds).map(String)) : null;
  const jobs = [];
  for (const job of arr(manifest.jobs)) {
    if (!job || typeof job.id !== 'string') {
      jobs.push(job);
      continue;
    }
    if (limit && !limit.has(job.id)) {
      jobs.push(job);
      continue;
    }
    jobs.push(
      await attachQuarantineReadOnlyContextToRetryJob(job, {
        root,
        runId,
        ticketId: job.id,
        exists,
        warnings,
      }),
    );
  }
  return { manifest: { ...manifest, jobs }, warnings };
}

/**
 * Build a scope-wave retry manifest from ready tickets, then attach quarantined prior outputs
 * (from {@link moveFailedTicketOutputsToQuarantine} / {@link quarantineScopeWaveFailures}) as
 * read-only job context when `root` and `runId` are set.
 *
 * @param {object[]} tickets
 * @param {object} opts `ticketsToManifest` options plus optional `root` and `runId` for quarantine context.
 * @returns {Promise<{ manifest: object, warnings: string[], skipped: string[] }>}
 */
export async function ticketsToRetryManifest(tickets, opts = {}) {
  const { root, runId, ...manifestOpts } = opts;
  const built = ticketsToManifest(tickets, manifestOpts);
  const warnings = [...built.warnings];
  let manifest = built.manifest;
  if (root && runId) {
    const exists = manifestOpts.contextEnv?.exists;
    const attached = await attachQuarantineReadOnlyContextToRetryManifest(manifest, {
      root,
      runId,
      exists,
    });
    manifest = attached.manifest;
    warnings.push(...attached.warnings);
  }
  return { manifest, warnings, skipped: built.skipped };
}
