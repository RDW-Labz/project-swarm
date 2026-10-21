// SPDX-License-Identifier: Apache-2.0
// R-019 / T-0083: red-base failure records name the check, its exit code, and tail lines.
import { sanitizeText } from './journal.mjs';

export const BASE_CHECK_FAILURE_LINE_CAP = 5;
export const BASE_CHECK_FAILURE_TAIL_CHARS = 500;

const FAILURE_LINE_RE = /fail|error|assert|expected|✗|✕/i;
const FAILURE_LOCATION_RE = /[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?/g;

/** @typedef {{ name: string, exitCode: number|null, lines: string[], tail: string, status?: string }} BaseCheckFailure */

export function tailFailureLines(tail, cap = BASE_CHECK_FAILURE_LINE_CAP) {
  return String(tail ?? '').split('\n').map(line => line.trim()).filter(line => line && FAILURE_LINE_RE.test(line)).slice(-cap);
}

export function failureLocationsFromText(text) {
  return [...new Set([...String(text ?? '').matchAll(FAILURE_LOCATION_RE)].map(match => match[0].replace(/:\d+(-\d+)?$/, '')))];
}

export function baseCheckFailureRecord({ name, exitCode, tail, hint, status }) {
  const checkName = typeof name === 'string' ? name.trim() : '';
  if (!checkName) return null;
  const code = Number.isInteger(exitCode) ? exitCode : null;
  const combined = [tail, hint].filter(Boolean).join('\n');
  const sanitized = [...sanitizeText(combined)].slice(-BASE_CHECK_FAILURE_TAIL_CHARS).join('');
  const lines = tailFailureLines(sanitized);
  return {
    name: checkName,
    exitCode: code,
    lines,
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
    const code = Number.isInteger(entry.exitCode) ? entry.exitCode : null;
    const tail = typeof entry.tail === 'string'
      ? [...sanitizeText(entry.tail)].slice(-BASE_CHECK_FAILURE_TAIL_CHARS).join('')
      : '';
    const lines = Array.isArray(entry.lines)
      ? entry.lines.map(line => sanitizeText(line)).filter(Boolean).slice(-BASE_CHECK_FAILURE_LINE_CAP)
      : tailFailureLines(tail);
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
    : tailFailureLines(record.tail ?? '');
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
