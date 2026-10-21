// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { splitQuality } from '../tools/split-quality.mjs';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const recent = '2026-10-19T12:00:00.000Z';
const old = '2026-09-01T12:00:00.000Z';

async function fixture({ tickets = [], events = [], runs = [] } = {}) {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'split-quality-'));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify({ tickets }));
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.log'), events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
  for (const [id, state] of runs) {
    await fs.mkdir(path.join(root, '.swarm', 'runs', id), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm', 'runs', id, 'state.json'), JSON.stringify(state));
  }
  return root;
}

async function withFixture(data, check) {
  const root = await fixture(data);
  try {
    return await check(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const ticket = (id, status = 'done', extra = {}) => ({ id, status, size: 'S', files: [], ...extra });
const transition = (id, from, to, at = recent) => ({ at, event: 'transition', id, from, to });
const run = (id, jobs, extra = {}) => [id, { startedAt: recent, jobs, ...extra }];
const metric = (result, key) => result.metrics.find(item => item.key === key);

test('computes overhead at green, amber, and red boundaries', async () => {
  await withFixture({ runs: [run('r-green', [{ id: 'build-1', type: 'build' }, { id: 'build-2', type: 'build' }, { id: 'build-3', type: 'build' }, { id: 'review-1', type: 'review' }, { id: 'build-4', type: 'build' }])] }, async root => {
    assert.equal(metric(await splitQuality({ root, now: NOW }), 'overhead').value, 0.2);
    assert.equal(metric(await splitQuality({ root, now: NOW }), 'overhead').grade, 'green');
  });
  await withFixture({ runs: [run('r-amber', [{ id: 'build-1' }, { id: 'build-2' }, { id: 'build-3' }, { id: 'review-1', type: 'review' }, { id: 'review-2', type: 'review' }, { id: 'review-3', type: 'review' }, { id: 'build-4' }, { id: 'build-5' }, { id: 'build-6' }, { id: 'build-7' }])] }, async root => {
    assert.equal(metric(await splitQuality({ root, now: NOW }), 'overhead').value, 0.3);
    assert.equal(metric(await splitQuality({ root, now: NOW }), 'overhead').grade, 'amber');
  });
  await withFixture({ runs: [run('r-red', [{ id: 'review-1', type: 'review' }, { id: 'review-2', type: 'review' }, { id: 'review-3', type: 'review' }])] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW }), 'overhead');
    assert.equal(item.value, 1);
    assert.equal(item.grade, 'red');
  });
});

test('grades first-try pass rate at all boundaries', async () => {
  const tickets = Array.from({ length: 5 }, (_, i) => ticket(`T-${i + 1}`));
  await withFixture({ tickets, events: [transition('T-5', 'todo', 'done')] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW }), 'firstTry');
    assert.equal(item.value, 1);
    assert.equal(item.grade, 'green');
  });
  await withFixture({ tickets: Array.from({ length: 5 }, (_, i) => ticket(`T-${i + 1}`)), events: [transition('T-1', 'todo', 'blocked'), transition('T-2', 'running', 'todo')] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW }), 'firstTry');
    assert.equal(item.value, 0.6);
    assert.equal(item.grade, 'amber');
  });
  await withFixture({ tickets: Array.from({ length: 5 }, (_, i) => ticket(`T-${i + 1}`)), events: [transition('T-1', 'todo', 'blocked'), transition('T-2', 'todo', 'blocked'), transition('T-3', 'todo', 'blocked')] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW }), 'firstTry');
    assert.equal(item.value, 0.4);
    assert.equal(item.grade, 'red');
  });
});

test('computes critical path and survives dependency cycles', async () => {
  for (const [chain, expectedGrade] of [[1, 'green'], [2, 'amber'], [3, 'red']]) {
    const tickets = Array.from({ length: 10 }, (_, i) => ticket(`T-${i + 1}`, 'todo', i < chain - 1 ? { dependsOn: [`T-${i + 2}`] } : {}));
    await withFixture({ tickets }, async root => assert.equal(metric(await splitQuality({ root, now: NOW }), 'criticalPath').grade, expectedGrade));
  }
  await withFixture({ tickets: [ticket('T-1', 'todo'), ticket('T-2', 'todo', { dependsOn: ['T-1'] }), ticket('T-3', 'todo'), ticket('T-4', 'cancelled')] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW }), 'criticalPath');
    assert.equal(item.value, 2 / 3);
    assert.equal(item.display, '2 of 3 (67%)');
    assert.equal(item.grade, 'red');
  });
  await withFixture({ tickets: [ticket('T-1', 'todo', { dependsOn: ['T-2'] }), ticket('T-2', 'todo', { dependsOn: ['T-1'] })] }, async root => {
    const result = await Promise.race([
      splitQuality({ root, now: NOW }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cycle traversal hung')), 250)),
    ]);
    assert.equal(metric(result, 'criticalPath').grade, 'red');
  });
});

