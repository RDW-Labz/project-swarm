// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const acornInstalled = await import('acorn').then(() => true, () => false);
if (!acornInstalled) {
  test('split-scan tests', { skip: 'acorn not installed: run npm ci' }, () => {});
} else {
  const { scanModule, dependencyGraph, topLevelNameIndex, offsetInScannerOpaque } = await import('../tools/split-scan.mjs');
  const { regexIdentifierTokens } = await import('../tools/split-module.mjs');

const root = path.dirname(fileURLToPath(import.meta.url));
const swarmPath = path.join(root, '..', 'tools', 'swarm.mjs');
const swarmSplitDir = path.join(root, '..', 'tools', 'swarm');

function swarmMonolithPreSplit() {
  if (fs.existsSync(swarmSplitDir)) return false;
  if (!fs.existsSync(swarmPath)) return false;
  const lineCount = fs.readFileSync(swarmPath, 'utf8').split('\n').length;
  return lineCount >= 5000;
}

function skipIfSwarmAlreadySplit(t, reason) {
  if (!swarmMonolithPreSplit()) {
    t.skip(reason || 'tools/swarm.mjs already split or not monolithic');
  }
}

function roundTrip(src) {
  const { items } = scanModule(src);
  let rebuilt = '';
  let pos = 0;
  for (const it of items) {
    rebuilt += src.slice(pos, it.start) + it.text;
    pos = it.end;
  }
  rebuilt += src.slice(pos);
  return { items, rebuilt };
}

test('splits imports and const declarations with blank-line gaps', () => {
  const src = 'import fs from "node:fs";\n\nconst a = 1;\nconst b = 2;\n';
  const { items, rebuilt } = roundTrip(src);
  assert.equal(rebuilt, src);
  assert.equal(items.length, 3);
  assert.equal(items[0].kind, 'import');
  assert.deepEqual(items[0].names, ['fs']);
  assert.equal(items[1].kind, 'declaration');
  assert.deepEqual(items[1].names, ['a']);
});

test('attached line comment belongs to the following item', () => {
  const src = '// header\nexport const x = 1;\n';
  const { items } = scanModule(src);
  assert.equal(items.length, 1);
  assert.ok(items[0].text.startsWith('// header'));
  assert.equal(items[0].exported, true);
  assert.deepEqual(items[0].names, ['x']);
});

test('function async generator and class kinds', () => {
  const src = [
    'async function foo() {}\n',
    'function* gen() {}\n',
    'class Bar {}\n',
  ].join('\n');
  const { items } = scanModule(src);
  assert.equal(items[0].kind, 'function');
  assert.deepEqual(items[0].names, ['foo']);
  assert.equal(items[1].kind, 'function');
  assert.deepEqual(items[1].names, ['gen']);
  assert.equal(items[2].kind, 'class');
  assert.deepEqual(items[2].names, ['Bar']);
});

test('export-from and export-list statements', () => {
  const src = 'export { a, b as c } from "./m.mjs";\nexport { local };\n';
  const { items, exports } = scanModule(src);
  assert.equal(items[0].kind, 'export');
  assert.equal(items[1].kind, 'export');
  assert.ok(exports.includes('a'));
  assert.ok(exports.includes('c'));
  assert.ok(exports.includes('local'));
});

test('re-export statement', () => {
  const src = 'export { detect } from "./cli.mjs";\n';
  const { items } = scanModule(src);
  assert.equal(items[0].kind, 'export');
  assert.ok(items[0].names.includes('detect'));
});

test('expression statement and trailing newline span', () => {
  const src = 'void 0;\n\nfoo();\n';
  const { items, rebuilt } = roundTrip(src);
  assert.equal(rebuilt, src);
  assert.equal(items[0].kind, 'expression');
  assert.equal(items[1].kind, 'expression');
  assert.ok(items[0].uses.has('foo') === false);
  assert.ok(items[1].uses.has('foo'));
});

// Acorn parses regex literals vs division; no hand-rolled lexer quirks.
test('regex versus division', () => {
  const src = 'const pattern = /a\\/b/g;\nconst ratio = 1 / 2;\n';
  const { items } = scanModule(src);
  assert.equal(items.length, 2);
  assert.ok(!items[0].uses.has('g'));
  assert.ok(items[1].uses.has('ratio') === false);
});

test('template literal with nested expression', () => {
  const src = 'const msg = `a ${`b ${outer}`} end`;\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('outer'));
});

test('optional chaining and member access are not references', () => {
  const src = 'const v = obj?.prop.nested;\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('obj'));
  assert.ok(!items[0].uses.has('prop'));
  assert.ok(!items[0].uses.has('nested'));
});

test('object literal keys are not references; shorthand is', () => {
  const src = 'const o = { key: value, shorthand };\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('value'));
  assert.ok(items[0].uses.has('shorthand'));
  assert.ok(!items[0].uses.has('key'));
});

test('destructuring declaration names', () => {
  const src = 'const { a, b: renamed } = source;\n';
  const { items } = scanModule(src);
  assert.ok(items[0].names.includes('a'));
  assert.ok(items[0].names.includes('renamed'));
  assert.ok(items[0].uses.has('source'));
});

test('multiple declarators in one statement', () => {
  const src = 'let x = 1, y = x;\n';
  const { items } = scanModule(src);
  assert.deepEqual(items[0].names.sort(), ['x', 'y']);
});

test('local shadowing avoids false external uses', () => {
  const src = 'const outer = 1;\nfunction f() { const outer = 2; return outer; }\n';
  const { items } = scanModule(src);
  assert.ok(!items[1].uses.has('outer'));
});

test('catch parameter is local', () => {
  const src = 'try {} catch (err) { console.log(err); }\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('err'));
  assert.ok(items[0].uses.has('console'));
});

test('for-loop head bindings are local', () => {
  const src = 'for (let i = 0; i < limit; i++) {}\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('limit'));
  assert.ok(!items[0].uses.has('i'));
});

test('arrow function parameter binding', () => {
  const src = 'const fn = (param) => param + 1;\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('param'));
});

test('label statement does not count label as use', () => {
  const src = 'loop: for (;;) break loop;\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('loop'));
});

test('spread element uses binding after rest operator', () => {
  const src = "const CLI_AGENTS = ['claude', 'codex', ...EXTRA_CLI_AGENTS];\n";
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('EXTRA_CLI_AGENTS'));
});

