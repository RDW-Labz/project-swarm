// SPDX-License-Identifier: Apache-2.0
// Attach quarantined wave-failure outputs to retry manifests as read-only context (R-017, T-0071).

import {
  quarantineReadOnlyContext,
  readWaveFailureRecordFromProject,
  normalizeProjectRel,
} from './wave-quarantine.mjs';

/** Owner reason so retry jobs may read quarantined copies under `.swarm/project/wave-quarantine`. */
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
 * Merge sorted quarantine paths into a job's `context` without overlapping declared `outputs`.
 *
 * @param {object} job
 * @param {string[]} readOnlyPaths Project-relative paths (quarantine metadata and mirrored files).
 * @returns {object}
 */
export function applyQuarantineReadOnlyContextToJob(job, readOnlyPaths) {
  const paths = arr(readOnlyPaths).map((p) => normalizeProjectRel(p)).filter(Boolean);
  if (!paths.length) return job;
  const outputs = new Set(arr(job?.outputs).map((p) => normalizeProjectRel(p)));
  const context = [...arr(job?.context)];
  for (const rel of paths) {
    if (outputs.has(rel)) continue;
    if (!context.includes(rel)) context.push(rel);
  }
  return {
    ...job,
    context,
    allowProtectedContext: WAVE_QUARANTINE_READ_ONLY_REASON,
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
      if (exists(rel)) kept.push(rel);
      else warnings?.push(`${record.ticketId}: quarantine context path not readable: ${rel}`);
    }
    readOnly = kept;
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
