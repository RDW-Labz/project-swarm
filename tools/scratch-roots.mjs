// SPDX-License-Identifier: Apache-2.0
// One definition of test/scratch project roots (board toggle, owner inbox, hand-build auto-deny).
// Also scratch when any real path segment is exactly tmp, temp, test, tests, or __tests__ (case-insensitive),
// except segment names that only appear as part of the install root or user home path prefix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function safeRealpath(input) {
  const raw = String(input ?? '');
  if (!raw) return null;
  try {
    return fs.realpathSync.native(raw);
  } catch {
    try {
      return path.resolve(raw);
    } catch {
      return null;
    }
  }
}

function normalizedPath(input) {
  const raw = String(input ?? '');
  if (!raw) return null;
  try {
    return fs.realpathSync.native(raw);
  } catch {
    const parent = path.dirname(raw);
    if (parent === raw) return path.resolve(raw);
    const base = normalizedPath(parent);
    if (!base) return path.resolve(raw);
    return path.join(base, path.basename(raw));
  }
}

function isUnder(candidate, base) {
  const b = normalizedPath(base);
  const r = normalizedPath(candidate);
  if (!r || !b) return false;
  return r === b || r.startsWith(`${b}${path.sep}`);
}

/** Bases used for prefix comparison (realpath when possible; never throws). */
export function scratchRootList({ env = process.env, home = os.homedir(), tmp } = {}) {
  const scratchBase = env.SWARM_SCRATCH_BASE || path.join(home, '.project-swarm-scratch');
  const bases = [path.join(scratchBase, 'worktrees'), scratchBase];
  const tmpResolved = tmp !== undefined ? (safeRealpath(tmp) ?? path.resolve(tmp)) : null;
  if (env.SWARM_SCRATCH_BASE !== undefined) {
    if (tmpResolved) bases.push(tmpResolved);
  } else {
    const systemTmp = safeRealpath(os.tmpdir()) ?? path.resolve(os.tmpdir());
    bases.push(systemTmp, tmpResolved ?? systemTmp, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders');
  }
  return [...new Set(bases.filter(Boolean))];
}

const SCRATCH_SEGMENTS = new Set(['tmp', 'temp', 'test', 'tests', '__tests__']);

function prefixParts(root) {
  const r = normalizedPath(root);
  return r ? r.split(path.sep).filter(Boolean) : [];
}

function segmentIsScratch(parts, index, { home, installRoot } = {}) {
  const seg = parts[index];
  if (!seg || !SCRATCH_SEGMENTS.has(seg.toLowerCase())) return false;
  const homeParts = prefixParts(home);
  const installParts = installRoot ? prefixParts(installRoot) : [];
  const head = parts.slice(0, index + 1).join(path.sep);
  if (homeParts.length && head === homeParts.slice(0, index + 1).join(path.sep)) return false;
  if (installParts.length && head === installParts.slice(0, index + 1).join(path.sep)) return false;
  return true;
}

function hasScratchPathSegment(parts, options = {}) {
  for (let i = 0; i < parts.length; i += 1) {
    if (segmentIsScratch(parts, i, options)) return true;
  }
  return false;
}

function hasTmpTestSegment(parts) {
  return parts.some(segment => segment.startsWith('.tmp-test'));
}

function pointerMarksScratch(root) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, '.project-swarm.json'), 'utf8'));
    return Boolean(data && typeof data === 'object' && data.scratch === true);
  } catch {
    return false;
  }
}

function hasScratchMarker(root) {
  try {
    fs.accessSync(path.join(root, '.swarm-scratch'));
    return true;
  } catch {
    return false;
  }
}

/** True when the project's real root is a scratch/test tree (comparison never throws). */
export function isScratchRoot(root, { env = process.env, home = os.homedir(), tmp, installRoot } = {}) {
  const raw = String(root ?? '');
  if (!raw) return false;
  let resolved;
  try {
    resolved = normalizedPath(raw);
  } catch {
    return false;
  }
  if (!resolved) return false;
  for (const base of scratchRootList({ env, home, tmp })) {
    if (isUnder(raw, base)) return true;
  }
  const parts = resolved.split(path.sep).filter(Boolean);
  const homeResolved = normalizedPath(home);
  if (homeResolved && resolved === homeResolved) return false;
  if (hasTmpTestSegment(parts)) return true;
  if (hasScratchPathSegment(parts, { home, installRoot })) return true;
  if (pointerMarksScratch(resolved)) return true;
  if (hasScratchMarker(resolved)) return true;
  return false;
}
