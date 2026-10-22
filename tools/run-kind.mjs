// SPDX-License-Identifier: Apache-2.0
import crypto from 'node:crypto';

/** Run ids created by doctor smoke/probe jobs (legacy runs without state flags). */
export const DOCTOR_RUN_ID_RE = /^doctor-(?:probe|smoke)-/;

/** Lane smoke / lane test runs (legacy ids). */
export const LANE_TEST_RUN_ID_RE = /^lane-(?:test|smoke)-/;

/** Bake-off and eval fixture runs. */
export const BAKEOFF_EVAL_RUN_ID_RE = /^(?:bakeoff|eval)-/;

/** Job ids inside doctor / lane smoke manifests. */
export const NON_INTEGRATING_JOB_ID_RE = /^(?:doctor-(?:probe|smoke)|lane-(?:test|smoke)|models-lane-(?:test|smoke)|probe)$/;

function jobList(manifest) {
  const jobs = manifest?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.filter(job => job && typeof job.id === 'string');
}

function manifestIntegrateOff(manifest) {
  return manifest && typeof manifest === 'object' && manifest.integrate === false;
}

function stateFlag(state) {
  return state && typeof state === 'object' && state.nonIntegrating === true;
}

function runIdPatterns(id) {
  if (typeof id !== 'string' || !id) return false;
  return DOCTOR_RUN_ID_RE.test(id) || LANE_TEST_RUN_ID_RE.test(id) || BAKEOFF_EVAL_RUN_ID_RE.test(id);
}

function jobIdPatterns(manifest) {
  return jobList(manifest).some(job => NON_INTEGRATING_JOB_ID_RE.test(job.id));
}

/**
 * True for smoke, lane-test, probe, bake-off, eval, and explicit no-integrate runs.
 *
 * @param {object|null|undefined} state Saved run state (id, status, nonIntegrating).
 * @param {object|null|undefined} manifest Run manifest (integrate: false, job ids).
 */
export function isNonIntegratingRun(state, manifest) {
  if (stateFlag(state)) return true;
  if (manifestIntegrateOff(manifest)) return true;
  const id = typeof state?.id === 'string' ? state.id : '';
  if (runIdPatterns(id)) return true;
  if (jobIdPatterns(manifest)) return true;
  return false;
}

/** Stable digest for integrate blocker cause strings (journal-safe). */
export function integrateCauseDigest(cause) {
  return crypto.createHash('sha256').update(String(cause ?? '')).digest('hex').slice(0, 16);
}

/**
 * Blocker id for integrate failures: `integrate-RUN` until a different cause needs a new id.
 *
 * @param {'integrate'|'integrate-checkout'} integrateKind
 * @param {string} runId
 * @param {string} cause
 * @param {{ events?: object[] }} [options]
 */
export function integrateBlockerIdForCause(integrateKind, runId, cause, { events = [] } = {}) {
  const base = integrateKind === 'integrate-checkout' ? `integrate-checkout-${runId}` : `integrate-${runId}`;
  if (integrateKind === 'integrate-checkout') return base;
  const causeText = String(cause ?? '');
  const list = Array.isArray(events) ? events : [];
  const seenCauses = new Set();
  for (const event of list) {
    if (event?.kind !== 'blocker' || event.integrateRun !== runId) continue;
    if (event.integrateKind !== 'integrate' && !String(event.id ?? '').startsWith('integrate-')) continue;
    if (event.integrateCause) seenCauses.add(String(event.integrateCause));
  }
  if (!seenCauses.size || seenCauses.has(causeText)) return base;
  return `${base}--${integrateCauseDigest(causeText)}`;
}
