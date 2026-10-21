// SPDX-License-Identifier: Apache-2.0
// Shared quarantine folder layout, wave-failure records, moves, and retry read-only context (R-017).

import fs from 'node:fs/promises';
import path from 'node:path';

const norm = (value) => String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TICKET_ID_RE = /^T-[0-9]{4,}$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Schema version for {@link WaveFailureRecord} JSON. */
export const WAVE_FAILURE_VERSION = 1;

/** Project-relative root where failed ticket outputs are copied (swarm-internal). */
export const WAVE_QUARANTINE_ROOT = '.swarm/project/wave-quarantine';

/** Metadata file name inside each ticket's quarantine folder. */
export const WAVE_FAILURE_BASENAME = 'wave-failure.json';

/** Subdirectory under a ticket quarantine folder holding mirrored output bytes. */
export const WAVE_QUARANTINE_FILES_DIR = 'files';

/**
 * @typedef {Object} WaveQuarantineOutput
 * @property {string} source Declared job output path before quarantine.
 * @property {string} path Project-relative path of the quarantined copy (under {@link WAVE_QUARANTINE_ROOT}).
 * @exports WaveQuarantineOutput
 */

/**
 * Persisted metadata when a ticket fails a scope wave and its outputs are quarantined.
 *
 * @typedef {Object} WaveFailureRecord
 * @property {number} version {@link WAVE_FAILURE_VERSION}
 * @property {string} runId Scope run that owned the wave.
 * @property {number} wave 1-based wave index from `swarm go --scope`.
 * @property {string} ticketId Ledger ticket id (for example `T-0069`).
 * @property {string} jobId Manifest job id for the failed worker.
 * @property {string} failedAt ISO-8601 timestamp.
 * @property {string} [reason] Short failure summary (untrusted log text for humans).
 * @property {WaveQuarantineOutput[]} outputs Quarantined copies of declared outputs.
 * @property {string[]} [passingTicketIds] Other tickets in the same wave that integrated.
 * @exports WaveFailureRecord
 */

/**
 * @param {string} rel
 * @returns {string}
 */
export function normalizeProjectRel(rel) {
  return norm(rel);
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isSafeProjectRel(rel) {
  const p = normalizeProjectRel(rel);
  if (!p || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) return false;
  const parts = p.split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}

/**
 * @param {string} rel
 * @param {string} [label]
 */
export function assertSafeProjectRel(rel, label = 'path') {
  if (!isSafeProjectRel(rel)) {
    throw Object.assign(new Error(`wave-quarantine-unsafe-${label}: ${String(rel).slice(0, 120)}`), { code: 'wave-quarantine-unsafe-path' });
  }
}

/**
 * @param {string} runId
 */
export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || runId === '.' || runId === '..') {
    throw Object.assign(new Error(`wave-quarantine-bad-run-id: ${String(runId).slice(0, 40)}`), { code: 'wave-quarantine-bad-run-id' });
  }
}

/**
 * @param {string} ticketId
 */
export function assertTicketId(ticketId) {
  if (typeof ticketId !== 'string' || !TICKET_ID_RE.test(ticketId)) {
    throw Object.assign(new Error(`wave-quarantine-bad-ticket-id: ${String(ticketId).slice(0, 40)}`), { code: 'wave-quarantine-bad-ticket-id' });
  }
}

/**
 * @param {{ runId: string, ticketId: string }} ids
 * @returns {string}
 */
export function waveQuarantineTicketDir({ runId, ticketId }) {
  assertRunId(runId);
  assertTicketId(ticketId);
  return `${WAVE_QUARANTINE_ROOT}/${runId}/${ticketId}`;
}

/**
 * @param {{ runId: string, ticketId: string }} ids
 * @returns {string}
 */
export function waveFailureRecordRel({ runId, ticketId }) {
  return `${waveQuarantineTicketDir({ runId, ticketId })}/${WAVE_FAILURE_BASENAME}`;
}

/**
 * @param {{ runId: string, ticketId: string, sourcePath: string }} args
 * @returns {string}
 */
