// Hidden tests for TASK.md. Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWaves } from '../planWaves.mjs';

const code = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected throw'); };

test('empty input', () => {
  assert.deepEqual(planWaves([]), { waves: [], stats: { waveCount: 0, maxParallel: 0, criticalPath: 0, totalWeight: 0 } });
});

test('BAD_INPUT', () => {
  for (const bad of [null, undefined, {}, [{}], [{ id: '' }], [{ id: 5 }], [{ id: 'a' }, null]]) {
    assert.equal(code(() => planWaves(bad)).code, 'BAD_INPUT');
  }
});

test('DUPLICATE_ID lists sorted unique ids', () => {
  const e = code(() => planWaves([{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }, { id: 'a' }]));
  assert.equal(e.code, 'DUPLICATE_ID');
  assert.deepEqual(e.ids, ['a', 'b']);
});

test('UNKNOWN_DEP lists sorted unique pairs', () => {
  const e = code(() => planWaves([{ id: 'b', dependsOn: ['x'] }, { id: 'a', dependsOn: ['y', 'x', 'x'] }]));
  assert.equal(e.code, 'UNKNOWN_DEP');
  assert.deepEqual(e.missing, ['a->x', 'a->y', 'b->x']);
});

test('validation order: duplicate before unknown dep before cycle', () => {
  assert.equal(code(() => planWaves([{ id: 'a', dependsOn: ['z'] }, { id: 'a' }])).code, 'DUPLICATE_ID');
  assert.equal(code(() => planWaves([{ id: 'a', dependsOn: ['a', 'z'] }])).code, 'UNKNOWN_DEP');
});

test('CYCLE lists only tickets on a cycle', () => {
  const e = code(() => planWaves([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['a'] }, { id: 'e', dependsOn: ['e'] }, { id: 'f' },
    { id: 'g', dependsOn: ['h'] }, { id: 'h', dependsOn: ['g', 'f'] }, { id: 'i', dependsOn: ['h', 'f'] },
  ]));
  assert.equal(e.code, 'CYCLE');
  assert.deepEqual(e.ids, ['a', 'b', 'c', 'e', 'g', 'h']);
});

test('basic diamond', () => {
  const r = planWaves([{ id: 'd', dependsOn: ['b', 'c'] }, { id: 'c', dependsOn: ['a'] }, { id: 'b', dependsOn: ['a', 'a'] }, { id: 'a' }]);
  assert.deepEqual(r.waves, [['a'], ['b', 'c'], ['d']]);
  assert.deepEqual(r.stats, { waveCount: 3, maxParallel: 2, criticalPath: 3, totalWeight: 4 });
});

test('priority then id (plain string compare)', () => {
  assert.deepEqual(planWaves([{ id: 'x', priority: 1 }, { id: 'a' }, { id: 'b', priority: 5 }]).waves, [['b', 'x', 'a']]);
  assert.deepEqual(planWaves([{ id: 'a' }, { id: 'B' }, { id: '9' }, { id: '10' }]).waves, [['10', '9', 'B', 'a']]);
});

test('file path normalization conflicts', () => {
  const r = planWaves([
    { id: 't1', files: ['src/a.js'] }, { id: 't2', files: ['./src//a.js'] },
    { id: 't3', files: ['src\\b.js'] }, { id: 't4', files: [' ././src/./b.js '] },
  ]);
  assert.deepEqual(r.waves, [['t1', 't3'], ['t2', 't4']]);
});

test('directory claims', () => {
  const r = planWaves([
    { id: 'a', files: ['lib/'] }, { id: 'b', files: ['lib/util/x.js'] }, { id: 'c', files: ['libx/a.js'] },
    { id: 'd', files: ['./lib/./'] }, { id: 'e', files: ['src/a.js'] }, { id: 'f', files: ['src/ab.js'] },
  ]);
  assert.deepEqual(r.waves, [['a', 'c', 'e', 'f'], ['b'], ['d']]);
});

test('directory claimed after file in same wave', () => {
  const r = planWaves([{ id: 'a', files: ['pkg/x/y.js'] }, { id: 'b', files: ['pkg/'] }, { id: 'c', files: ['pkg'] }]);
  // 'pkg' is a plain file: no conflict with pkg/x/y.js, and it is not under the dir claim 'pkg/'.
  assert.deepEqual(r.waves, [['a', 'c'], ['b']]);
});

test('maxWeight and maxPerWave', () => {
  const r = planWaves([{ id: 'p', size: 'M' }, { id: 'q', size: 'M' }, { id: 'r' }, { id: 's', size: 'S' }], { maxWeight: 3 });
  assert.deepEqual(r.waves, [['p', 'r'], ['q', 's']]);
  assert.equal(r.stats.totalWeight, 6);
  const r2 = planWaves(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })), { maxPerWave: 2 });
  assert.deepEqual(r2.waves, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('oversized ticket only goes into an empty wave', () => {
  assert.deepEqual(planWaves([{ id: 'a', size: 'M' }, { id: 'b' }], { maxWeight: 1 }).waves, [['a'], ['b']]);
  assert.deepEqual(planWaves([{ id: 'a', size: 'M' }, { id: 'b', priority: 1 }], { maxWeight: 1 }).waves, [['b'], ['a']]);
});

test('skipped ticket delays its dependents', () => {
  const r = planWaves([{ id: 'a', files: ['f'] }, { id: 'b', files: ['f'] }, { id: 'c', dependsOn: ['b'] }]);
  assert.deepEqual(r.waves, [['a'], ['b'], ['c']]);
  assert.equal(r.stats.criticalPath, 2);
});

test('does not mutate input', () => {
  const input = [{ id: 'b', dependsOn: ['a'], files: ['./x//y'] }, { id: 'a', priority: 2 }];
  const copy = structuredClone(input);
  planWaves(input, { maxPerWave: 1 });
  assert.deepEqual(input, copy);
});

test('5,000 tickets: fast and valid', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const N = 5000;
  const tickets = [];
  for (let i = 0; i < N; i++) {
    const deps = [];
    for (let k = 0; k < 3 && i > 0; k++) if (rnd() < 0.6) deps.push('t' + Math.floor(rnd() * i));
    const files = [];
    const nf = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < nf; k++) files.push(rnd() < 0.05 ? `m${Math.floor(rnd() * 40)}/` : `m${Math.floor(rnd() * 40)}/f${Math.floor(rnd() * 50)}.js`);
    tickets.push({ id: 't' + i, dependsOn: deps, files, size: rnd() < 0.3 ? 'M' : 'S', priority: Math.floor(rnd() * 3) });
  }
  const t0 = performance.now();
  const r = planWaves(tickets, { maxPerWave: 200, maxWeight: 300 });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  const waveOf = new Map();
  r.waves.forEach((w, i) => w.forEach((id) => { assert.ok(!waveOf.has(id), 'placed twice'); waveOf.set(id, i); }));
  assert.equal(waveOf.size, N);
  for (const t of tickets) for (const d of t.dependsOn) assert.ok(waveOf.get(d) < waveOf.get(t.id), 'dep not earlier');
  for (const w of r.waves) assert.ok(w.length <= 200);
  assert.equal(r.stats.waveCount, r.waves.length);
});
