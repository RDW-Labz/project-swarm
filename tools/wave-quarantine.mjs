// SPDX-License-Identifier: Apache-2.0
// Move failed ticket outputs into quarantine after a scope wave failure (R-017, T-0070).

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WAVE_FAILURE_VERSION,
  WAVE_QUARANTINE_ROOT,
  WAVE_FAILURE_BASENAME,
  WAVE_QUARANTINE_FILES_DIR,
  normalizeProjectRel,
  assertSafeProjectRel,
  isWaveQuarantinePath,
  waveQuarantineOutputEntry,
  waveFailureRecordRel,
  buildWaveFailureRecord,
  quarantineReadOnlyContext,
  projectAbsPath,
  parseWaveFailureRecord,
} from './wave-quarantine-types.mjs';

export {
  WAVE_FAILURE_VERSION,
  WAVE_QUARANTINE_ROOT,
  WAVE_FAILURE_BASENAME,
  WAVE_QUARANTINE_FILES_DIR,
  normalizeProjectRel,
  isSafeProjectRel,
  assertSafeProjectRel,
  assertRunId,
  assertTicketId,
  waveQuarantineTicketDir,
  waveFailureRecordRel,
  quarantinedOutputRel,
  isWaveQuarantinePath,
  waveQuarantineOutputEntry,
  quarantineReadOnlyContext,
  projectAbsPath,
  buildWaveFailureRecord,
  validateWaveFailureRecord,
  parseWaveFailureRecord,
} from './wave-quarantine-types.mjs';

/**
 * @typedef {import('./wave-quarantine-types.mjs').WaveFailureRecord} WaveFailureRecord
 * @typedef {import('./wave-quarantine-types.mjs').WaveQuarantineOutput} WaveQuarantineOutput
 */

/**
 * @typedef {Object} ScopeWaveFailedTicket
 * @property {string} ticketId Ledger ticket id for the failed worker.
 * @property {string} jobId Manifest job id for the failed worker.
 * @property {string[]} [outputPaths] Declared job output paths to quarantine.
 * @property {string} [reason] Short failure summary for the wave-failure record.
 */

/**
 * @param {string} absPath
 * @param {unknown} data
 */