export function quarantinedOutputRel({ runId, ticketId, sourcePath }) {
  assertSafeProjectRel(sourcePath, 'source');
  return `${waveQuarantineTicketDir({ runId, ticketId })}/${WAVE_QUARANTINE_FILES_DIR}/${normalizeProjectRel(sourcePath)}`;
}

/**
 * True when `rel` is under {@link WAVE_QUARANTINE_ROOT} (project-relative, forward slashes).
 *
 * @param {string} rel
 * @returns {boolean}
 */
export function isWaveQuarantinePath(rel) {
  const p = normalizeProjectRel(rel).toLowerCase();
  const root = WAVE_QUARANTINE_ROOT.toLowerCase();
  return p === root || p.startsWith(`${root}/`);
}

/**
 * Build a {@link WaveQuarantineOutput} entry for a declared output file.
 *
 * @param {{ runId: string, ticketId: string, sourcePath: string }} args
 * @returns {WaveQuarantineOutput}
 */
export function waveQuarantineOutputEntry({ runId, ticketId, sourcePath }) {
  const source = normalizeProjectRel(sourcePath);
  return { source, path: quarantinedOutputRel({ runId, ticketId, sourcePath: source }) };
}

/**
 * @param {WaveFailureRecord} record
 * @returns {string[]}
 */
export function quarantineReadOnlyContext(record) {
  const errors = validateWaveFailureRecord(record);
  if (errors.length) {
    throw Object.assign(new Error(errors[0]), { code: 'wave-failure-invalid', errors });
  }
  const paths = new Set([waveFailureRecordRel({ runId: record.runId, ticketId: record.ticketId })]);
  for (const output of record.outputs) paths.add(normalizeProjectRel(output.path));
  return [...paths].sort();
}

/**
 * Absolute path for a safe project-relative `rel` under `root`.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
export function projectAbsPath(root, rel) {
  assertSafeProjectRel(rel);
  const rootAbs = path.resolve(String(root ?? ''));
  const abs = path.resolve(rootAbs, ...normalizeProjectRel(rel).split('/'));
  const back = path.relative(rootAbs, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw Object.assign(new Error(`wave-quarantine-escapes-root: ${normalizeProjectRel(rel).slice(0, 120)}`), { code: 'wave-quarantine-escapes-root' });
  }
  return abs;
}

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

/**
 * @param {{
 *   runId: string,
 *   wave: number,
 *   ticketId: string,
 *   jobId: string,
 *   failedAt?: string,
 *   reason?: string,
 *   outputs?: WaveQuarantineOutput[],
 *   passingTicketIds?: string[],
 * }} fields
 * @returns {WaveFailureRecord}
 */
