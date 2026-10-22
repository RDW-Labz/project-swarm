// SPDX-License-Identifier: Apache-2.0
// Validate ticket file paths against the tracked repo tree and suggest close matches (R-006).
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { isTicketRef } from './ticket-refs.mjs';

const READ_FIELDS = ['context', 'contracts'];
const WRITE_FIELDS = ['files'];
const OUTPUT_TEST_FIELDS = ['tests'];
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
  for (const field of [...READ_FIELDS, ...WRITE_FIELDS, ...OUTPUT_TEST_FIELDS, ...DELETE_FIELDS]) {
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

function sameExtension(wanted, candidate) {
  const w = normTicketPath(wanted);
  const c = normTicketPath(candidate);
  const wExt = path.posix.extname(w).toLowerCase();
  const cExt = path.posix.extname(c).toLowerCase();
  if (!wExt && !cExt) return true;
  if (wExt === cExt) return true;
  const wStem = w.slice(0, -wExt.length);
  const cStem = c.slice(0, -cExt.length);
  if (wStem === cStem && levenshteinDistance(wExt, cExt) <= 1) return true;
  return false;
}

export function typoDistanceLimit(wanted) {
  const len = normTicketPath(wanted).length;
  return Math.max(2, Math.ceil(len * 0.2));
}

/** Closest tracked repo path to `wanted` (case-insensitive), or null when none qualifies. */
export function closestRepoPath(wanted, repoFiles) {
  const want = normTicketPath(wanted).toLowerCase();
  if (!want) return null;
  const files = (repoFiles ?? []).map(normTicketPath).filter(Boolean);
  if (!files.length) return null;
  const exact = files.find((f) => f.toLowerCase() === want);
  if (exact) return exact;
  const limit = typoDistanceLimit(wanted);
  let best = null;
  for (const f of files) {
    if (!sameExtension(wanted, f)) continue;
    const cand = f.toLowerCase();
    const scored = scoreCandidate(want, cand);
    if (scored.dist > limit) continue;
    if (!best || scored.dist < best.dist || (scored.dist === best.dist && scored.tie < best.tie)) best = { ...scored, path: f };
  }
  return best?.path ?? null;
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

function isOutputTestPath(ticketPath, ticket) {
  const files = new Set((ticket?.files ?? []).map(normTicketPath));
  return files.has(normTicketPath(ticketPath));
}

function fieldKind(field, ticketPath, ticket) {
  if (DELETE_FIELDS.includes(field)) return 'delete';
  if (WRITE_FIELDS.includes(field)) return 'write';
  if (field === 'tests') {
    if (isOutputTestPath(ticketPath, ticket)) return 'write';
    if (ticket?.type === 'test') return 'read';
    return 'write';
  }
  return 'read';
}

function likelyTypo(wanted, repoFiles) {
  const suggestion = closestRepoPath(wanted, repoFiles);
  if (!suggestion) return null;
  const dist = levenshteinDistance(
    normTicketPath(wanted).toLowerCase(),
    normTicketPath(suggestion).toLowerCase(),
  );
  if (dist > typoDistanceLimit(wanted)) return null;
  return suggestion;
}

function shouldValidatePath(field, ticketPath, priorTicket) {
  if (!priorTicket) return true;
  const prev = new Set((priorTicket[field] ?? []).map(normTicketPath));
  return !prev.has(normTicketPath(ticketPath));
}

export function formatTicketPathRefusal(ticketId, err) {
  const reason = err.reason ?? 'missing file';
  let line = `${ticketId}: ${err.path} ${reason}`;
  if (err.suggestion) line += `; closest real path: ${err.suggestion}`;
  return line;
}

export function formatTicketPathWarning(ticketId, warn) {
  if (warn.code === 'similar-new-file') {
    return `${ticketId}: ${warn.path} similar-new-file (near ${warn.suggestion})`;
  }
  return `${ticketId}: ${warn.path} ${warn.message ?? warn.code ?? 'warning'}`;
}

/**
 * @param {object} ticket
 * @param {{ repoFiles?: string[], exists?: (path: string) => boolean, root?: string|null, priorTicket?: object|null }} options
 *   priorTicket: on edits, only paths newly added to each list are validated
 * @returns {{ ok: boolean, errors: object[], warnings: object[] }}
 */
export function validateTicketPaths(ticket, { repoFiles = [], exists, root = null, priorTicket = null } = {}) {
  const repoSet = new Set(trackedFiles(repoFiles));
  const errors = [];
  const warnings = [];
  for (const { field, path: ticketPath } of listTicketPaths(ticket)) {
    if (!shouldValidatePath(field, ticketPath, priorTicket)) continue;

    if (pathIsDirectory(ticketPath, repoFiles, root)) {
      errors.push({
        field,
        path: ticketPath,
        suggestion: null,
        reason: 'is a directory',
        message: `${field} path is a directory: ${ticketPath}`,
      });
      continue;
    }

    const kind = fieldKind(field, ticketPath, ticket);
    if (kind === 'delete') {
      const suggestion = likelyTypo(ticketPath, repoFiles);
      if (suggestion) {
        errors.push({
          field,
          path: ticketPath,
          suggestion,
          reason: 'likely typo',
          message: `${field} path not in repo: ${ticketPath} (did you mean ${suggestion}?)`,
        });
      }
      continue;
    }

    const existsInRepo = pathExists(ticketPath, exists, repoSet);
    if (existsInRepo) continue;

    if (kind === 'write') {
      const suggestion = likelyTypo(ticketPath, repoFiles);
      if (suggestion) {
        const dist = levenshteinDistance(
          normTicketPath(ticketPath).toLowerCase(),
          normTicketPath(suggestion).toLowerCase(),
        );
        const limit = typoDistanceLimit(ticketPath);
        const payload = {
          field,
          path: ticketPath,
          suggestion,
          message: `${field} path not in repo: ${ticketPath} (did you mean ${suggestion}?)`,
        };
        if (dist >= limit) {
          warnings.push({
            code: 'similar-new-file',
            ...payload,
            message: `${field} path not in repo: ${ticketPath} (similar to existing ${suggestion})`,
          });
        } else {
          errors.push({ ...payload, reason: 'likely typo' });
        }
      }
      continue;
    }

    if (priorTicket) continue;
    const suggestion = likelyTypo(ticketPath, repoFiles);
    errors.push({
      field,
      path: ticketPath,
      suggestion,
      reason: 'missing file',
      message: suggestion
        ? `${field} path not in repo: ${ticketPath} (did you mean ${suggestion}?)`
        : `${field} path not in repo: ${ticketPath}`,
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}
