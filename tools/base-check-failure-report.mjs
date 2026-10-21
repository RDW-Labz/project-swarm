// SPDX-License-Identifier: Apache-2.0
// R-019 / T-0083: honest base checks — one run at a time per checkout (lock) and red-base
// failure records that name the check, its exit code, and tail output lines.
import { sanitizeText } from './journal.mjs';
import { acquireBaseCheckLock, withBaseCheckLock } from './base-check-lock.mjs';

export { acquireBaseCheckLock, withBaseCheckLock };

/** Lock file path relative to the checkout root (under `.swarm/project/`). */
export const BASE_CHECK_LOCK_REL = '.swarm/project/base-check.lock';

export const BASE_CHECK_FAILURE_LINE_CAP = 5;
export const BASE_CHECK_FAILURE_TAIL_CHARS = 500;

const FAILURE_LINE_RE = /fail|error|assert|expected|✗|✕/i;
const FAILURE_LOCATION_RE = /[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g;

/** @typedef {{ name: string, exitCode: number|null, lines: string[], tail: string, status?: string }} BaseCheckFailure */

export function normalizeCheckExitCode(exitCode) {
  if (exitCode == null) return null;
  if (typeof exitCode === 'number' && Number.isInteger(exitCode)) return exitCode;
  if (typeof exitCode === 'string' && /^-?\d+$/.test(exitCode.trim())) return Number.parseInt(exitCode, 10);
  return null;
}

/** Last non-empty lines from check output (failure-shaped lines when possible). */
export function tailFailureLines(tail, cap = BASE_CHECK_FAILURE_LINE_CAP) {
  return String(tail ?? '').split('\n').map(line => line.trim()).filter(line => line && FAILURE_LINE_RE.test(line)).slice(-cap);
}

/** Literal last non-empty lines from sanitized tail (for stored failure records). */
export function lastOutputLines(tail, cap = BASE_CHECK_FAILURE_LINE_CAP) {
  return String(tail ?? '').split('\n').map(line => line.trimEnd()).filter(line => line.trim()).slice(-cap);
}

export function failureLocationsFromText(text) {
  return [...new Set([...String(text ?? '').matchAll(FAILURE_LOCATION_RE)].map(match => match[0].replace(/:\d+(-\d+)?$/, '')))];
}

export function baseCheckFailureRecord({ name, exitCode, tail, hint, status }) {
  const checkName = typeof name === 'string' ? name.trim() : '';
  if (!checkName) return null;
  const code = normalizeCheckExitCode(exitCode);
  const combined = [tail, hint].filter(Boolean).join('\n');
  const sanitized = [...sanitizeText(combined)].slice(-BASE_CHECK_FAILURE_TAIL_CHARS).join('');
  const lines = lastOutputLines(sanitized);
  const highlighted = tailFailureLines(sanitized);
  return {
    name: checkName,
    exitCode: code,
    lines: highlighted.length ? highlighted : lines,
    tail: sanitized,
    ...(typeof status === 'string' && status !== 'passed' ? { status } : {}),
  };
}

/** @param {Record<string, unknown>|null|undefined} outcome runCheck / spawn outcome */
export function failureFromCheckOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || outcome.status === 'passed') return null;
  return baseCheckFailureRecord({
    name: outcome.name,
    exitCode: outcome.exitCode,
    tail: outcome.tail,
    hint: outcome.hint,
    status: outcome.status,
  });
}

/** @returns {BaseCheckFailure[]} */
export function normalizeBaseCheckFailures(failures) {
  const list = Array.isArray(failures) ? failures : [];
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ name: entry.trim(), exitCode: null, lines: [], tail: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const code = normalizeCheckExitCode(entry.exitCode);
    const tail = typeof entry.tail === 'string'
      ? [...sanitizeText(entry.tail)].slice(-BASE_CHECK_FAILURE_TAIL_CHARS).join('')
      : '';
    const lines = Array.isArray(entry.lines)
      ? entry.lines.map(line => sanitizeText(line)).filter(Boolean).slice(-BASE_CHECK_FAILURE_LINE_CAP)
      : (tailFailureLines(tail).length ? tailFailureLines(tail) : lastOutputLines(tail));
    out.push({
      name: entry.name.trim(),
      exitCode: code,
      lines,
      tail: tail || lines.join('\n'),
      ...(typeof entry.status === 'string' ? { status: entry.status } : {}),
    });
  }
  return out;
}

export function baseCheckFailureNames(failures) {
  return normalizeBaseCheckFailures(failures).map(failure => failure.name);
}

/** @param {BaseCheckFailure|string} failure */
export function formatBaseCheckFailureDetail(failure) {
  const record = typeof failure === 'string'
    ? { name: failure, exitCode: null, lines: [], tail: '' }
    : failure;
  if (!record?.name) return '';
  const exit = Number.isInteger(record.exitCode) ? ` exit ${record.exitCode}` : '';
  const lines = Array.isArray(record.lines) && record.lines.length
    ? record.lines
    : (tailFailureLines(record.tail ?? '').length ? tailFailureLines(record.tail ?? '') : lastOutputLines(record.tail ?? ''));
  if (lines.length) return `${record.name}${exit}: ${lines.join(' | ')}`;
  const oneLine = sanitizeText(String(record.tail ?? '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  return oneLine ? `${record.name}${exit}: ${oneLine}` : `${record.name}${exit}`;
}

/** Human-readable summary for logs, CLI refusal text, and inspect output. */
export function formatRedBaseFailureReport(failures) {
  const normalized = normalizeBaseCheckFailures(failures);
  if (!normalized.length) return 'unknown check';
  return normalized.map(formatBaseCheckFailureDetail).join('; ');
}

export function failureLocationsForFailures(failures) {
  const map = {};
  for (const failure of normalizeBaseCheckFailures(failures)) {
    const locations = failureLocationsFromText(`${failure.tail}\n${failure.lines.join('\n')}`);
    if (locations.length) map[failure.name] = locations;
  }
  return map;
}

export function recordBaseCheckFailure(failures, outcome) {
  const entry = failureFromCheckOutcome(outcome);
  if (!entry) return failures;
  return [...(Array.isArray(failures) ? failures : []), entry];
}

/**
 * Run base checks under the per-checkout lock and return rich failure records for any red outcome.
 * @template T
 * @param {string} root checkout root
 * @param {() => Promise<T>} run checks (typically spawn manifest checks and build a cache record)
 * @param {object} [lockOptions] forwarded to {@link withBaseCheckLock}
 * @returns {Promise<T>}
 */
export async function withLockedBaseCheckRun(root, run, lockOptions) {
  return withBaseCheckLock(root, run, lockOptions);
}

/**
 * @param {Record<string, unknown>|null|undefined} record base-check cache record or run outcome
 * @returns {string} refusal/detail text when status is red
 */
export function redBaseFailureMessage(record) {
  if (!record || typeof record !== 'object') return formatRedBaseFailureReport([]);
  const failures = record.failures ?? record.baseCheckFailures;
  return formatRedBaseFailureReport(failures);
}