test('computes wave fill with explicit slots and boundary grades', async () => {
  await withFixture({ runs: [run('r-one', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), run('r-two', [{ id: 'd' }, { id: 'e' }, { id: 'f' }])] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW, slots: 4 }), 'waveFill');
    assert.equal(item.value, 0.75);
    assert.equal(item.grade, 'green');
  });
  await withFixture({ runs: [run('r-one', [{ id: 'a' }, { id: 'b' }])] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW, slots: 4 }), 'waveFill');
    assert.equal(item.value, 0.5);
    assert.equal(item.grade, 'amber');
  });
  await withFixture({ runs: [run('r-one', [{ id: 'a' }])] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW, slots: 4 }), 'waveFill');
    assert.equal(item.value, 0.25);
    assert.equal(item.grade, 'red');
  });
});

test('counts conflicts once per run plus conflicting jobs', async () => {
  await withFixture({ runs: [run('r-green', [{ id: 'a', status: 'complete' }])] }, async root => assert.equal(metric(await splitQuality({ root, now: NOW }), 'collisions').grade, 'green'));
  await withFixture({ runs: [run('r-one', [{ id: 'a', status: 'complete' }]), run('r-two', [{ id: 'b', status: 'failed', error: 'merge conflict' }], { integration: { conflicts: ['x', 'y'] } })] }, async root => {
    const item = metric(await splitQuality({ root, now: NOW }), 'collisions');
    assert.equal(item.value, 2);
    assert.equal(item.grade, 'amber');
  });
  await withFixture({ runs: [run('r-one', [{ id: 'a', status: 'conflict' }]), run('r-two', [{ id: 'b', error: 'conflict' }]), run('r-three', [], { conflicts: ['x'] })] }, async root => assert.equal(metric(await splitQuality({ root, now: NOW }), 'collisions').grade, 'red'));
});

test('computes review cost per ticket and size share', async () => {
  await withFixture({
    tickets: [ticket('T-1'), ticket('T-2'), ticket('T-3', 'todo', { size: 'M' }), ticket('T-4', 'todo', { files: ['1', '2', '3', '4', '5', '6', '7'] })],
    events: [transition('T-1', 'review', 'done'), transition('T-2', 'review', 'done')],
    runs: [run('r-one', [{ id: 'T-1-review', type: 'review', costUsd: 0.5 }, { id: 'T-2-review', type: 'review', costUsd: 0.5 }])],
  }, async root => {
    const result = await splitQuality({ root, now: NOW });
    const cost = metric(result, 'reviewCost');
    assert.equal(cost.value, 0.5);
    assert.equal(cost.display, '$0.50');
    assert.equal(cost.grade, 'amber');
    const sizes = metric(result, 'sizes');
    assert.equal(sizes.value, 0.5);
    assert.equal(sizes.display, '2 S · 2 M (50% M)');
    assert.equal(sizes.grade, 'amber');
  });
  for (const [costUsd, expectedGrade] of [[0.25, 'green'], [0.75, 'amber'], [0.76, 'red']]) {
    await withFixture({ events: [transition('T-1', 'review', 'done')], runs: [run(`review-${costUsd}`, [{ id: 'T-1-review', type: 'review', costUsd }])] }, async root => assert.equal(metric(await splitQuality({ root, now: NOW }), 'reviewCost').grade, expectedGrade));
  }
  for (const [mCount, expectedGrade] of [[3, 'green'], [5, 'amber'], [6, 'red']]) {
    const tickets = Array.from({ length: 10 }, (_, i) => ticket(`S-${i + 1}`, 'todo', i < mCount ? { size: 'M' } : {}));
    await withFixture({ tickets }, async root => assert.equal(metric(await splitQuality({ root, now: NOW }), 'sizes').grade, expectedGrade));
  }
});

test('ignores old runs, preserves fixed metric order, and returns unknown for empty projects', async () => {
  await withFixture({ runs: [run('old-run', [{ id: 'review-old', type: 'review' }], { startedAt: old })] }, async root => {
    const result = await splitQuality({ root, now: NOW });
    assert.deepEqual(result.metrics.map(item => item.key), ['overhead', 'firstTry', 'criticalPath', 'waveFill', 'collisions', 'reviewCost', 'sizes']);
    assert.equal(result.metrics.every(item => item.grade === 'unknown'), true);
    assert.equal(result.grade, 'unknown');
    assert.ok(result.metrics.every(item => item.note));
  });
});

test('overall grade is the worst known grade', async () => {
  await withFixture({ tickets: [ticket('T-1', 'todo'), ticket('T-2', 'todo')], runs: [run('r-one', [{ id: 'a' }, { id: 'b' }])] }, async root => {
    const result = await splitQuality({ root, now: NOW, slots: 4 });
    assert.equal(metric(result, 'waveFill').grade, 'amber');
    assert.equal(metric(result, 'collisions').grade, 'green');
    assert.equal(result.grade, 'red');
  });
});