export function buildWaveFailureRecord(fields) {
  const {
    runId,
    wave,
    ticketId,
    jobId,
    failedAt = new Date().toISOString(),
    reason,
    outputs = [],
    passingTicketIds = [],
  } = fields ?? {};
  assertRunId(runId);
  assertTicketId(ticketId);
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw Object.assign(new Error(`wave-quarantine-bad-job-id: ${String(jobId).slice(0, 40)}`), { code: 'wave-quarantine-bad-job-id' });
  }
  if (!Number.isInteger(wave) || wave < 1) {
    throw Object.assign(new Error(`wave-quarantine-bad-wave: ${String(wave)}`), { code: 'wave-quarantine-bad-wave' });
  }
  if (typeof failedAt !== 'string' || Number.isNaN(Date.parse(failedAt))) {
    throw Object.assign(new Error('wave-quarantine-bad-failed-at'), { code: 'wave-quarantine-bad-failed-at' });
  }
  const record = {
    version: WAVE_FAILURE_VERSION,
    runId,
    wave,
    ticketId,
    jobId,
    failedAt,
    outputs: outputs.map((entry) => ({
      source: normalizeProjectRel(entry.source),
      path: normalizeProjectRel(entry.path),
    })),
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim().slice(0, 2000) } : {}),
    ...(passingTicketIds.length ? { passingTicketIds: [...new Set(passingTicketIds.map(String))].sort() } : {}),
  };
  const errors = validateWaveFailureRecord(record);
  if (errors.length) {
    throw Object.assign(new Error(errors[0]), { code: 'wave-failure-invalid', errors });
  }
  return record;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function validateWaveFailureRecord(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('wave-failure must be an object');
    return errors;
  }
  const record = value;
  if (record.version !== WAVE_FAILURE_VERSION) errors.push(`version must be ${WAVE_FAILURE_VERSION}`);
  if (typeof record.runId !== 'string' || !RUN_ID_RE.test(record.runId)) errors.push('runId is invalid');
  if (!Number.isInteger(record.wave) || record.wave < 1) errors.push('wave must be a positive integer');
  if (typeof record.ticketId !== 'string' || !TICKET_ID_RE.test(record.ticketId)) errors.push('ticketId is invalid');
  if (typeof record.jobId !== 'string' || !JOB_ID_RE.test(record.jobId)) errors.push('jobId is invalid');
  if (typeof record.failedAt !== 'string' || Number.isNaN(Date.parse(record.failedAt))) errors.push('failedAt must be an ISO timestamp');
  if (record.reason !== undefined && (typeof record.reason !== 'string' || !record.reason.trim())) errors.push('reason must be a non-empty string when set');
  if (!Array.isArray(record.outputs)) {
    errors.push('outputs must be an array');
  } else {
    const idsOk = typeof record.runId === 'string' && RUN_ID_RE.test(record.runId)
      && typeof record.ticketId === 'string' && TICKET_ID_RE.test(record.ticketId);
    const filesPrefix = idsOk
      ? `${WAVE_QUARANTINE_ROOT}/${record.runId}/${record.ticketId}/${WAVE_QUARANTINE_FILES_DIR}/`
      : null;
    const seen = new Set();
    for (const [index, entry] of record.outputs.entries()) {
      if (!entry || typeof entry !== 'object') {
        errors.push(`outputs[${index}] must be an object`);
        continue;
      }
      const source = normalizeProjectRel(entry.source);
      const path = normalizeProjectRel(entry.path);
      if (!isSafeProjectRel(source)) errors.push(`outputs[${index}].source is unsafe`);
      if (!isSafeProjectRel(path)) errors.push(`outputs[${index}].path is unsafe`);
      if (!isWaveQuarantinePath(path)) errors.push(`outputs[${index}].path must stay under ${WAVE_QUARANTINE_ROOT}`);
      if (filesPrefix && path !== `${filesPrefix}${source}`) {
        errors.push(`outputs[${index}].path must mirror source under ${WAVE_QUARANTINE_FILES_DIR}`);
      }
      if (seen.has(source)) errors.push(`outputs[${index}].source is duplicated`);
      seen.add(source);
    }
  }
  if (record.passingTicketIds !== undefined) {
    if (!Array.isArray(record.passingTicketIds)) errors.push('passingTicketIds must be an array');
    else {
      const seen = new Set();
      for (const [index, id] of record.passingTicketIds.entries()) {
        if (typeof id !== 'string' || !TICKET_ID_RE.test(id)) errors.push(`passingTicketIds[${index}] is invalid`);
        else if (seen.has(id)) errors.push(`passingTicketIds[${index}] is duplicated`);
        else seen.add(id);
      }
      if (typeof record.ticketId === 'string' && record.passingTicketIds.includes(record.ticketId)) {
        errors.push('passingTicketIds must not include the failed ticket');
      }
    }
  }
  for (const key of Object.keys(record)) {
    if (!['version', 'runId', 'wave', 'ticketId', 'jobId', 'failedAt', 'reason', 'outputs', 'passingTicketIds'].includes(key)) {
      errors.push(`unknown key: ${key}`);
    }
  }
  return errors;
}

/**
 * @param {unknown} value
 * @returns {WaveFailureRecord}
 */
export function parseWaveFailureRecord(value) {
  const errors = validateWaveFailureRecord(value);
  if (errors.length) {
    throw Object.assign(new Error(errors[0]), { code: 'wave-failure-invalid', errors });
  }
  return value;
}
