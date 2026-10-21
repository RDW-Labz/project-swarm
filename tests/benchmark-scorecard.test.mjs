// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isoWeek, readBenchmarks, scorecard } from '../tools/benchmark-scorecard.mjs';

const roots = new Set();

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'benchmark-scorecard-'));
  roots.add(root);
  const directory = path.join(root, 'docs', 'state', 'benchmarks');
  await mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

test.after(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
});

function record(at, label, metrics) {
  return { version: 1, at, label, source: 'test', metrics };
}

function metric(value, better, label = 'Metric') {
  return { value, unit: 'count', better, label };
}

test('readBenchmarks reports bad names, JSON, version, and values', async () => {
  const root = await fixture({
    'bad-name.json': '{}',
    '2026-10-01-json.json': '{',
    '2026-10-02-version.json': record('2026-10-02T00:00:00Z', 'weekly', { x: metric(1, 'higher') }),
    '2026-10-03-value.json': record('2026-10-03T00:00:00Z', 'weekly', { x: { value: 'one', unit: 'count', better: 'higher' } }),
  });
  const versionFile = path.join(root, 'docs/state/benchmarks/2026-10-02-version.json');
  await writeFile(versionFile, JSON.stringify({ ...JSON.parse(await (await import('node:fs/promises')).readFile(versionFile, 'utf8')), version: 2 }));

  const result = await readBenchmarks(root);
  assert.equal(result.files.length, 0);
  assert.equal(result.skipped.length, 4);
  assert.match(result.skipped.find((item) => item.file === 'bad-name.json').reason, /name/);
  assert.match(result.skipped.find((item) => item.file === '2026-10-01-json.json').reason, /JSON/);
  assert.match(result.skipped.find((item) => item.file === '2026-10-02-version.json').reason, /version/);
  assert.match(result.skipped.find((item) => item.file === '2026-10-03-value.json').reason, /number/);
});

test('baseline label wins over an earlier non-baseline file', () => {
  const files = [
    { name: 'early', ...record('2026-10-01T00:00:00Z', 'weekly', { x: metric(10, 'higher') }) },
    { name: 'baseline', ...record('2026-10-02T00:00:00Z', 'baseline', { x: metric(20, 'higher') }) },
    { name: 'latest', ...record('2026-10-03T00:00:00Z', 'after', { x: metric(30, 'higher') }) },
  ];
  const result = scorecard(files, { now: '2026-10-03T12:00:00Z', weeks: 1 });
  assert.equal(result.metrics[0].baseline.value, 20);
  assert.equal(result.metrics[0].latest.value, 30);
});

test('better, worse, and flat work for both directions', () => {
  const files = [
    { name: 'baseline', ...record('2026-10-01T00:00:00Z', 'baseline', {
      down: metric(100, 'lower'), up: metric(100, 'higher'), flat: metric(100, 'lower'),
    }) },
    { name: 'latest', ...record('2026-10-02T00:00:00Z', 'after', {
      down: metric(80, 'lower'), up: metric(80, 'higher'), flat: metric(101, 'lower'),
    }) },
  ];
  const result = scorecard(files, { now: '2026-10-02T12:00:00Z', weeks: 1 });
  assert.equal(result.metrics.find((item) => item.key === 'down').verdict, 'better');
  assert.equal(result.metrics.find((item) => item.key === 'up').verdict, 'worse');
  assert.equal(result.metrics.find((item) => item.key === 'flat').verdict, 'flat');
});

test('weekly buckets use ISO weeks across a year boundary', () => {
  assert.equal(isoWeek(new Date('2026-12-31T12:00:00Z')), '2026-W53');
  assert.equal(isoWeek(new Date('2027-01-04T12:00:00Z')), '2027-W01');
  const files = [
    { name: 'old', ...record('2026-12-31T12:00:00Z', 'weekly', { x: metric(1, 'higher') }) },
    { name: 'new', ...record('2027-01-04T12:00:00Z', 'weekly', { x: metric(2, 'higher') }) },
  ];
  const result = scorecard(files, { now: '2027-01-04T12:00:00Z', weeks: 2 });
  assert.deepEqual(result.weeks, ['2026-W53', '2027-W01']);
  assert.deepEqual(result.metrics[0].weekly, [
    { week: '2026-W53', value: 1 },
    { week: '2027-W01', value: 2 },
  ]);
});

test('weeks without data are omitted and later-only metrics use their first file', () => {
  const files = [
    { name: 'first', ...record('2026-10-01T00:00:00Z', 'weekly', { old: metric(1, 'higher') }) },
    { name: 'later', ...record('2026-10-15T00:00:00Z', 'weekly', { later: metric(3, 'higher') }) },
  ];
  const result = scorecard(files, { now: '2026-10-15T12:00:00Z', weeks: 3 });
  const later = result.metrics.find((item) => item.key === 'later');
  assert.equal(later.baseline.value, 3);
  assert.equal(later.latest.value, 3);
  assert.deepEqual(later.weekly, [{ week: '2026-W42', value: 3 }]);
});
