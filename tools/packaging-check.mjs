// SPDX-License-Identifier: Apache-2.0
// Field lesson #159: a packaging-config change (build sections, package data, published files)
// can pass every test, lint and type check and still produce a package that will not build.
// Only a check that actually builds it (a wheel, a tarball) catches that before CI or vendoring.
import path from 'node:path';

export const PACKAGING_FILES = new Set(['pyproject.toml', 'setup.cfg', 'setup.py', 'MANIFEST.in', 'package.json', 'Cargo.toml']);
const BUILD_ARGV_RE = /(?:^|\s)(?:uv|hatch|poetry|pdm|flit)\s+build\b|\s-m\s+build\b|(?:^|\s)pip3?\s+wheel\b|(?:^|\s)(?:npm|pnpm|yarn)\s+pack\b|(?:^|\s)cargo\s+(?:package|build)\b/;
// argv[0] may be an absolute toolchain path (…/toolchains/bin/uv); only its basename matters.
export const isBuildArgv = argv => Array.isArray(argv) && argv.length > 0 && BUILD_ARGV_RE.test([path.basename(argv[0]), ...argv.slice(1)].join(' '));
export const hasBuildCheck = argvs => argvs.some(isBuildArgv);
export const isPackagingFile = file => PACKAGING_FILES.has(path.basename(file));
const manifestArgvs = manifest => [...(manifest?.checks ?? []).map(check => check.argv), ...(manifest?.preChecks ?? [])];

// validate: nothing has been written yet, so any job that outputs a packaging file needs a build
// check in the manifest (the stricter reading of "touches build/packaging keys").
export function packagingWithoutBuildCheckWarning(manifest, job) {
  const files = job.outputs.filter(isPackagingFile);
  if (!files.length || hasBuildCheck(manifestArgvs(manifest))) return null;
  return { code: 'packaging-change-without-build-check', jobId: job.id, files, message: `Job ${job.id} writes packaging config (${files.join(', ')}) but no manifest check builds the package; add one (uv build --wheel, npm pack --dry-run) so a broken package fails the job` };
}

const TOML_PACKAGING_SECTION = /^(?:build-system|tool\.hatch\.build(?:\..+)?|tool\.hatch\.metadata|tool\.setuptools(?:\..+)?|tool\.poetry\.(?:packages|include|exclude|build)|tool\.flit(?:\..+)?|tool\.pdm\.build|tool\.maturin|project\.scripts|project\.gui-scripts|project\.entry-points(?:\..+)?|lib|bin|package\.metadata(?:\..+)?|options(?:\..+)?)$/;
const TOML_PACKAGING_KEY = /^\s*(?:"|')?(?:packages|package-data|package_data|package-dir|package_dir|py-modules|py_modules|data_files|data-files|include|exclude|force-include|only-include|only-packages|sources|artifacts|build-backend|requires|include-package-data|zip-safe)(?:"|')?\s*=/;
const JSON_PACKAGING_KEYS = ['files', 'main', 'module', 'exports', 'bin', 'types', 'typings', 'browser', 'publishConfig', 'directories'];

function tomlSections(text) {
  let section = '';
  return String(text).split('\n').map(line => {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) section = header[1].replace(/\s+/g, '');
    return { line: line.trimEnd(), section, header: Boolean(header) };
  });
}
function lineDifference(a, b) {
  const counts = new Map();
  for (const item of b) counts.set(item.line, (counts.get(item.line) ?? 0) + 1);
  const only = [];
  for (const item of a) { const count = counts.get(item.line) ?? 0; if (count) counts.set(item.line, count - 1); else only.push(item); }
  return only;
}

// Returns the packaging keys/sections a change touched in one file ([] when none did).
export function packagingKeyChanges(file, beforeText, afterText) {
  const name = path.basename(file);
  if (!PACKAGING_FILES.has(name)) return [];
  const before = beforeText ?? '', after = afterText ?? '';
  if (before === after) return [];
  if (['setup.py', 'MANIFEST.in'].includes(name)) return [name];
  if (name === 'package.json') {
    let a = {}, b = {};
    try { a = before ? JSON.parse(before) : {}; b = after ? JSON.parse(after) : {}; } catch { return ['package.json (unparsable)']; }
    return JSON_PACKAGING_KEYS.filter(key => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]));
  }
  // TOML and setup.cfg (INI): a changed line inside a packaging section, or a packaging key line.
  const beforeLines = tomlSections(before), afterLines = tomlSections(after);
  const changed = [...lineDifference(afterLines, beforeLines), ...lineDifference(beforeLines, afterLines)].filter(item => item.line.trim() && !item.line.trim().startsWith('#'));
  const touched = new Set();
  for (const item of changed) {
    if (TOML_PACKAGING_SECTION.test(item.section)) touched.add(`[${item.section}]`);
    else if (TOML_PACKAGING_KEY.test(item.line)) touched.add(`[${item.section}] ${item.line.trim().split(/\s*=/)[0]}`);
  }
  return [...touched];
}

export function packagingChangeWarnings(changes, argvs) {
  if (hasBuildCheck(argvs)) return [];
  return changes.filter(change => change.keys.length).map(change => `packaging-change-without-build-check: ${change.file}: ${change.keys.join(', ')}`);
}