test('spread inside call or freeze parens is a use not an arrow param', () => {
  const cases = [
    ['export const A = Object.freeze([...X, ...Y]);', ['X', 'Y']],
    ['const D = f([...Y]);', ['Y', 'f']],
    ['const E = Object.freeze([...Y]);', ['Y']],
    ['const B = [...X, ...Y];', ['X', 'Y']],
    ['function has(job) { return [...X, ...Y].includes(job); }\n', ['X', 'Y']],
    ['const merged = f({ ...Y });', ['Y', 'f']],
    ['const both = g([a, ...Y], [...Z]);', ['a', 'Y', 'Z', 'g']],
    ['const nested = h(i([...W]));', ['W', 'h', 'i']],
    ['const arrowInCall = k((x) => x + Y);', ['Y', 'k']],
  ];
  for (const [src, expected] of cases) {
    const { items } = scanModule(`${src}\n`);
    for (const name of expected) {
      assert.ok(items[0].uses.has(name), `${src} missing use ${name}`);
    }
  }
});

test('parenthesized arrow params versus expression grouping', () => {
  const src = 'const fn = ((...args) => args.length);\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('args'));
});

test('destructuring assignment uses rhs bindings', () => {
  const src = 'let p, q;\n[p, q] = pair;\n';
  const { items } = scanModule(src);
  assert.ok(items[1].uses.has('pair'));
  assert.ok(!items[1].uses.has('p'));
  assert.ok(!items[1].uses.has('q'));
});

test('spread-in-paren agent dependencies (fixture)', () => {
  const src = "export const AGENTS = Object.freeze([...API_AGENTS, 'local']);\n";
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('API_AGENTS'));
});

test('tools/swarm.mjs records spread-in-paren agent dependencies', (t) => {
  skipIfSwarmAlreadySplit(t, 'spread-in-paren assertions target monolithic tools/swarm.mjs');
  const text = fs.readFileSync(swarmPath, 'utf8');
  const { items } = scanModule(text);

  const agentsItem = items.find((it) => it.names.includes('AGENTS') && it.exported);
  assert.ok(agentsItem?.uses.has('API_AGENTS'), 'export AGENTS uses API_AGENTS');

  const pickJobRoute = items.find((it) => it.names.includes('pickJobRoute'));
  assert.ok(pickJobRoute?.uses.has('API_AGENTS'), 'pickJobRoute uses API_AGENTS');

  const resolveAskRoute = items.find((it) => it.names.includes('resolveAskRoute'));
  assert.ok(resolveAskRoute?.uses.has('API_AGENTS'), 'resolveAskRoute uses API_AGENTS');

  const cliAgents = items.find(
    (it) => it.kind === 'declaration' && it.names.length === 1 && it.names[0] === 'CLI_AGENTS',
  );
  assert.ok(cliAgents?.uses.has('EXTRA_CLI_AGENTS'), 'CLI_AGENTS uses EXTRA_CLI_AGENTS');

  for (const it of items) {
    if (!it.text.includes('...API_AGENTS')) continue;
    assert.ok(it.uses.has('API_AGENTS'), `${it.names.join(',')} missing API_AGENTS use`);
  }
});

