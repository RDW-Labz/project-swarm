// SPDX-License-Identifier: Apache-2.0

/** Dependency keys that change what gets installed (engines is intentionally excluded). */
export const DEPENDENCY_FIELD_KEYS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions',
  'bundledDependencies',
]);

/** Install lifecycle scripts that stay security-relevant when added or changed. */
export const INSTALL_LIFECYCLE_SCRIPT_KEYS = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
]);

const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

function parsePkg(text) {
  if (text == null) return { ok: true, value: {} };
  if (typeof text !== 'string') return { ok: false };
  try {
    const value = JSON.parse(text);
    if (!isObj(value)) return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function lifecycleScripts(scripts) {
  if (!isObj(scripts)) return {};
  const out = {};
  for (const k of INSTALL_LIFECYCLE_SCRIPT_KEYS) {
    if (scripts[k] !== undefined) out[k] = scripts[k];
  }
  return out;
}

/** Snapshot of package.json fields that affect dependency install and lifecycle hooks. */
export function dependencyRelevantSnapshot(pkg) {
  if (!isObj(pkg)) return null;
  const snap = {};
  for (const k of DEPENDENCY_FIELD_KEYS) {
    if (pkg[k] !== undefined) snap[k] = pkg[k];
  }
  if (pkg.workspaces !== undefined) snap.workspaces = pkg.workspaces;
  const scripts = lifecycleScripts(pkg.scripts);
  if (Object.keys(scripts).length) snap.scripts = scripts;
  return snap;
}

/**
 * True when before/after differ on dependency fields, workspaces, or install lifecycle scripts.
 * Unparsable before or after is treated as changed (do not skip the gate).
 */
export function dependencyFieldsChanged(beforeText, afterText) {
  const before = parsePkg(beforeText);
  const after = parsePkg(afterText);
  if (!before.ok || !after.ok) return true;
  const b = dependencyRelevantSnapshot(before.value);
  const a = dependencyRelevantSnapshot(after.value);
  return JSON.stringify(b) !== JSON.stringify(a);
}

export function isNpmLockfilePath(file) {
  const base = String(file || '').replace(/^\.\//, '').split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return LOCKFILE_NAMES.has(base);
}

/** True when a changed file should skip dependency audit / plain-integrate dependency refusal. */
export function skipsDependencyAuditForFile(file, beforeText, afterText) {
  const base = String(file || '').replace(/^\.\//, '').split(/[/\\]/).pop()?.toLowerCase() ?? '';
  if (isNpmLockfilePath(file)) return false;
  if (base !== 'package.json') return false;
  return !dependencyFieldsChanged(beforeText, afterText);
}

/** Vulnerabilities present in current but not in baseline (same package name and advisory ids). */
export function filterNewVulnerabilities(current, baseline) {
  const base = new Set((baseline || []).map(vulnKey));
  return (current || []).filter((v) => !base.has(vulnKey(v)));
}

function vulnKey(v) {
  const name = String(v?.name ?? '');
  const ids = Array.isArray(v?.ids) && v.ids.length ? [...v.ids].sort().join('\0') : String(v?.id ?? '');
  return `${name}\0${ids}`;
}
