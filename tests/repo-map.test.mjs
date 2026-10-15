// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAP_VERSION, buildRepoMap, summarizeMap, readRepoMap, writeRepoMap, mapIsFresh } from '../tools/repo-map.mjs';

const NL = String.fromCharCode(10);
const L = (...lines) => lines.join(NL);
const NOW = () => 1700000000000;
const made = [];
after(async () => { for (const dir of made) await fs.rm(dir, { recursive: true, force: true }); });

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rmap-'));
  made.push(root);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body);
  }
  return root;
}

const at = (root, args) => path.resolve(root, String(args.at(-1)));

function build(root, paths, extra = {}) {
  return buildRepoMap(root, {
    list: async () => paths,
    readFile: async (...args) => fs.readFile(at(root, args)),
    stat: async (...args) => { const s = await fs.stat(at(root, args)); return { bytes: s.size, mtimeMs: s.mtimeMs }; },
    head: 'h1',
    now: NOW,
    ...extra,
  });
}

async function mapOf(files, extra) {
  const root = await tree(files);
  return { root, map: await build(root, Object.keys(files), extra) };
}

test('JS and TS exports, imports and external packages', async () => {
  const { map } = await mapOf({
    'src/a.js': L(`import { x } from './b.js';`, `import _ from 'lodash';`, `import _again from 'lodash';`, `const z = require('@scope/pkg/sub');`, `export function foo() {}`, `export class Bar {}`, `export default 1;`),
    'src/b.js': L(`export const c = 1;`, `let d = 2;`, `export { d as e };`, `export * from './x.js';`),
    'src/c.ts': 'export async function run() {}',
  });
  const a = map.files['src/a.js'];
  assert.equal(a.lang, 'js');
  for (const name of ['foo', 'Bar', 'default']) assert.ok(a.exports.includes(name));
  assert.deepEqual(a.imports, ['src/b.js']);
  assert.deepEqual(a.external, ['@scope/pkg', 'lodash']);
  assert.deepEqual([...map.files['src/b.js'].exports].sort(), ['c', 'e']);
  assert.deepEqual(map.files['src/c.ts'].exports, ['run']);
  assert.equal(map.files['src/c.ts'].lang, 'js');
  assert.deepEqual(map.importedBy['src/b.js'], ['src/a.js']);
});

test('import resolution tries extensions then index files', async () => {
  const { map } = await mapOf({
    'src/x.js': L(`import './util';`, `import './solo';`, `const m = import('./lazy.mjs');`, `import './missing';`),
    'src/util/index.ts': 'export const u = 1;',
    'src/solo.tsx': 'export const s = 1;',
    'src/lazy.mjs': 'export const l = 1;',
  });
  assert.deepEqual(map.files['src/x.js'].imports, ['src/lazy.mjs', 'src/solo.tsx', 'src/util/index.ts']);
});

test('Python exports, imports and external packages', async () => {
  const { map } = await mapOf({
    'pkg/mod.py': L('def run():', '    pass', 'class Thing:', '    pass', 'MAX_SIZE = 3', 'lower = 1'),
    'pkg/__init__.py': '',
    'pkg/sib.py': 'y = 1',
    'pkg/tool.py': L('from .sib import y', 'import os.path'),
    'app.py': L('import pkg.mod', 'from pkg.mod import run', 'import os'),
  });
  const mod = map.files['pkg/mod.py'];
  assert.equal(mod.lang, 'python');
  for (const name of ['MAX_SIZE', 'Thing', 'run']) assert.ok(mod.exports.includes(name));
  assert.ok(!mod.exports.includes('lower'));
  assert.deepEqual(map.files['app.py'].imports, ['pkg/mod.py']);
  assert.deepEqual(map.files['app.py'].external, ['os']);
  assert.deepEqual(map.files['pkg/tool.py'].imports, ['pkg/sib.py']);
  assert.deepEqual(map.files['pkg/tool.py'].external, ['os']);
});

test('Go and Rust exports and imports', async () => {
  const { map } = await mapOf({
    'lib/x.go': L('package lib', 'import "fmt"', 'func Name() {}', 'func helper() {}', 'type Thing struct{}', 'func (t Thing) Method() {}'),
    'src/lib.rs': L('pub fn go() {}', 'fn private() {}', 'pub struct S;', 'mod inner;'),
    'src/inner.rs': 'pub const K: u8 = 1;',
  });
  assert.equal(map.files['lib/x.go'].lang, 'go');
  assert.deepEqual([...map.files['lib/x.go'].exports].sort(), ['Name', 'Thing']);
  assert.deepEqual(map.files['lib/x.go'].external, ['fmt']);
  assert.equal(map.files['src/lib.rs'].lang, 'rust');
  assert.deepEqual([...map.files['src/lib.rs'].exports].sort(), ['S', 'go']);
  assert.deepEqual(map.files['src/lib.rs'].imports, ['src/inner.rs']);
  assert.deepEqual(map.files['src/inner.rs'].exports, ['K']);
});

test('unknown, binary and oversized files are listed without lang', async () => {
  const { map } = await mapOf({
    'README.md': '# hi',
    'icon.js': Buffer.from([0x63, 0, 0x64]),
    'big.js': Buffer.alloc(1024 * 1024 + 1, 0x61),
  });
  for (const rel of ['README.md', 'icon.js', 'big.js']) {
    assert.equal(map.files[rel].lang, null);
    assert.deepEqual(map.files[rel].exports, []);
    assert.deepEqual(map.files[rel].imports, []);
  }
});

