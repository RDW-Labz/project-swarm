// SPDX-License-Identifier: Apache-2.0
import { realpath } from 'node:fs/promises';
import path from 'node:path';
// Repo-relative paths and prefixes that swarm regenerates; they never count as operator edits.

export const GENERATED_STATE = Object.freeze([
  'coordination/HANDOFF.md',
  'coordination/HANDOFF.previous.md',
  'coordination/HANDOFF.previous-2.md',
  'coordination/TASK.md',
  'docs/scope/build-plan.md',
  'docs/scope/context/',
  'docs/scope/waves/',
  'docs/state/usage-ledger.md',
  '.swarm/',
]);

const EXACT = new Set(GENERATED_STATE.filter(entry => !entry.endsWith('/')));

function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (pathIsUnsafe(relPath)) return null;
  let normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  while (normalized.startsWith('/')) normalized = normalized.slice(1);
  return normalized;
}

function pathIsUnsafe(relPath) {
  if (relPath.includes('\\')) {
    const asPosix = relPath.replace(/\\/g, '/');
    if (asPosix.startsWith('/') || /^[A-Za-z]:\//.test(asPosix)) return true;
  }
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) return true;
  return relPath.split(/[\\/]/).includes('..');
}

export function isGeneratedStateFile(relPath) {
  const normalized = normalizeRelPath(relPath);
  if (normalized === null) return false;
  if (EXACT.has(normalized)) return true;
  for (const entry of GENERATED_STATE) {
    if (!entry.endsWith('/')) continue;
    if (normalized === entry.slice(0, -1) || normalized.startsWith(entry)) return true;
  }
  return false;
}

function stripQuotes(raw) {
  const text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

function pathsFromPorcelainLine(line) {
  if (!line || line.length < 4 || line[2] !== ' ') return [];
  const raw = line.slice(3).trim();
  if (!raw) return [];
  const arrow = raw.indexOf(' -> ');
  if (arrow !== -1) {
    const left = stripQuotes(raw.slice(0, arrow).trim());
    const right = stripQuotes(raw.slice(arrow + 4).trim());
    return [left, right].filter(Boolean);
  }
  return [stripQuotes(raw)].filter(Boolean);
}

export function filterGeneratedStatus(lines) {
  const kept = [];
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  for (const line of list) {
    if (!line?.trim()) continue;
    const paths = pathsFromPorcelainLine(line);
    if (!paths.length) {
      kept.push(line);
      continue;
    }
    if (paths.every(path => isGeneratedStateFile(path))) continue;
    kept.push(line);
  }
  return kept;
}

function parsePorcelainZ(stdout) {
  const records = String(stdout ?? '').split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('invalid git status');
    const code = record.slice(0, 2);
    const file = record.slice(3);
    entries.push({ code, path: file });
    if (/[RC]/.test(code)) {
      const from = records[++index];
      if (!from) throw new Error('invalid git rename status');
      entries.push({ code, path: from, renameOf: file });
    }
  }
  return entries;
}

function parsePorcelainNewline(stdout) {
  const entries = [];
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line?.trim()) continue;
    if (line.length >= 4 && line[2] === ' ') {
      const code = line.slice(0, 2);
      const paths = pathsFromPorcelainLine(line);
      for (const file of paths) entries.push({ code, path: file });
      continue;
    }
    const loose = /^(.{1,2})\s+(.+)$/.exec(line);
    if (loose) entries.push({ code: loose[1].padEnd(2, ' '), path: stripQuotes(loose[2].trim()) });
  }
  return entries;
}

function parseStatusStdout(stdout) {
  const text = String(stdout ?? '');
  if (text.includes('\0')) return parsePorcelainZ(text);
  return parsePorcelainNewline(text);
}

