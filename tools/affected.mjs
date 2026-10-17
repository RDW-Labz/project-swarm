const DEFAULT_GLOBAL_PATTERNS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', '.project-swarm.json', 'coordination/checks.json', '.npmrc', 'conftest.py', 'pytest.ini', 'setup.cfg', 'pyproject.toml', 'Cargo.toml', 'go.mod', /^\.github\//, /(^|\/)[^/]*\.config\.[^/]+$/, /(^|\/)tests\/_/, /(^|\/)test\/_/, /(^|\/)__tests__\/_/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)jest\.[^/]*$/, /(^|\/)vitest\.[^/]*$/, /(^|\/)[^/]*(setup|fixture)[^/]*\.(js|mjs|ts|py)$/, /(^|\/)fixtures\//];

const BAD_CHARS = /[\x00-\x1f\x7f\s{}\\]/;
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__']);
const GRAPH_LANGS = new Set(['js', 'python', 'rust']);
const IMPORTER_CAP = 200;
const MAX_BYTES = 262144;

const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const codedError = (code, message) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

export function safePath(p) {
  if (typeof p !== 'string' || p.length === 0 || BAD_CHARS.test(p)) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !seg.startsWith('-'));
}

function isTestName(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base.includes('.test.') || base.includes('.spec.') || base.includes('_test.') || /^test_.*\.py$/.test(base);
}

function inTestFolder(p) {
  return p.split('/').slice(0, -1).some((s) => TEST_FOLDERS.has(s));
}

function matchesGlobal(p, patterns) {
  return patterns.some((g) => (typeof g === 'string' ? g === p : g instanceof RegExp && g.test(p)));
}

function normalizeFiles(files) {
  const out = new Map();
  if (Array.isArray(files)) {
    for (const f of files) if (isPlainObject(f) && typeof f.path === 'string') out.set(f.path, f);
    return out;
  }
  if (isPlainObject(files)) {
    for (const [p, f] of Object.entries(files)) out.set(p, isPlainObject(f) ? f : {});
    return out;
  }
  return null;
}

function tooBig(files, p) {
  const bytes = files.get(p)?.bytes;
  return typeof bytes === 'number' && bytes > MAX_BYTES;
}

function walkImporters(start, importersOf, files, depth) {
  if (tooBig(files, start)) return { reason: `truncated-graph: ${start}` };
  const reached = new Set([start]);
  let frontier = [start];
  let level = 0;
  while (frontier.length > 0) {
    const next = [];
    for (const f of frontier) {
      const importers = importersOf(f);
      if (importers.length >= IMPORTER_CAP) return { reason: `truncated-graph: ${f}` };
      for (const i of importers) {
        if (!safePath(i) || reached.has(i)) continue;
        if (tooBig(files, i)) return { reason: `truncated-graph: ${i}` };
        reached.add(i);
        next.push(i);
      }
    }
    if (next.length === 0) break;
    level += 1;
    if (level > depth) return { reason: `depth-limit: ${start}` };
    frontier = next;
  }
  return { reached };
}

export function selectAffectedTests(map, changed, opts = {}) {
  const { depth = Infinity, maxShare = 0.6, globalPatterns, deleted } = opts;
  if (!(depth === Infinity || (Number.isInteger(depth) && depth >= 0))) throw new RangeError('depth must be an integer >= 0 or Infinity');
  if (typeof maxShare !== 'number' || maxShare < 0 || maxShare > 1) throw new RangeError('maxShare must be between 0 and 1');
  if (deleted !== undefined && !Array.isArray(deleted)) throw new TypeError('deleted must be an array');
  const patterns = globalPatterns ?? DEFAULT_GLOBAL_PATTERNS;
  const full = (reason) => ({ mode: 'full', tests: [], reasons: [reason] });

  if (!isPlainObject(map)) return full('no-map');
  const files = normalizeFiles(map.files);
  const links = map.testLinks ?? [];
  const importedBy = map.importedBy ?? {};
  if (!files || !Array.isArray(links) || !isPlainObject(importedBy)) return full('no-map');
  if (!Array.isArray(changed) || changed.length === 0) return full('no-changes');

  let total = 0;
  for (const p of files.keys()) if (safePath(p) && isTestName(p)) total += 1;
  if (total === 0) return full('no-tests');

  const deletedSet = new Set(deleted ?? []);
  const reasons = [];
  for (const d of deletedSet) reasons.push(`deleted-file: ${String(d)}`);

  const paths = [...new Set(changed)];
  const tests = new Set();
  const sources = [];
  for (const p of paths) {
    if (!safePath(p)) {
      reasons.push(`unknown-file: ${String(p)}`);
      continue;
    }
    if (matchesGlobal(p, patterns)) {
      reasons.push(`global: ${p}`);
      continue;
    }
    if (isTestName(p)) {
      tests.add(p);
      continue;
    }
    if (inTestFolder(p)) {
      reasons.push(`test-helper: ${p}`);
      continue;
    }
    const meta = files.get(p);
    if (!meta) {
      reasons.push(`unknown-file: ${p}`);
      continue;
    }
    if (!meta.lang) {
      reasons.push(`unmapped-file: ${p}`);
      continue;
    }
    if (!GRAPH_LANGS.has(meta.lang)) {
      reasons.push(`no-import-graph: ${p}`);
      continue;
    }
    sources.push(p);
  }
  if (reasons.length > 0) return { mode: 'full', tests: [], reasons };

  const linkedBy = new Map();
  for (const l of links) {
    if (!isPlainObject(l) || !safePath(l.source) || !safePath(l.test)) continue;
    if (!linkedBy.has(l.source)) linkedBy.set(l.source, []);
    linkedBy.get(l.source).push(l.test);
  }
  const importersOf = (t) => (hasOwn(importedBy, t) && Array.isArray(importedBy[t]) ? importedBy[t] : []);

  for (const s of sources) {
    const walk = walkImporters(s, importersOf, files, depth);
    if (walk.reason) {
      reasons.push(walk.reason);
      continue;
    }
    let found = false;
    for (const r of walk.reached) {
      if (isTestName(r)) {
        tests.add(r);
        found = true;
      }
      for (const t of linkedBy.get(r) ?? []) {
        tests.add(t);
        found = true;
      }
    }
    if (!found) reasons.push(`no-test-reach: ${s}`);
  }
  if (reasons.length > 0) return { mode: 'full', tests: [], reasons };

  const list = [...tests].filter((t) => !deletedSet.has(t)).sort();
  if (list.length / total > maxShare) {
    return { mode: 'full', tests: [], reasons: [`too-wide: ${list.length} of ${total} tests`] };
  }
  return { mode: 'affected', tests: list, reasons: [`affected: ${list.length} test(s) from ${paths.length} changed file(s)`] };
}

export function expandAffectedArgv(argv, selection) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv[0] === '{affected}') throw codedError('affected-argv', '{affected} cannot be the first argv item');
  if (!selection || selection.mode !== 'affected') {
    return { argv: [...argv], empty: false, full: true };
  }
  const tests = Array.isArray(selection.tests) ? selection.tests : [];
  for (const t of tests) {
    if (!safePath(t)) throw codedError('affected-argv', 'unsafe test path in selection');
  }
  const out = [];
  let present = false;
  for (const a of argv) {
    if (a === '{affected}') {
      present = true;
      out.push(...tests.map((t) => `./${t}`));
    } else {
      out.push(a);
    }
  }
  return { argv: out, empty: present && tests.length === 0 };
}