test('unsafe list entries are skipped and at most 20000 files are mapped', async () => {
  const many = Array.from({ length: 20005 }, (_, i) => `gen/f${i}.txt`);
  const root = await tree({ 'ok.txt': 'x' });
  const map = await build(root, ['../evil.js', '/etc/passwd', 'a' + String.fromCharCode(0) + 'b.js', 'ok.txt', ...many]);
  const keys = Object.keys(map.files);
  assert.ok(keys.length <= 20000);
  assert.ok(!keys.some(k => k.includes('..') || path.isAbsolute(k) || k.includes(String.fromCharCode(0))));
  assert.equal(map.files['ok.txt'].lang, null);
});

test('isTest flags and test links by import and by name', async () => {
  const { map } = await mapOf({
    'src/a.js': 'export const a = 1;',
    'src/deep/c.js': 'export const c = 1;',
    'lib/c.js': 'export const c = 2;',
    'tests/a.test.js': `import '../src/a.js';`,
    'tests/c.test.js': 'test();',
    'x/a_test.go': 'package x',
  });
  assert.equal(map.files['tests/a.test.js'].isTest, true);
  assert.equal(map.files['src/a.js'].isTest, false);
  assert.equal(map.files['x/a_test.go'].isTest, true);
  assert.deepEqual(map.testLinks.find(l => l.test === 'tests/a.test.js'), { test: 'tests/a.test.js', source: 'src/a.js', by: 'import' });
  assert.equal(map.testLinks.filter(l => l.test === 'tests/a.test.js').length, 1);
  assert.deepEqual(map.testLinks.find(l => l.test === 'tests/c.test.js'), { test: 'tests/c.test.js', source: 'lib/c.js', by: 'name' });
  assert.ok(map.testLinks.every(l => !map.files[l.source].isTest));
});

test('a test links to at most five sources', async () => {
  const files = { 'tests/big.test.js': Array.from({ length: 7 }, (_, i) => `import '../src/s${i}.js';`).join(NL) };
  for (let i = 0; i < 7; i++) files[`src/s${i}.js`] = 'export const v = 1;';
  const { map } = await mapOf(files);
  assert.equal(map.testLinks.filter(l => l.test === 'tests/big.test.js').length, 5);
});

test('importedBy is sorted and the output is deterministic', async () => {
  const files = {
    'src/c.js': `import './b.js';`,
    'src/a.js': `import './b.js';`,
    'src/b.js': 'export const b = 1;',
  };
  const root = await tree(files);
  const one = await build(root, Object.keys(files).reverse());
  const two = await build(root, Object.keys(files));
  assert.deepEqual(one.importedBy['src/b.js'], ['src/a.js', 'src/c.js']);
  const strip = ({ builtAt, ...rest }) => rest;
  assert.deepEqual(strip(one), strip(two));
});

test('unchanged entries are reused and gone files drop out', async () => {
  const files = { 'src/a.js': 'export const a = 1;', 'src/b.js': 'export const b = 1;' };
  const root = await tree(files);
  const first = await build(root, Object.keys(files));
  const second = await build(root, Object.keys(files), { previous: first });
  assert.equal(second.stats.reused, 2);
  await fs.writeFile(path.join(root, 'src/a.js'), L('export const a = 1;', 'export const more = 2;'));
  const third = await build(root, ['src/a.js'], { previous: second });
  assert.equal(third.stats.reused, 0);
  assert.equal(third.files['src/b.js'], undefined);
  assert.ok(third.files['src/a.js'].exports.includes('more'));
});

test('mapIsFresh needs the same non-empty head', () => {
  assert.equal(mapIsFresh({ head: 'h1' }, 'h1'), true);
  assert.equal(mapIsFresh({ head: 'h1' }, 'h2'), false);
  assert.equal(mapIsFresh({ head: '' }, ''), false);
  assert.equal(mapIsFresh({ head: 'h1' }, ''), false);
});

test('summarizeMap counts, scopes and ranks hubs', async () => {
  const { map } = await mapOf({
    'src/a.js': 'export const a = 1;',
    'src/b.js': `import './a.js';`,
    'src/c.js': L(`import './b.js';`, `import './a.js';`),
    'tests/a.test.js': `import '../src/a.js';`,
    'docs/readme.md': '# x',
  });
  const all = summarizeMap(map, {});
  assert.equal(all.files, 5);
  assert.equal(all.tests, 1);
  assert.equal(all.links, 1);
  assert.equal(all.languages.js, 4);
  assert.equal(all.hubs[0].path, 'src/a.js');
  assert.equal(summarizeMap(map, { scope: ['src/'] }).files, 3);
});

test('write then read round-trips and bad files read as null', async () => {
  const { root, map } = await mapOf({ 'src/a.js': 'export const a = 1;' });
  assert.equal(await readRepoMap(root), null);
  await writeRepoMap(root, map);
  const back = await readRepoMap(root);
  assert.equal(back.version, MAP_VERSION);
  assert.deepEqual(back.files, map.files);
  const file = path.join(root, '.swarm', 'project', 'repo-map.json');
  await fs.writeFile(file, '{not json');
  assert.equal(await readRepoMap(root), null);
  await fs.writeFile(file, JSON.stringify({ ...map, version: MAP_VERSION + 1 }));
  assert.equal(await readRepoMap(root), null);
});

test('a symlinked .swarm/project is refused on write', async () => {
  const { root, map } = await mapOf({ 'src/a.js': 'export const a = 1;' });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rmap-out-'));
  made.push(outside);
  await fs.mkdir(path.join(root, '.swarm'));
  await fs.symlink(outside, path.join(root, '.swarm', 'project'));
  await assert.rejects(writeRepoMap(root, map));
  assert.deepEqual(await fs.readdir(outside), []);
});
