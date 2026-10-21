// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanModule, dependencyGraph, topLevelNameIndex, offsetInScannerOpaque } from '../tools/split-scan.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

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

test('tokenizer: regex versus division', () => {
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
  const swarmPath = path.join(root, '..', 'tools', 'swarm.mjs');
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
  assert.ok(items.length > 100);
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

test('tools/swarm.mjs items respect top-level structure invariants', () => {
  const swarmPath = path.join(root, '..', 'tools', 'swarm.mjs');
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
