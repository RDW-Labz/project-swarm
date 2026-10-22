// SPDX-License-Identifier: Apache-2.0

/** package.json keys that do not affect install, lifecycle, or dependency resolution. */
export const INERT_PACKAGE_JSON_KEYS = Object.freeze([
  'name',
  'version',
  'description',
  'license',
  'keywords',
  'author',
  'homepage',
  'repository',
  'bugs',
  'funding',
  'private',
  'main',
  'module',
  'types',
  'exports',
  'files',
  'sideEffects',
  'engines',
]);

/** Dependency and install keys always included in the material snapshot. */
export const DEPENDENCY_FIELD_KEYS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'peerDependenciesMeta',
  'dependenciesMeta',
  'overrides',
  'resolutions',
  'pnpm',
  'yarn',
  'workspaces',
  'packageManager',
  'config',
  'bin',
  'os',
  'cpu',
]);

/** Install lifecycle scripts (shared with security-gate install-script checks). */
export const INSTALL_LIFECYCLE_SCRIPT_KEYS = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'preprepare',
  'postprepare',
  'prepublish',
  'prepublishOnly',
  'preuninstall',
  'postuninstall',
]);

const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

const inertKeySet = new Set(INERT_PACKAGE_JSON_KEYS);

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

export function packageHasInstallLifecycleScripts(scripts) {
  if (!isObj(scripts)) return false;
  return INSTALL_LIFECYCLE_SCRIPT_KEYS.some((k) => scripts[k] != null);
}

/** Whole scripts object when any lifecycle hook exists; otherwise scripts are inert. */
export function scriptsMaterialSnapshot(scripts) {
  if (!isObj(scripts)) return undefined;
  if (!packageHasInstallLifecycleScripts(scripts)) return undefined;
  return scripts;
}

/** Snapshot of package.json fields that affect dependency install and lifecycle hooks. */
export function dependencyRelevantSnapshot(pkg) {
  if (!isObj(pkg)) return null;
  const snap = {};
  for (const k of DEPENDENCY_FIELD_KEYS) {
    if (pkg[k] !== undefined) snap[k] = pkg[k];
  }
  for (const k of Object.keys(pkg)) {
    if (inertKeySet.has(k) || k === 'scripts' || DEPENDENCY_FIELD_KEYS.includes(k)) continue;
    snap[k] = pkg[k];
  }
  const scripts = scriptsMaterialSnapshot(pkg.scripts);
  if (scripts !== undefined) snap.scripts = scripts;
  return snap;
}

/**
 * True when before/after differ on dependency fields, workspaces, or install lifecycle scripts.
 * Unparsable before or after is treated as changed (do not skip the gate).
 */
export function dependencyFieldsChanged(beforeText, afterText) {
  if (beforeText == null || beforeText === '') return true;
  if (afterText == null || afterText === '') return true;
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
