// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeWritableDir, assertRegularOrMissing } from './journal.mjs';

export const MAP_VERSION = 1;
const MAX_FILES = 20000;
const MAX_BYTES = 1024 * 1024;
const MAX_LINKS = 5;
const MAX_IMPORTERS = 200;
const MAX_EXPORTS = 200;
const MAP_LIMIT = 20 * 1024 * 1024;
const LANGS = new Map([['js', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['jsx', 'js'], ['ts', 'js'], ['tsx', 'js'], ['mts', 'js'], ['cts', 'js'], ['py', 'python'], ['go', 'go'], ['rs', 'rust']]);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec']);
const TEST_NAME = /\.test\.|\.spec\.|_test\.|^test_.*\.py$/;
const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];
const IDENT = /^[A-Za-z_$][\w$]*$/;
const JS_SPEC_RES = [
  /\bimport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniq = list => [...new Set(list)].sort(byPath);

function safeRel(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0') && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..');
}

function langOf(rel) {
  return LANGS.get(path.posix.extname(rel).slice(1).toLowerCase()) ?? null;
}

function isTestPath(rel) {
  const parts = rel.split('/');
  return parts.slice(0, -1).some(part => TEST_DIRS.has(part)) || TEST_NAME.test(parts.at(-1));
}

function fileStem(p) {
  return path.posix.basename(p).replace(/\.[^.]+$/, '');
}

function testStem(p) {
  return fileStem(p).replace(/(\.test|\.spec|_test)$/, '').replace(/^test_/, '');
}

function namesFrom(body, mode) {
  return body.split(',').map(part => part.trim()).filter(Boolean)
    .map(part => (mode === 'as' ? part.split(/\s+as\s+/).pop() : part.split(':')[0]).trim())
    .filter(name => IDENT.test(name));
}

function jsExports(text) {
  const out = [...text.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  if (/export\s+default\b/.test(text)) out.push('default');
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) out.push(...namesFrom(m[1], 'as'));
  for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) out.push(...namesFrom(m[1], 'colon'));
  for (const m of text.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) out.push(m[1]);
  return out;
}

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function jsItem(spec, rel, known) {
  if (!spec.startsWith('.')) return { external: packageName(spec) };
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
  const candidates = [base, ...JS_EXTS.map(ext => base + ext), base + '/index.js', base + '/index.ts'];
  return { file: candidates.find(c => known.has(c)) };
}

function withItems(exports, items, known) {
  const imports = new Set();
  const external = new Set();
  for (const item of items) {
    if (item?.file && known.has(item.file)) imports.add(item.file);
    if (item?.external) external.add(item.external);
  }
  return { exports, imports: uniq(imports), external: uniq(external) };
}

function scanJs(text, rel, known) {
  const specs = JS_SPEC_RES.flatMap(re => [...text.matchAll(re)].map(m => m[1]));
  return withItems(jsExports(text), specs.map(spec => jsItem(spec, rel, known)), known);
}

function pyExports(text) {
  return [...text.matchAll(/^(?:def|class)\s+([A-Za-z_]\w*)/gm), ...text.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1]);
}

function pyItem(mod, dots, dir, known) {
  if (!mod) return null;
  const rel = mod.replace(/\./g, '/');
  const bases = dots ? [path.posix.join(dir, '../'.repeat(dots - 1))] : ['.', dir];
  for (const base of bases) {
    const target = path.posix.join(base, rel);
    const file = [target + '.py', target + '/__init__.py'].find(c => known.has(c));
    if (file) return { file };
  }
  return dots ? null : { external: mod.split('.')[0] };
}

function pyItems(text, dir, known) {
  const items = [];
  for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
    for (const mod of m[1].split(',')) items.push(pyItem(mod.trim(), 0, dir, known));
  }
  for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\b/gm)) items.push(pyItem(m[2], m[1].length, dir, known));
  return items;
}

function goExtract(text) {
  const exports = [...text.matchAll(/^func\s+([A-Z]\w*)\s*\(/gm), ...text.matchAll(/^type\s+([A-Z]\w*)/gm)].map(m => m[1]);
  const paths = [];
  for (const m of text.matchAll(/^\s*import\s*\(([^)]*)\)/gm)) paths.push(...[...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]));
  for (const m of text.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) paths.push(m[1]);
  return { exports, imports: [], external: uniq(paths) };
}

function rustExtract(text, dir, known) {
  const exports = [...text.matchAll(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|const|type)\s+([A-Za-z_]\w*)/gm)].map(m => m[1]);
  const imports = [];
  for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) {
    const target = path.posix.join(dir, m[1]);
    const file = [target + '.rs', target + '/mod.rs'].find(c => known.has(c));
    if (file) imports.push(file);
  }
  return { exports, imports: uniq(imports), external: [] };
}

function extract(lang, text, rel, known) {
  const dir = path.posix.dirname(rel);
  if (lang === 'js') return scanJs(text, rel, known);
  if (lang === 'python') return withItems(pyExports(text), pyItems(text, dir, known), known);
  if (lang === 'go') return goExtract(text);
  return rustExtract(text, dir, known);
}

// `stat` may be fs.stat (size) or a thin wrapper (bytes).
const sizeOf = st => (Number.isFinite(st.size) ? st.size : st.bytes);

