// SPDX-License-Identifier: Apache-2.0
// Validate ticket file paths against the tracked repo tree and suggest close matches (R-006).
import { isTicketRef } from './ticket-refs.mjs';

const READ_FIELDS = ['context', 'contracts'];
const WRITE_FIELDS = ['files', 'tests'];
const DELETE_FIELDS = ['deletes'];

export function normTicketPath(p) {
  return String(p).split('\\').join('/').replace(/^\.\//, '');
}

function fieldPaths(ticket, field) {
  const raw = ticket?.[field];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const path = normTicketPath(p);
    if (!path || path.endsWith('/')) continue;
    if (field === 'context' && isTicketRef(p)) continue;
    out.push(path);
  }
  return out;
}

/** Every repo-relative path a ticket names for reads, writes, or deletes. */
export function listTicketPaths(ticket) {
  const items = [];
  for (const field of [...READ_FIELDS, ...WRITE_FIELDS, ...DELETE_FIELDS]) {
    for (const path of fieldPaths(ticket, field)) items.push({ field, path });
  }
  return items;
}

export function levenshteinDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diagonal : 1 + Math.min(diagonal, prev[j], prev[j - 1]);
      diagonal = temp;
    }
  }
  return prev[b.length];
}

function scoreCandidate(want, cand) {
  const dist = levenshteinDistance(want, cand);
  const wantDir = want.includes('/') ? want.slice(0, want.lastIndexOf('/')) : '';
  const candDir = cand.includes('/') ? cand.slice(0, cand.lastIndexOf('/')) : '';
  const wantBase = want.split('/').pop();
  const candBase = cand.split('/').pop();
  let tie = 0;
  if (wantDir === candDir) tie -= 4;
  if (wantBase === candBase) tie -= 2;
  return { path: cand, dist, tie };
}

/** Closest tracked repo path to `wanted` (case-insensitive compare), or null when `repoFiles` is empty. */
export function closestRepoPath(wanted, repoFiles) {
  const want = normTicketPath(wanted).toLowerCase();
  if (!want) return null;
  const files = (repoFiles ?? []).map(normTicketPath).filter(Boolean);
  if (!files.length) return null;
  const exact = files.find((f) => f.toLowerCase() === want);
  if (exact) return exact;
  let best = null;
  for (const f of files) {
    const cand = f.toLowerCase();
    const scored = scoreCandidate(want, cand);
    if (!best || scored.dist < best.dist || (scored.dist === best.dist && scored.tie < best.tie)) best = { ...scored, path: f };
  }
  return best?.path ?? null;
}

function mustExist(field) {
  return READ_FIELDS.includes(field) || DELETE_FIELDS.includes(field);
}

function isLikelyWriteTypo(wanted, closest, dist) {
  if (!closest || dist === 0) return false;
  const w = normTicketPath(wanted);
  const c = normTicketPath(closest);
  const wDir = w.includes('/') ? w.slice(0, w.lastIndexOf('/')) : '';
  const cDir = c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : '';
  const wBase = w.split('/').pop();
  const cBase = c.split('/').pop();
  if (dist <= 2) return true;
  if (wDir === cDir && dist <= 4) return true;
  if (wBase === cBase && dist <= 6) return true;
  return false;
}

function pathExists(path, exists, repoSet) {
  if (typeof exists === 'function') return exists(path);
  return repoSet.has(path);
}

/**
 * @param {object} ticket
 * @param {{ repoFiles?: string[], exists?: (path: string) => boolean }} options
 * @returns {{ ok: boolean, errors: { field: string, path: string, suggestion: string|null, message: string }[] }}
 */
export function validateTicketPaths(ticket, { repoFiles = [], exists } = {}) {
  const repoSet = new Set((repoFiles ?? []).map(normTicketPath));
  const have = (p) => pathExists(p, exists, repoSet);
  const errors = [];
  for (const { field, path } of listTicketPaths(ticket)) {
    if (have(path)) continue;
    const suggestion = closestRepoPath(path, repoFiles);
    const dist = suggestion ? levenshteinDistance(path.toLowerCase(), normTicketPath(suggestion).toLowerCase()) : Infinity;
    const reject = mustExist(field) || isLikelyWriteTypo(path, suggestion, dist);
    if (!reject) continue;
    const message = suggestion
      ? `${field} path not in repo: ${path} (did you mean ${suggestion}?)`
      : `${field} path not in repo: ${path}`;
    errors.push({ field, path, suggestion, message });
  }
  return { ok: errors.length === 0, errors };
}