test('rest parameter name is not an external use', () => {
  const src = 'function f(...args) { return args.length; }\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('args'));
});

test('object rest pattern in destructuring is not an external use', () => {
  const src = 'const { a, ...rest } = source;\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('source'));
  assert.ok(!items[0].uses.has('rest'));
  assert.ok(items[0].names.includes('rest'));
});

test('object spread expression uses the spread binding', () => {
  const src = 'const merged = { ...others };\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('others'));
});

test('keyword property access is not a reference', () => {
  const src = 'const x = obj.default + obj.class;\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('obj'));
  assert.ok(!items[0].uses.has('default'));
  assert.ok(!items[0].uses.has('class'));
});

test('numeric literal with exponent after dot does not treat e as member access', () => {
  const src = 'const n = 1.e3;\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('e3'));
});

test('dependencyGraph links top-level symbols', () => {
  const src = 'const shared = 1;\nfunction useIt() { return shared; }\n';
  const { items } = scanModule(src);
  const graph = dependencyGraph(items);
  assert.deepEqual(graph[1], ['shared']);
});

test('topLevelNameIndex maps declared names', () => {
  const src = 'function alpha() {}\nconst beta = 1;\n';
  const { items } = scanModule(src);
  const idx = topLevelNameIndex(items);
  assert.equal(idx.get('alpha').names[0], 'alpha');
  assert.equal(idx.get('beta').names[0], 'beta');
});

test('block comment attached above export', () => {
  const src = '/* doc */\nexport function documented() {}\n';
  const { items } = scanModule(src);
  assert.ok(items[0].text.startsWith('/* doc */'));
  assert.equal(items[0].kind, 'function');
  assert.equal(items[0].exported, true);
});

test('shebang line stays with first item', () => {
  const src = '#!/usr/bin/env node\nconst first = 1;\n';
  const { items, rebuilt } = roundTrip(src);
  assert.equal(rebuilt, src);
  assert.ok(items[0].text.includes('#!'));
});

test('string escapes and block comments inside strings do not break scan', () => {
  const src = 'const s = "a /* not comment */ \\n";\n';
  const { rebuilt } = roundTrip(src);
  assert.equal(rebuilt, src);
});

test('getter and setter in class body', () => {
  const src = 'class C { get x() { return this._x; } set x(v) { this._x = v; } }\n';
  const { items } = scanModule(src);
  assert.equal(items[0].kind, 'class');
  assert.ok(!items[0].uses.has('x'));
});

test('items do not overlap', () => {
  const src = 'const a=1;\nconst b=2;\nconst c=3;\n';
  const { items } = scanModule(src);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      assert.ok(a.end <= b.start || b.end <= a.start);
    }
  }
});

test('order array lists item indices deterministically', () => {
  const src = 'const a=1;\nconst b=2;\n';
  const { order } = scanModule(src);
  assert.deepEqual(order, [0, 1]);
});

test('scans real tools/swarm.mjs losslessly and quickly', () => {
  if (!fs.existsSync(swarmPath)) return;
  const text = fs.readFileSync(swarmPath, 'utf8');
  const started = Date.now();
  const { items, exports } = scanModule(text);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `scan took ${elapsed}ms`);

  let rebuilt = '';
  let pos = 0;
  for (const it of items) {
    rebuilt += text.slice(pos, it.start) + it.text;
    pos = it.end;
  }
  rebuilt += text.slice(pos);
  assert.equal(rebuilt, text);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      assert.ok(a.end <= b.start || b.end <= a.start, `overlap ${i} ${j}`);
    }
  }

  const declared = new Set();
  for (const it of items) {
    for (const n of it.names) declared.add(n);
    if (it.exported) for (const n of it.names) declared.add(n);
  }
  for (const name of exports) {
    assert.ok(declared.has(name), `missing export name ${name}`);
  }
  if (swarmMonolithPreSplit()) assert.ok(items.length > 100);
});

