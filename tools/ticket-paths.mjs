// SPDX-License-Identifier: Apache-2.0
// Validate ticket file paths against the tracked repo tree and suggest close matches (R-006).
import { lstatSync, statSync } from 'node:fs';
import path from 'node:path';
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

function pathExists(p, exists, repoSet) {
  if (typeof exists === 'function') return exists(p);
  return repoSet.has(normTicketPath(p));
}

function trackedFiles(repoFiles) {
  return (repoFiles ?? []).map(normTicketPath).filter(Boolean);
}

/** True when `wanted` names a folder, not a file in the tree (R-006 directory case). */
export function pathIsDirectory(wanted, repoFiles, root = null) {
  const want = normTicketPath(wanted);
  if (!want || want.endsWith('/')) return true;
  const files = trackedFiles(repoFiles);
  if (files.includes(want)) return false;
  if (files.some((f) => f.startsWith(`${want}/`))) return true;
  if (root) {
    try {
      return lstatSync(path.join(root, want)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

/** A build ticket may create a file when its parent directory exists in the repo or on disk. */
export function writeTargetAllowed(wanted, repoFiles, root = null) {
  const want = normTicketPath(wanted);
  const files = trackedFiles(repoFiles);
  const set = new Set(files);
  if (set.has(want)) return true;
  const parent = want.includes('/') ? want.slice(0, want.lastIndexOf('/')) : '';
  if (!parent) return true;
  if (set.has(parent)) return false;
  if (files.some((f) => f.startsWith(`${parent}/`))) return true;
  if (root) {
    try {
      return statSync(path.join(root, parent)).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

export function formatTicketPathRefusal(ticketId, err) {
  const reason = err.reason ?? (mustExist(err.field) ? 'missing file' : 'likely typo');
  let line = `${ticketId}: ${err.path} ${reason}`;
  if (err.suggestion) line += `; closest real path: ${err.suggestion}`;
  return line;
}

/**
 * @param {object} ticket
 * @param {{ repoFiles?: string[], exists?: (path: string) => boolean, root?: string|null }} options
 * @returns {{ ok: boolean, errors: { field: string, path: string, suggestion: string|null, reason?: string, message: string }[] }}
 */
export function validateTicketPaths(ticket, { repoFiles = [], exists, root = null } = {}) {
  const repoSet = new Set(trackedFiles(repoFiles));
  const have = (p, field) => {
    if (pathIsDirectory(p, repoFiles, root)) return false;
    if (pathExists(p, exists, repoSet)) return true;
    if (typeof exists === 'function') return false;
    if (WRITE_FIELDS.includes(field)) {
      const suggestion = closestRepoPath(p, repoFiles);
      const dist = suggestion ? levenshteinDistance(normTicketPath(p).toLowerCase(), normTicketPath(suggestion).toLowerCase()) : Infinity;
      if (isLikelyWriteTypo(p, suggestion, dist)) return false;
      if (writeTargetAllowed(p, repoFiles, root)) return true;
    }
    return repoSet.has(normTicketPath(p));
  };
  const errors = [];
  for (const { field, path: ticketPath } of listTicketPaths(ticket)) {
    if (pathIsDirectory(ticketPath, repoFiles, root)) {
      const suggestion = closestRepoPath(ticketPath, repoFiles);
      errors.push({
        field,
        path: ticketPath,
        suggestion,
        reason: 'is a directory',
        message: `${field} path is a directory: ${ticketPath}`,
      });
      continue;
    }
    if (have(ticketPath, field)) continue;
    const suggestion = closestRepoPath(ticketPath, repoFiles);
    const dist = suggestion ? levenshteinDistance(ticketPath.toLowerCase(), normTicketPath(suggestion).toLowerCase()) : Infinity;
    const reject = mustExist(field) || isLikelyWriteTypo(ticketPath, suggestion, dist);
    if (!reject) continue;
    const reason = mustExist(field) ? 'missing file' : 'likely typo';
    const message = suggestion
      ? `${field} path not in repo: ${ticketPath} (did you mean ${suggestion}?)`
      : `${field} path not in repo: ${ticketPath}`;
    errors.push({ field, path: ticketPath, suggestion, reason, message });
  }
  return { ok: errors.length === 0, errors };
}