async function analyze(rel, abs, st, readFile, known) {
  const entry = { bytes: sizeOf(st), mtimeMs: st.mtimeMs, lang: null, exports: [], imports: [], external: [], isTest: isTestPath(rel) };
  const lang = langOf(rel);
  if (!lang || sizeOf(st) > MAX_BYTES) return entry;
  let buf;
  try { buf = await readFile(abs); } catch { return entry; }
  const bytes = Buffer.from(buf);
  if (bytes.subarray(0, 8000).includes(0)) return entry;
  const info = extract(lang, bytes.toString('utf8'), rel, known);
  return { ...entry, lang, exports: uniq(info.exports), imports: info.imports, external: info.external };
}

function linksFor(files) {
  const paths = Object.keys(files);
  const sources = new Set(paths.filter(p => files[p].lang && !files[p].isTest));
  const links = [];
  for (const test of paths.filter(p => files[p].isTest)) {
    const direct = files[test].imports.filter(p => sources.has(p)).slice(0, MAX_LINKS);
    if (direct.length) {
      for (const source of direct) links.push({ test, source, by: 'import' });
      continue;
    }
    const stem = testStem(test);
    const named = [...sources].filter(p => fileStem(p) === stem).sort((a, b) => a.length - b.length || byPath(a, b)).slice(0, MAX_LINKS);
    for (const source of named) links.push({ test, source, by: 'name' });
  }
  return links;
}

function reverseImports(files) {
  const map = new Map();
  for (const [file, entry] of Object.entries(files)) {
    for (const target of entry.imports) {
      if (!map.has(target)) map.set(target, []);
      map.get(target).push(file);
    }
  }
  return Object.fromEntries([...map].sort(([a], [b]) => byPath(a, b)).map(([target, list]) => [target, uniq(list).slice(0, MAX_IMPORTERS)]));
}

export async function buildRepoMap(root, { previous = null, list, readFile = file => fs.readFile(file), stat = file => fs.stat(file), head = null, now = Date.now } = {}) {
  if (typeof list !== 'function') throw new Error('repo-map-list-missing');
  const rels = [...new Set((await list(root)).filter(safeRel))].slice(0, MAX_FILES);
  const known = new Set(rels);
  const old = previous?.version === MAP_VERSION && previous.files ? previous.files : {};
  const entries = [];
  let reused = 0;
  for (const rel of rels) {
    const abs = path.join(root, rel);
    let st;
    try { st = await stat(abs); } catch { continue; }
    const prev = Object.hasOwn(old, rel) ? old[rel] : null;
    if (prev && prev.bytes === sizeOf(st) && prev.mtimeMs === st.mtimeMs) {
      reused += 1;
      entries.push([rel, prev]);
      continue;
    }
    entries.push([rel, await analyze(rel, abs, st, readFile, known)]);
  }
  entries.sort(([a], [b]) => byPath(a, b));
  const files = Object.fromEntries(entries);
  const testLinks = linksFor(files);
  return {
    version: MAP_VERSION,
    head,
    builtAt: new Date(now()).toISOString(),
    files,
    testLinks,
    importedBy: reverseImports(files),
    stats: {
      files: entries.length,
      tests: entries.filter(([, e]) => e.isTest).length,
      links: testLinks.length,
      reused,
    },
  };
}

export function summarizeMap(map, { scope = null } = {}) {
  const inScope = p => !scope || scope.length === 0 || scope.some(s => p.startsWith(s));
  const paths = Object.keys(map.files).filter(inScope);
  const languages = {};
  let tests = 0;
  let exports = 0;
  for (const file of paths) {
    const entry = map.files[file];
    if (entry.lang) languages[entry.lang] = (languages[entry.lang] ?? 0) + 1;
    if (entry.isTest) tests += 1;
    exports += entry.exports.length;
  }
  const links = map.testLinks.filter(link => inScope(link.test)).length;
  const hubs = Object.entries(map.importedBy)
    .filter(([file]) => inScope(file))
    .map(([file, list]) => ({ path: file, count: list.length }))
    .sort((a, b) => b.count - a.count || byPath(a.path, b.path))
    .slice(0, 20);
  return { files: paths.length, languages, tests, links, exports, hubs, ...(scope ? { scope: [...scope] } : {}) };
}

export async function readRepoMap(root) {
  const file = path.join(root, '.swarm', 'project', 'repo-map.json');
  try {
    await assertRegularOrMissing(file);
    const map = JSON.parse(await fs.readFile(file, 'utf8'));
    return map && map.version === MAP_VERSION ? map : null;
  } catch {
    return null;
  }
}

function serialize(map) {
  const text = JSON.stringify(map);
  if (Buffer.byteLength(text) <= MAP_LIMIT) return text;
  const files = Object.fromEntries(Object.entries(map.files).map(([key, entry]) => [key, { ...entry, exports: entry.exports.slice(0, MAX_EXPORTS) }]));
  const trimmed = JSON.stringify({ ...map, files });
  if (Buffer.byteLength(trimmed) > MAP_LIMIT) throw new Error('repo-map-too-large');
  return trimmed;
}

export async function writeRepoMap(root, map) {
  const text = serialize(map);
  const dir = await safeWritableDir(root, ['.swarm', 'project']);
  const file = path.join(dir, 'repo-map.json');
  await assertRegularOrMissing(file);
  const tmp = path.join(dir, `.repo-map.${randomBytes(8).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const handle = await fs.open(tmp, flags, 0o600);
  try {
    await handle.writeFile(text, 'utf8');
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return file;
}

export function mapIsFresh(map, head) {
  return typeof head === 'string' && head.length > 0 && map?.head === head;
}