const TOP_LEVEL_LINE =
  /^(?:async\s+)?function\b|^(?:export\s+)?(?:async\s+)?function\b|^export\s+(?:async\s+)?function\b|^export\s+const\b|^const\b|^let\b|^class\b|^import\b/;

function onlyLeadingNoiseBefore(lines, index) {
  for (let j = 0; j < index; j++) {
    const raw = lines[j];
    const line = raw.trim();
    if (line === '') continue;
    if (j === 0 && raw.startsWith('#!')) continue;
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*') || line.endsWith('*/')) continue;
    return false;
  }
  return true;
}

function lineStartOffset(text, lineNumber) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lineNumber - 1; i++) offset += lines[i].length + 1;
  return offset;
}

test('division after closing paren is not a regex literal', () => {
  const src = 'const band = Math.floor(Number(/(\\d+)%/.exec(msg)?.[1] ?? 0) / 10);\n';
  const { items, rebuilt } = roundTrip(src);
  assert.equal(rebuilt, src);
  assert.equal(items.length, 1);
});

test('regex character class may contain a slash', () => {
  const src = 'const parts = path.split(/[\\\\/]/);\n';
  const { items, rebuilt } = roundTrip(src);
  assert.equal(rebuilt, src);
  assert.equal(items.length, 1);
  assert.ok(!items[0].uses.has('includes'));
});

const DIFF_USES_ALLOWLIST = [];

const JS_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'of',
  'static', 'get', 'set', 'from', 'as',
]);

function identifiersInTemplateExpressions(text) {
  const names = new Set();
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '{') {
          i += 2;
          let depth = 1;
          const start = i;
          while (i < text.length && depth > 0) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
          }
          const expr = text.slice(start, i - 1);
          for (const { name } of regexIdentifierTokens(expr)) {
            if (!JS_KEYWORDS.has(name)) names.add(name);
          }
          for (const re of [/\.\.\.\s*([A-Za-z_$][\w$]*)/g, /\b([A-Za-z_$][\w$]*)\s*\./g, /\bnew\s+([A-Za-z_$][\w$]*)/g]) {
            let m;
            while ((m = re.exec(expr)) !== null) {
              if (!JS_KEYWORDS.has(m[1])) names.add(m[1]);
            }
          }
          continue;
        }
        if (text[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return names;
}

function crudeIdentifierOverApprox(text) {
  const names = new Set();
  const addFromSlice = (slice) => {
    for (const { name } of regexIdentifierTokens(slice)) {
      if (!JS_KEYWORDS.has(name)) names.add(name);
    }
    for (const re of [
      /\.\.\.\s*([A-Za-z_$][\w$]*)/g,
      /\b([A-Za-z_$][\w$]*)\s*\./g,
      /\bnew\s+([A-Za-z_$][\w$]*)/g,
    ]) {
      let m;
      while ((m = re.exec(slice)) !== null) {
        if (!JS_KEYWORDS.has(m[1])) names.add(m[1]);
      }
    }
  };
  addFromSlice(text);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    addFromSlice(line);
  }
  for (const name of identifiersInTemplateExpressions(text)) names.add(name);
  let word;
  const wordRe = /\b([A-Za-z_$][\w$]*)\b/g;
  while ((word = wordRe.exec(text)) !== null) {
    if (!JS_KEYWORDS.has(word[1])) names.add(word[1]);
  }
  return names;
}

test('parser uses are covered by crude regex over-approximation on swarm.mjs', () => {
  if (!fs.existsSync(swarmPath)) return;
  const text = fs.readFileSync(swarmPath, 'utf8');
  const { items } = scanModule(text);
  const allow = new Set(DIFF_USES_ALLOWLIST);
  for (const it of items) {
    const approx = crudeIdentifierOverApprox(it.text);
    for (const use of it.uses) {
      if (allow.has(use)) continue;
      assert.ok(approx.has(use), `item ${it.names.join(',') || it.index} use ${use} missing from regex approx`);
    }
  }
});

test('spread in call arguments', () => {
  const src = 'foo(bar, ...items);\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('foo'));
  assert.ok(items[0].uses.has('bar'));
  assert.ok(items[0].uses.has('items'));
});

