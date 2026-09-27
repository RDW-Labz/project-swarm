// SPDX-License-Identifier: Apache-2.0
// Catches a class of bug where a worker changes an output's behavior but never sees the
// test that asserts it, because the job's context/outputs never named that test. This is
// advisory static text matching, not a dependency graph: it can miss indirect references
// and, rarely, flag a coincidental one; job authors resolve findings via context or
// ignoreTests, not by trusting this module to be exhaustive.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CONTEXT_CHECK_LIMITS = Object.freeze({ maxFiles: 20_000, maxTestBytes: 1024 * 1024 });

const SKIP_DIRS = new Set(['.git', '.swarm', 'node_modules', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__']);
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec)\//;
const JS_TEST_FILE_RE = /\.(test|spec)\.(js|ts|mjs|cjs|jsx|tsx)$/;
const PY_TEST_FILE_RE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/;
const GO_TEST_FILE_RE = /(^|\/)[^/]+_test\.go$/;
const GENERIC_STEMS = new Set(['index', 'mod', 'main', 'lib', '__init__', 'init', 'utils', 'types', 'config']);
const MANIFEST_OR_VERSION_FILES = new Set(['package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', 'Cargo.toml', 'Cargo.lock']);

export function isTestFile(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  return TEST_DIR_RE.test(p) || JS_TEST_FILE_RE.test(p) || PY_TEST_FILE_RE.test(p) || GO_TEST_FILE_RE.test(p);
}

function isManifestOrVersionFile(relPath) {
  const p = String(relPath).replace(/\\/g, '/');
  if (MANIFEST_OR_VERSION_FILES.has(p)) return true;
  return p.endsWith('__init__.py');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Field lesson 140: a whole-file or glob-based guard test discovers files in its directory
// dynamically and never names them, so referencePatterns' literal text match cannot see it. A
// test that walks a directory or an extension glob counts as covering a new same-kind file
// placed there, exactly as if it had named the file directly.
const QUOTED_STRING_RE = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
const GLOB_DIR_EXT_RE = /^(.+?)\/(\*\*\/)?\*(\.[A-Za-z0-9]+)$/;
const READDIR_CALL_RE = /\b(?:readdirSync|readdir|globSync|glob\.sync|fg\.sync)\s*\(/;
const ENDSWITH_EXT_RE = /\.endsWith\(\s*(['"`])(\.[A-Za-z0-9]+)\1\s*\)/g;
const EXT_REGEX_LITERAL_RE = /\/\\\.([A-Za-z0-9]+)\$\//g;

export function directoryGuardCoverage(text) {
  const covered = [];
  for (const match of text.matchAll(QUOTED_STRING_RE)) {
    const globMatch = GLOB_DIR_EXT_RE.exec(match[2]);
    if (globMatch) covered.push({ dir: globMatch[1], ext: globMatch[3], recursive: Boolean(globMatch[2]) });
  }
  if (READDIR_CALL_RE.test(text)) {
    const dirs = [];
    for (const match of text.matchAll(QUOTED_STRING_RE)) {
      const inner = match[2];
      if (inner && !inner.includes('*') && /^[\w][\w./-]*$/.test(inner)) dirs.push(inner);
    }
    const exts = new Set();
    for (const match of text.matchAll(ENDSWITH_EXT_RE)) exts.add(match[2]);
    for (const match of text.matchAll(EXT_REGEX_LITERAL_RE)) exts.add(`.${match[1]}`);
    for (const dir of dirs) for (const ext of exts) covered.push({ dir, ext, recursive: false });
  }
  return covered;
}

function matchesDirectoryGuard(coverage, outDir, outExt) {
  return coverage.some(entry => entry.ext === outExt && (entry.recursive
    ? (outDir === entry.dir || outDir.startsWith(`${entry.dir}/`))
    : outDir === entry.dir));
}

export function referencePatterns(outputPath) {
  const norm = String(outputPath).replace(/\\/g, '/');
  const ext = path.extname(norm);
  let stem = path.basename(norm, ext);
  if (GENERIC_STEMS.has(stem)) stem = path.basename(path.dirname(norm));
  if (stem.length < 3) return [];
  const esc = escapeRegExp(stem);
  const boundaryStart = "(?:^|[/'\"`\\s])";
  const boundaryEnd = "(?=['\"`])";
  // A bare quoted stem (no leading '/' and no extension) is too common in non-path text
  // (e.g. getByText('Chat')) to count as a reference, so the two cases are split: a '/'
  // right before the stem is enough on its own, otherwise an extension is required.
  const patterns = [
    new RegExp(`${boundaryStart}${esc}\\.[A-Za-z0-9]+${boundaryEnd}`),
    new RegExp(`/${esc}${boundaryEnd}`),
  ];
  if (ext === '.py') {
    patterns.push(new RegExp(`\\bfrom\\s+[\\w.]+\\.${esc}\\s+import\\b`));
    patterns.push(new RegExp(`\\bimport\\s+(?:[\\w]+\\.)*${esc}\\b`));
    patterns.push(new RegExp(`\\bfrom\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${esc}\\b`));
  }
  if (ext === '.rs') {
    patterns.push(new RegExp(`\\bmod\\s+${esc}\\s*;`));
    patterns.push(new RegExp(`\\bcrate::${esc}\\b`));
    patterns.push(new RegExp(`\\bsuper::${esc}\\b`));
  }
  return patterns;
}

// Outside a git repo this fails and falls back to a walk; git's own "fatal: not a git repository"
// must not leak onto the coordinator's stderr (lesson #57).
function tryGitLsFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\0').filter(Boolean);
    // A newly linked project may have no index yet, or live in an ignored
    // directory of a parent checkout. An empty index is not an empty project.
    return files.length ? files : null;
  } catch {
    return null;
  }
}

function walk(root, dir, out) {
  if (out.length >= CONTEXT_CHECK_LIMITS.maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= CONTEXT_CHECK_LIMITS.maxFiles) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
}

export function listProjectFiles(root) {
  const gitFiles = tryGitLsFiles(root);
  if (gitFiles) return gitFiles.slice(0, CONTEXT_CHECK_LIMITS.maxFiles);
  const files = [];
  walk(root, root, files);
  return files.slice(0, CONTEXT_CHECK_LIMITS.maxFiles);
}

export function findUncoveredTests(root, job, files = listProjectFiles(root)) {
  const covered = new Set([...(job.context ?? []), ...(job.outputs ?? []), ...(job.ignoreTests ?? [])]);
  const candidates = [];
  for (const file of files) {
    if (!isTestFile(file) || covered.has(file)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(root, file));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > CONTEXT_CHECK_LIMITS.maxTestBytes) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    candidates.push({ file, text, guardCoverage: directoryGuardCoverage(text) });
  }
  const pairs = [];
  for (const output of job.outputs ?? []) {
    if (isTestFile(output) || isManifestOrVersionFile(output)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(root, output));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const patterns = referencePatterns(output);
    const outNorm = String(output).replace(/\\/g, '/');
    const outDir = path.dirname(outNorm);
    const outExt = path.extname(outNorm);
    for (const { file, text, guardCoverage } of candidates) {
      const matched = patterns.some(re => re.test(text)) || matchesDirectoryGuard(guardCoverage, outDir, outExt);
      if (matched) pairs.push({ output, test: file });
    }
  }
  return pairs.sort((a, b) => (a.test !== b.test ? (a.test < b.test ? -1 : 1) : a.output < b.output ? -1 : a.output > b.output ? 1 : 0));
}

// Catches a class of bug where a review round's context is copied from an earlier round and
// silently omits files added to the same directory since (e.g. new screenshot captures), so a
// reviewer reports already-fixed items as still missing. Advisory only: a job may legitimately
// need only some files of a directory, so this warns rather than refuses.
//
// Field lesson 39: a plain, unnumbered same-extension reference (no contextGlob, no numbering)
// only warns once at least 3 files are listed, to avoid noise on ordinary source directories. But
// a declared contextGlob prefix, or even a single context file that is plainly one of a numbered
// series (e.g. "activity-3.png"), is already strong evidence a series exists — the root cause of
// one missed warning was requiring that same 3+ floor even when a numbered-series file made the
// gap obvious with only one or two files actually listed. Both kinds of evidence (declared or
// inferred prefix) share this one code path and warning code (previously two: this function's own
// `context-directory-drift`, and a separate `context-glob-partial-dir` duplicating it in swarm.mjs).
const CONTEXT_GLOB_DIR_RE = /^([^*]+)\/([^*/]*)\*(\.[A-Za-z0-9]+)$/;
const NUMBERED_STEM_RE = /^(.*?)[0-9]+$/;

export function contextDirectoryWarnings(root, job) {
  const declaredByDirExt = new Map();
  for (const pattern of job.contextGlob ?? []) {
    const match = CONTEXT_GLOB_DIR_RE.exec(String(pattern));
    if (!match) continue;
    const key = `${match[1]}\u0000${match[3]}`;
    if (!declaredByDirExt.has(key)) declaredByDirExt.set(key, new Set());
    declaredByDirExt.get(key).add(match[2]);
  }
  const groups = new Map();
  for (const file of job.context ?? []) {
    const norm = String(file).replace(/\\/g, '/');
    const ext = path.extname(norm);
    if (!ext) continue;
    const dir = path.dirname(norm);
    if (dir.split('/').some(segment => SKIP_DIRS.has(segment))) continue;
    const key = `${dir}\u0000${ext}`;
    if (!groups.has(key)) groups.set(key, { dir, ext, files: new Set(), inferred: new Set() });
    const group = groups.get(key);
    group.files.add(norm);
    const numbered = NUMBERED_STEM_RE.exec(path.basename(norm, ext));
    if (numbered && numbered[1]) group.inferred.add(numbered[1]);
  }
  const warnings = [];
  for (const [key, { dir, ext, files, inferred }] of groups) {
    const prefixes = new Set([...(declaredByDirExt.get(key) ?? []), ...inferred]);
    if (!prefixes.size && files.size < 3) continue;
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries.filter(entry => entry.isFile() && entry.name.endsWith(ext)).map(entry => entry.name);
    const missing = names.filter(name => !files.has(`${dir}/${name}`)).map(name => `${dir}/${name}`).sort();
    if (!missing.length) continue;
    const shown = missing.slice(0, 5);
    const more = missing.length - shown.length;
    const sortedPrefixes = prefixes.size ? [...prefixes].sort() : undefined;
    warnings.push({
      code: 'context-directory-drift',
      jobId: job.id,
      dir,
      extension: ext,
      ...(sortedPrefixes ? { prefixes: sortedPrefixes } : {}),
      present: files.size,
      total: names.length,
      missing: shown,
      message: sortedPrefixes
        ? `context for ${dir} covers ${JSON.stringify(sortedPrefixes)}; missing e.g. ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
        : `context lists ${files.size} of ${names.length} ${ext} in ${dir}; missing e.g. ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`,
    });
  }
  return warnings;
}

// Field lesson 155: a job that adds an entry to a registry (catalog dir, allowlist, pinned
// scopes) also owns the test that pins that registry's membership, or the new file breaks a
// hard-coded set the job's own context/outputs never named. "Near" is a same-text proximity
// window, not a parser: this is advisory, exactly like findUncoveredTests above.
// NOTE: not yet wired into validateProject (tools/swarm.mjs) — see job notes for the one-line
// hook needed, since the existing contextDirectoryWarnings/findUncoveredTests call sites there
// do not carry both a job's outputs and the warnings (vs. refusal) list at once.
const REGISTRY_KEYWORD_SRC = '(?:load_\\w*|glob\\w*|listdir|readdir)';
const NEAR_WINDOW = 80;

export function registryPinningWarnings(root, job, files = listProjectFiles(root)) {
  const covered = new Set([...(job.context ?? []), ...(job.outputs ?? []), ...(job.ignoreTests ?? [])]);
  const newDirs = new Set();
  for (const output of job.outputs ?? []) {
    if (isTestFile(output) || isManifestOrVersionFile(output)) continue;
    try {
      fs.statSync(path.join(root, output));
      continue; // already exists: not a new file
    } catch { /* does not exist yet */ }
    let dir = path.dirname(String(output).replace(/\\/g, '/'));
    while (dir && dir !== '.') {
      newDirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (!newDirs.size) return [];
  const matches = new Map();
  for (const file of files) {
    if (!isTestFile(file) || covered.has(file)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(root, file));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > CONTEXT_CHECK_LIMITS.maxTestBytes) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const dir of newDirs) {
      const name = dir.split('/').pop();
      if (!name || name.length < 2) continue;
      const esc = escapeRegExp(name);
      const near = new RegExp(`${esc}[\\s\\S]{0,${NEAR_WINDOW}}?${REGISTRY_KEYWORD_SRC}|${REGISTRY_KEYWORD_SRC}[\\s\\S]{0,${NEAR_WINDOW}}?${esc}`, 'i');
      if (near.test(text)) {
        if (!matches.has(dir)) matches.set(dir, new Set());
        matches.get(dir).add(file);
      }
    }
  }
  const warnings = [];
  for (const [dir, testSet] of matches) {
    const tests = [...testSet].sort();
    warnings.push({
      code: 'registry-pinning-tests',
      jobId: job.id,
      dir,
      tests,
      message: `job ${job.id} adds a new file under ${dir}; ${tests.join(', ')} enumerates that directory and is not in this job's context, outputs, or ignoreTests`,
    });
  }
  return warnings.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

export function suggestIgnoreTests(uncovered) {
  const grouped = {};
  for (const item of uncovered) {
    if (!grouped[item.job]) grouped[item.job] = new Set();
    grouped[item.job].add(item.test);
  }
  const result = {};
  for (const [jobId, tests] of Object.entries(grouped)) {
    result[jobId] = Array.from(tests).sort();
  }
  return result;
}
