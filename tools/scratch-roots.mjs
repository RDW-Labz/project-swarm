// SPDX-License-Identifier: Apache-2.0
// Scratch vs test-temp project roots (two classifiers — use the right one):
//   isScratchRoot (STRICT): owner inbox, phone, swarm-inbox, handbuild auto-deny, swarm forget --scratch.
//     ~/.project-swarm-scratch and worktrees, OS temp dirs, .tmp-test* segment names, .project-swarm.json scratch:true, .swarm-scratch marker.
//   isTestTempRoot (BROAD): default board project listing only (hide from the board list, never for inbox or auto-deny).
//     STRICT rules OR a path segment exactly tmp, temp, test, tests, or __tests__ (case-insensitive), except under home or installRoot prefix.
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

function isAncestorOf(ancestor, candidate) {
  const a = normalizedPath(ancestor);
  const c = normalizedPath(candidate);
  if (!a || !c) return false;
  return a !== c && c.startsWith(`${a}${path.sep}`);
}

const scratchBaseWarned = new Set();
function warnScratchBase(warn, msg) {
  if (scratchBaseWarned.has(msg)) return;
  scratchBaseWarned.add(msg);
  warn(msg);
}

function registeredProjectGitRoot(root) {
  try {
    const git = path.join(root, '.git');
    const st = fs.lstatSync(git);
    return st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

function scratchBaseNameOk(resolved) {
  const base = path.basename(resolved).toLowerCase();
  return base.includes('scratch');
}

/** Validate SWARM_SCRATCH_BASE; returns the base path to use (default when invalid). */
export function resolveScratchBase({ env = process.env, home = os.homedir(), registeredRoots = [], warn = msg => console.warn(msg) } = {}) {
  const raw = env.SWARM_SCRATCH_BASE;
  const defaultBase = path.join(home, '.project-swarm-scratch');
  if (raw === undefined) return defaultBase;
  if (raw === '') return defaultBase;
  const candidate = String(raw);
  if (!path.isAbsolute(candidate)) {
    warnScratchBase(warn, `SWARM_SCRATCH_BASE ignored (not an absolute path): ${candidate}`);
    return defaultBase;
  }
  const resolved = safeRealpath(candidate) ?? path.resolve(candidate);
  const homeR = normalizedPath(home);
  const rootR = path.parse(resolved).root;
  if (resolved === rootR || resolved === homeR || (homeR && isAncestorOf(resolved, homeR))) {
    warnScratchBase(warn, 'SWARM_SCRATCH_BASE ignored (root, home, or ancestor of home)');
    return defaultBase;
  }
  for (const reg of registeredRoots) {
    const rr = normalizedPath(reg);
    if (!rr || !registeredProjectGitRoot(rr)) continue;
    if (resolved === rr || isUnder(resolved, rr) || isUnder(rr, resolved)) {
      warnScratchBase(warn, 'SWARM_SCRATCH_BASE ignored (contains or sits inside a registered project with its own .git)');
      return defaultBase;
    }
  }
  if (!scratchBaseNameOk(resolved)) {
    warnScratchBase(warn, 'SWARM_SCRATCH_BASE ignored (must be named like scratch or sit under the OS temp dir when it holds real projects)');
    return defaultBase;
  }
  return resolved;
}

/** Bases used for STRICT prefix comparison (realpath when possible; never throws). */
export function scratchRootList({ env = process.env, home = os.homedir(), tmp, registeredRoots } = {}) {
  const scratchBase = resolveScratchBase({ env, home, registeredRoots });
  const bases = [path.join(scratchBase, 'worktrees'), scratchBase];
  const tmpResolved = tmp !== undefined ? (safeRealpath(tmp) ?? path.resolve(tmp)) : null;
  const custom = env.SWARM_SCRATCH_BASE !== undefined && env.SWARM_SCRATCH_BASE !== '';
  if (custom) {
    if (tmpResolved) bases.push(tmpResolved);
  } else if (!(env.SWARM_TEST_TMP ?? process.env.SWARM_TEST_TMP)) {
    const systemTmp = safeRealpath(os.tmpdir()) ?? path.resolve(os.tmpdir());
    bases.push(systemTmp, tmpResolved ?? systemTmp, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders');
  } else if (tmpResolved) {
    bases.push(tmpResolved);
  }
  return [...new Set(bases.filter(Boolean))];
}

const BROAD_SEGMENTS = new Set(['tmp', 'temp', 'test', 'tests', '__tests__']);

function prefixParts(root) {
  const r = normalizedPath(root);
  return r ? r.split(path.sep).filter(Boolean) : [];
}

function segmentIsBroadTest(resolved, segs, index, { home, installRoot } = {}) {
  const seg = segs[index];
  if (!seg || !BROAD_SEGMENTS.has(seg.toLowerCase())) return false;
  const homeParts = prefixParts(home);
  const head = segs.slice(0, index + 1).join(path.sep);
  if (homeParts.length && head === homeParts.slice(0, index + 1).join(path.sep)) return false;
  const installR = installRoot ? normalizedPath(installRoot) : null;
  const prefix = `${path.sep}${segs.slice(0, index + 1).join(path.sep)}`;
  if (installR && (prefix === installR || prefix.startsWith(`${installR}${path.sep}`))) return false;
  return true;
}

function hasBroadTestSegment(resolved, options = {}) {
  const segs = resolved.split(path.sep).filter(Boolean);
  for (let i = 0; i < segs.length; i += 1) {
    if (segmentIsBroadTest(resolved, segs, i, options)) return true;
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

function strictScratchCore(root, options = {}) {
  const raw = String(root ?? '');
  if (!raw) return false;
  let resolved;
  try {
    resolved = normalizedPath(raw);
  } catch {
    return false;
  }
  if (!resolved) return false;
  for (const base of scratchRootList(options)) {
    if (isUnder(raw, base)) return true;
  }
  const parts = resolved.split(path.sep).filter(Boolean);
  const homeResolved = normalizedPath(options.home ?? options.env?.HOME ?? os.homedir());
  if (homeResolved && resolved === homeResolved) return false;
  const testTmp = options.env?.SWARM_TEST_TMP ?? process.env.SWARM_TEST_TMP;
  if (testTmp) {
    const tt = normalizedPath(testTmp);
    if (tt && isUnder(resolved, tt) && !(homeResolved && isUnder(resolved, homeResolved)) && hasBroadTestSegment(resolved, options)) {
      return true;
    }
  }
  if (hasTmpTestSegment(parts)) return true;
  if (pointerMarksScratch(resolved)) return true;
  if (hasScratchMarker(resolved)) return true;
  return false;
}

/** STRICT when options.strict is true; default (legacy callers) matches isTestTempRoot. */
export function isScratchRoot(root, options = {}) {
  if (options.strict) return strictScratchCore(root, options);
  return isTestTempRoot(root, options);
}

/** BROAD test/temp tree (board listing hide only). */
export function isTestTempRoot(root, options = {}) {
  if (strictScratchCore(root, options)) return true;
  const raw = String(root ?? '');
  if (!raw) return false;
  const resolved = normalizedPath(raw);
  if (!resolved) return false;
  return hasBroadTestSegment(resolved, options);
}

export { isTestTempRoot as isScratchRootBroad };