export async function dirtyFiles(root, { exec, runStatus, untracked = true } = {}) {
  if (typeof root !== 'string' || !root) return [];
  let stdout;
  try {
    if (typeof runStatus === 'function') {
      stdout = await runStatus({ root, untracked });
    } else if (typeof exec === 'function') {
      const args = ['-C', root, 'status', '--porcelain=v1', '-z', untracked ? '--untracked-files=all' : '--untracked-files=no'];
      const result = await exec('git', args, { encoding: 'utf8' });
      stdout = result?.stdout ?? result ?? '';
    } else {
      return [];
    }
  } catch {
    throw new Error('git status failed');
  }
  let entries;
  try {
    entries = parseStatusStdout(stdout);
  } catch {
    throw new Error('invalid git status');
  }
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const normalized = normalizeRelPath(entry.path);
    if (normalized === null || isGeneratedStateFile(normalized)) continue;
    const key = `${entry.code}\0${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: entry.code, path: normalized });
  }
  out.sort((a, b) => (a.path === b.path ? a.code.localeCompare(b.code) : a.path.localeCompare(b.path)));
  return out;
}

export function formatDirtyListing(paths, max = 5) {
  const list = [...new Set((paths ?? []).map(p => (typeof p === 'string' ? p : p?.path)).filter(Boolean))].sort();
  if (!list.length) return '';
  const shown = list.slice(0, max);
  const more = list.length > max ? ` (+${list.length - max} more)` : '';
  return `: ${shown.join(', ')}${more}`;
}

function normalizeOutputPath(relPath) {
  return normalizeRelPath(relPath);
}

function comparePath(p, { ignoreCase = false } = {}) {
  const normalized = normalizeRelPath(p);
  if (normalized === null) return null;
  return ignoreCase ? normalized.toLowerCase() : normalized;
}

function pathSegments(relPath) {
  const compared = comparePath(relPath);
  if (compared === null) return [];
  return compared.split('/').filter(Boolean);
}

/** True when two repo-relative paths are equal or one is a strict prefix of the other on path segments. */
export function integratePathsCollide(outputPath, dirtyPath, { ignoreCase = false } = {}) {
  const a = pathSegments(outputPath);
  const b = pathSegments(dirtyPath);
  if (!a.length || !b.length) return false;
  const eq = (x, y) => (ignoreCase ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (a.length === b.length) return a.every((seg, i) => eq(seg, b[i]));
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  return shorter.every((seg, i) => eq(seg, longer[i]));
}

function pathsCollide(outputPath, dirtyPath, { ignoreCase = false, realpathOf = null } = {}) {
  const keyOf = typeof realpathOf === 'function' ? realpathOf : p => comparePath(p, { ignoreCase });
  const outKey = keyOf(outputPath);
  const dirtyKey = keyOf(dirtyPath);
  if (outKey && dirtyKey && outKey === dirtyKey) return true;
  return integratePathsCollide(outputPath, dirtyPath, { ignoreCase });
}

/** Paths the integrate step would write that are locally modified or untracked-and-present. */
export function integrateOutputCollisions(outputPaths, trackedDirty, untrackedDirty, {
  ignoreCase = false,
  realpathOf = null,
} = {}) {
  const targets = (Array.isArray(outputPaths) ? outputPaths : [])
    .map(normalizeOutputPath)
    .filter(p => p !== null);
  if (!targets.length) return [];
  const hits = new Set();
  const dirtyEntries = [
    ...(Array.isArray(trackedDirty) ? trackedDirty : []),
    ...(Array.isArray(untrackedDirty) ? untrackedDirty : []),
  ];
  for (const entry of dirtyEntries) {
    const normalized = normalizeRelPath(entry?.path ?? entry);
    if (normalized === null) continue;
    for (const target of targets) {
      if (pathsCollide(target, normalized, { ignoreCase, realpathOf })) {
        hits.add(normalized);
        break;
      }
    }
  }
  return [...hits].sort();
}

async function pathExistsInCheckout(root, exec, relPath) {
  if (typeof root !== 'string' || !root || typeof relPath !== 'string' || !relPath) return false;
  if (typeof exec === 'function') {
    try {
      await exec('git', ['-C', root, 'rev-parse', '--verify', `HEAD:${relPath}`], { encoding: 'utf8' });
      return true;
    } catch { /* not in HEAD */ }
  }
  try {
    const { access } = await import('node:fs/promises');
    const { default: path } = await import('node:path');
    await access(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

async function gitVerifyRef(root, exec, ref) {
  if (typeof exec !== 'function') return false;
  try {
    await exec('git', ['-C', root, 'rev-parse', '-q', '--verify', ref], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

async function gitPathExists(root, exec, gitPathName) {
  if (typeof exec !== 'function') return false;
  try {
    const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--git-path', gitPathName], { encoding: 'utf8' });
    const rel = String(stdout ?? '').trim();
    if (!rel) return false;
    const { access } = await import('node:fs/promises');
    const candidates = path.isAbsolute(rel) ? [rel] : [path.join(root, rel), path.join(root, '.git', rel)];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return true;
      } catch { /* try next */ }
    }
  } catch { /* not in progress */ }
  return false;
}

async function gitIgnoreCase(root, exec) {
  if (typeof exec !== 'function') return false;
  try {
    const { stdout } = await exec('git', ['-C', root, 'config', '--get', 'core.ignorecase'], { encoding: 'utf8' });
    return String(stdout ?? '').trim() === 'true';
  } catch {
    return false;
  }
}

async function buildRealpathKey(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (normalized === null) return null;
  try {
    return await realpath(path.join(root, normalized));
  } catch {
    try {
      return await realpath(path.resolve(root, normalized));
    } catch {
      return path.resolve(root, normalized);
    }
  }
}

/**
 * Git view for autopilot integrate: tracked dirty (no untracked), untracked on output paths only,
 * merge/rebase markers, and output-path collisions.
 */
export async function integrateCheckoutGitState(root, { exec, runStatus, outputPaths = [] } = {}) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof exec !== 'function' && typeof runStatus !== 'function') return null;
  const mergeInProgress = await gitVerifyRef(root, exec, 'MERGE_HEAD');
  const cherryPickInProgress = await gitVerifyRef(root, exec, 'CHERRY_PICK_HEAD');
  const revertInProgress = await gitVerifyRef(root, exec, 'REVERT_HEAD');
  const rebaseInProgress = (await gitPathExists(root, exec, 'rebase-merge'))
    || (await gitPathExists(root, exec, 'rebase-apply'));
  const ignoreCase = await gitIgnoreCase(root, exec);
  const trackedDirty = await dirtyFiles(root, { exec, runStatus, untracked: false });
  const unmergedPaths = trackedDirty.filter(entry => entry.code.includes('U')).map(entry => entry.path);
  const allWithUntracked = await dirtyFiles(root, { exec, runStatus, untracked: true });
  const untrackedDirty = allWithUntracked.filter(entry => entry.code === '??' || entry.code.startsWith('?'));
  const normalizedOutputs = new Set(
    (Array.isArray(outputPaths) ? outputPaths : [])
      .map(normalizeOutputPath)
      .filter(p => p !== null),
  );
  const presentUntracked = [];
  for (const entry of untrackedDirty) {
    const normalized = normalizeRelPath(entry.path);
    if (normalized === null) continue;
    let onOutput = normalizedOutputs.has(normalized);
    if (!onOutput) {
      for (const out of normalizedOutputs) {
        if (integratePathsCollide(out, normalized, { ignoreCase })) { onOutput = true; break; }
      }
    }
    if (!onOutput) continue;
    if (await pathExistsInCheckout(root, exec, normalized)) presentUntracked.push({ code: entry.code, path: normalized });
  }
  const realpathCache = new Map();
  const allPaths = new Set([
    ...normalizedOutputs,
    ...trackedDirty.map(e => e.path),
    ...presentUntracked.map(e => e.path),
  ]);
  await Promise.all([...allPaths].map(async p => {
    const key = await buildRealpathKey(root, p);
    if (key) realpathCache.set(p, key);
  }));
  const realpathKeyFn = rel => {
    const normalized = normalizeRelPath(rel);
    if (normalized === null) return null;
    const resolved = realpathCache.get(normalized);
    if (resolved) return ignoreCase ? resolved.toLowerCase() : resolved;
    return comparePath(normalized, { ignoreCase });
  };
  const integrateCollisions = integrateOutputCollisions(outputPaths, trackedDirty, presentUntracked, {
    ignoreCase,
    realpathOf: realpathKeyFn,
  });
  return {
    mergeInProgress,
    cherryPickInProgress,
    revertInProgress,
    rebaseInProgress,
    unmergedPaths,
    integrateTrackedDirty: trackedDirty,
    integrateCollisions,
    dirty: false,
  };
}