async function atomicJsonWrite(absPath, data) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await fs.rename(tmp, absPath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Move one project file into a quarantine destination (rename, or copy+unlink across devices).
 *
 * @param {string} root
 * @param {string} fromRel
 * @param {string} toRel
 */
async function moveProjectFileIntoQuarantine(root, fromRel, toRel) {
  const from = normalizeProjectRel(fromRel);
  const to = normalizeProjectRel(toRel);
  assertSafeProjectRel(from, 'source');
  assertSafeProjectRel(to, 'dest');
  if (!isWaveQuarantinePath(to)) {
    throw Object.assign(new Error(`wave-quarantine-dest-outside-root: ${to.slice(0, 120)}`), { code: 'wave-quarantine-dest-outside-root' });
  }
  const fromAbs = projectAbsPath(root, from);
  const toAbs = projectAbsPath(root, to);
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  try {
    await fs.rename(fromAbs, toAbs);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(fromAbs, toAbs);
    await fs.unlink(fromAbs);
  }
}

/**
 * After a scope wave failure, move declared ticket outputs into quarantine and persist
 * {@link WaveFailureRecord} metadata beside them.
 *
 * @param {{
 *   root: string,
 *   runId: string,
 *   wave: number,
 *   ticketId: string,
 *   jobId: string,
 *   outputPaths?: string[],
 *   reason?: string,
 *   passingTicketIds?: string[],
 *   failedAt?: string,
 * }} args
 * @returns {Promise<WaveFailureRecord>}
 */
export async function moveFailedTicketOutputsToQuarantine(args) {
  const {
    root,
    runId,
    wave,
    ticketId,
    jobId,
    outputPaths = [],
    reason,
    passingTicketIds = [],
    failedAt,
  } = args ?? {};
  if (!root || typeof root !== 'string') {
    throw Object.assign(new Error('wave-quarantine-missing-root'), { code: 'wave-quarantine-missing-root' });
  }
  const outputs = [];
  const seen = new Set();
  for (const raw of outputPaths) {
    const source = normalizeProjectRel(raw);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    if (isWaveQuarantinePath(source)) continue;
    assertSafeProjectRel(source, 'output');
    const entry = waveQuarantineOutputEntry({ runId, ticketId, sourcePath: source });
    const fromAbs = projectAbsPath(root, source);
    const stat = await fs.stat(fromAbs).catch(() => null);
    if (!stat?.isFile()) continue;
    await moveProjectFileIntoQuarantine(root, source, entry.path);
    outputs.push(entry);
  }
  const record = buildWaveFailureRecord({
    runId,
    wave,
    ticketId,
    jobId,
    failedAt,
    reason,
    outputs,
    passingTicketIds,
  });
  await atomicJsonWrite(projectAbsPath(root, waveFailureRecordRel({ runId, ticketId })), record);
  return record;
}

/**
 * Quarantine every failed ticket in a scope wave (automatic step after wave failure).
 *
 * @param {{
 *   root: string,
 *   runId: string,
 *   wave: number,
 *   failedTickets: ScopeWaveFailedTicket[],
 *   passingTicketIds?: string[],
 *   failedAt?: string,
 * }} args
 * @returns {Promise<WaveFailureRecord[]>}
 */
export async function quarantineScopeWaveFailures(args) {
  const {
    root,
    runId,
    wave,
    failedTickets = [],
    passingTicketIds = [],
    failedAt,
  } = args ?? {};
  const passing = [...new Set(passingTicketIds.map(String))].sort();
  const records = [];
  for (const failed of failedTickets) {
    if (!failed || typeof failed !== 'object') continue;
    const { ticketId, jobId, outputPaths, reason } = failed;
    const record = await moveFailedTicketOutputsToQuarantine({
      root,
      runId,
      wave,
      ticketId,
      jobId,
      outputPaths: Array.isArray(outputPaths) ? outputPaths : [],
      reason,
      passingTicketIds: passing.filter((id) => id !== ticketId),
      failedAt,
    });
    records.push(record);
  }
  return records;
}

/**
 * @param {{ root: string, runId: string, ticketId: string }} ids
 * @returns {Promise<WaveFailureRecord>}
 */
export async function readWaveFailureRecordFromProject(ids) {
  const { root, runId, ticketId } = ids ?? {};
  const rel = waveFailureRecordRel({ runId, ticketId });
  const raw = JSON.parse(await fs.readFile(projectAbsPath(root, rel), 'utf8'));
  return parseWaveFailureRecord(raw);
}

/**
 * Load quarantine metadata and return project-relative paths for a ticket retry (read-only context).
 *
 * @param {{ root: string, runId: string, ticketId: string }} ids
 * @returns {Promise<string[]>}
 */
export async function quarantineReadOnlyContextForRetry(ids) {
  const record = await readWaveFailureRecordFromProject(ids);
  return quarantineReadOnlyContext(record);
}

/**
 * Attach quarantined files and wave-failure metadata to a retry job manifest as read-only context.
 *
 * @param {object} job
 * @param {{ root: string, runId: string, ticketId: string }} ids
 * @returns {Promise<object>}
 */
export async function attachQuarantineReadOnlyContextToRetryJob(job, ids) {
  const readOnly = await quarantineReadOnlyContextForRetry(ids);
  const context = [...(Array.isArray(job?.context) ? job.context : [])];
  for (const file of readOnly) {
    if (!context.includes(file)) context.push(file);
  }
  return { ...job, context };
}

/**
 * Same as {@link attachQuarantineReadOnlyContextToRetryJob} when the failure record is already loaded.
 *
 * @param {object} job
 * @param {WaveFailureRecord} record
 * @returns {object}
 */
export function attachQuarantineReadOnlyContextFromRecord(job, record) {
  const readOnly = quarantineReadOnlyContext(record);
  const context = [...(Array.isArray(job?.context) ? job.context : [])];
  for (const file of readOnly) {
    if (!context.includes(file)) context.push(file);
  }
  return { ...job, context };
}