test('call as non-first argument with object argument', () => {
  const src = 'outer(middle, inner({ key: value }));\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('outer'));
  assert.ok(items[0].uses.has('middle'));
  assert.ok(items[0].uses.has('inner'));
  assert.ok(items[0].uses.has('value'));
  assert.ok(!items[0].uses.has('key'));
});

test('destructuring defaults in parameters', () => {
  const src = 'function f({ a = defaultA } = {}) { return a; }\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('defaultA'));
  assert.ok(!items[0].uses.has('a'));
});

test('computed object keys are uses', () => {
  const src = 'const o = { [dynamic]: 1 };\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('dynamic'));
});

test('class members and static blocks', () => {
  const src = 'class C { static { helper(); } method() { return dep; } }\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('helper'));
  assert.ok(items[0].uses.has('dep'));
  assert.ok(!items[0].uses.has('method'));
});

test('tagged template tag is a use', () => {
  const src = 'const out = tag`hello ${name}`;\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('tag'));
  assert.ok(items[0].uses.has('name'));
});

test('hoisted function and var in item', () => {
  const src = 'function outer() { function inner() {} var v = 1; return inner() + v; }\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('inner'));
  assert.ok(!items[0].uses.has('v'));
});

test('import.meta is not an identifier use', () => {
  const src = 'const u = import.meta.url;\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('import'));
  assert.ok(!items[0].uses.has('meta'));
});

test('private class fields are not free uses', () => {
  const src = 'class C { #secret = 1; read() { return this.#secret; } }\n';
  const { items } = scanModule(src);
  assert.ok(!items[0].uses.has('secret'));
});

test('top-level await expression', () => {
  const src = 'const data = await loadRemote();\n';
  const { items } = scanModule(src);
  assert.ok(items[0].uses.has('loadRemote'));
});

test('tools/swarm.mjs column-0 structure invariant (any layout)', () => {
  if (!fs.existsSync(swarmPath)) return;
  const text = fs.readFileSync(swarmPath, 'utf8');
  const { items } = scanModule(text);
  const startsAt = new Set(items.map((it) => it.startLine));
  for (const it of items) {
    const sliceLines = it.text.split('\n');
    for (let i = 1; i < sliceLines.length; i++) {
      if (!TOP_LEVEL_LINE.test(sliceLines[i])) continue;
      const fileLine = it.startLine + i;
      const offset = lineStartOffset(text, fileLine);
      if (offsetInScannerOpaque(text, offset)) continue;
      if (onlyLeadingNoiseBefore(sliceLines, i)) continue;
      if (startsAt.has(fileLine)) continue;
      assert.fail(
        `column-0 top-level line ${fileLine} sits inside item ${it.names} (${it.startLine}-${it.endLine})`,
      );
    }
  }
});

test('tools/swarm.mjs items respect top-level structure invariants', (t) => {
  skipIfSwarmAlreadySplit(t, 'runManifestBody and item-count invariants target monolithic swarm.mjs');
  const text = fs.readFileSync(swarmPath, 'utf8');
  const lines = text.split('\n');
  const { items } = scanModule(text);

  assert.ok(items.length > 200);
  const largest = items.reduce(
    (best, it) => (it.endLine - it.startLine > best.endLine - best.startLine ? it : best),
    items[0],
  );
  assert.ok(largest.endLine - largest.startLine + 1 < 1500, `largest item ${largest.names} spans too many lines`);

  const runManifest = items.find((it) => it.names.includes('runManifestBody'));
  assert.ok(runManifest, 'runManifestBody item');
  let expectedEnd = null;
  for (let i = runManifest.startLine; i < lines.length; i++) {
    if (lines[i] === '}') {
      expectedEnd = i + 1;
      break;
    }
  }
  assert.equal(runManifest.endLine, expectedEnd);

  const startsAt = new Set(items.map((it) => it.startLine));
  for (const it of items) {
    const sliceLines = it.text.split('\n');
    for (let i = 1; i < sliceLines.length; i++) {
      if (!TOP_LEVEL_LINE.test(sliceLines[i])) continue;
      const fileLine = it.startLine + i;
      const offset = lineStartOffset(text, fileLine);
      if (offsetInScannerOpaque(text, offset)) continue;
      if (onlyLeadingNoiseBefore(sliceLines, i)) continue;
      if (startsAt.has(fileLine)) continue;
      assert.fail(
        `column-0 top-level line ${fileLine} sits inside item ${it.names} (${it.startLine}-${it.endLine})`,
      );
    }
  }
});

}
