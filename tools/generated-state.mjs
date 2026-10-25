// SPDX-License-Identifier: Apache-2.0
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

/** Paths the integrate step would write that are locally modified or untracked-and-present. */
export function integrateOutputCollisions(outputPaths, trackedDirty, untrackedDirty) {
  const targets = new Set(
    (Array.isArray(outputPaths) ? outputPaths : [])
      .map(normalizeOutputPath)
      .filter(path => path !== null),
  );
  if (!targets.size) return [];
  const hits = new Set();
  for (const entry of Array.isArray(trackedDirty) ? trackedDirty : []) {
    const normalized = normalizeRelPath(entry?.path);
    if (normalized !== null && targets.has(normalized)) hits.add(normalized);
  }
  for (const entry of Array.isArray(untrackedDirty) ? untrackedDirty : []) {
    const normalized = normalizeRelPath(entry?.path ?? entry);
    if (normalized !== null && targets.has(normalized)) hits.add(normalized);
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

/**
 * Git view for autopilot integrate: tracked dirty (no untracked), untracked on output paths only,
 * merge/rebase markers, and output-path collisions.
 */
export async function integrateCheckoutGitState(root, { exec, runStatus, outputPaths = [] } = {}) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof exec !== 'function' && typeof runStatus !== 'function') return null;
  const mergeInProgress = await gitVerifyRef(root, exec, 'MERGE_HEAD');
  const rebaseInProgress = await gitVerifyRef(root, exec, 'REBASE_HEAD');
  const trackedDirty = await dirtyFiles(root, { exec, runStatus, untracked: false });
  const allWithUntracked = await dirtyFiles(root, { exec, runStatus, untracked: true });
  const untrackedDirty = allWithUntracked.filter(entry => entry.code === '??' || entry.code.startsWith('?'));
  const normalizedOutputs = new Set(
    (Array.isArray(outputPaths) ? outputPaths : [])
      .map(normalizeOutputPath)
      .filter(path => path !== null),
  );
  const presentUntracked = [];
  for (const entry of untrackedDirty) {
    const normalized = normalizeRelPath(entry.path);
    if (normalized === null || !normalizedOutputs.has(normalized)) continue;
    if (await pathExistsInCheckout(root, exec, normalized)) presentUntracked.push({ code: entry.code, path: normalized });
  }
  const integrateCollisions = integrateOutputCollisions(outputPaths, trackedDirty, presentUntracked);
  return {
    mergeInProgress,
    rebaseInProgress,
    integrateTrackedDirty: trackedDirty,
    integrateCollisions,
    dirty: false,
  };
}
