// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectStatus, formatStatus } from '../tools/status.mjs';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRun(root, id, state) {
  const directory = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
}

function options(root, overrides = {}) {
  return { env: { HOME: root }, doctorAll: async () => ({ providers: [] }), ...overrides };
}

function commands(status, first) {
  assert.equal(status.next[0], first);
  assert.equal(status.next.length, 5);
  assert.equal(new Set(status.next).size, 5);
}

test('uninitialized and initialized projects without runs', async t => {
  const root = await project(t);
  let status = await projectStatus(root, options(root));
  assert.deepEqual(Object.keys(status).sort(), ['root', 'initialized', 'lastRun', 'lanes', 'spendToday', 'next'].sort());
  assert.equal(status.root, root);
  assert.equal(status.initialized, false);
  assert.equal(status.lastRun, null);
  assert.deepEqual(status.spendToday, { usd: null, byLane: {} });
  commands(status, 'swarm init');
  assert.match(formatStatus(status), /Initialized: no; run: swarm init/);
  await fs.writeFile(path.join(root, '.project-swarm.json'), '{}');
  status = await projectStatus(root, options(root));
  assert.equal(status.initialized, true);
  commands(status, 'swarm "describe your goal in one sentence"');
});

test('run states choose useful commands and preserve summary', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, '.project-swarm.json'), '{}');
  for (const [status, command] of [
    ['failed', 'swarm inspect run-one'],
    ['cancelled', 'swarm inspect run-one'],
    ['running', 'swarm monitor run-one --watch'],
    ['complete', 'swarm rollup run-one --text'],
  ]) {
    const state = { id: 'run-one', status, startedAt: '2026-10-14T10:00:00Z', finishedAt: null, summary: { counts: { complete: 2, failed: 1 }, costUsd: 1.25 }, jobs: [{ costUsd: 99 }] };
    await writeRun(root, 'run-one', state);
    const result = await projectStatus(root, options(root));
    commands(result, command);
    assert.deepEqual(result.lastRun, { id: state.id, status, startedAt: state.startedAt, finishedAt: null, counts: state.summary.counts, costUsd: 1.25 });
  }
});

test('newest startedAt wins, corrupt runs are skipped, and job costs are summed', async t => {
  const root = await project(t);
  await writeRun(root, 'z-old', { status: 'failed', startedAt: '2026-10-13T10:00:00Z' });
  await writeRun(root, 'a-new', { status: 'complete', startedAt: '2026-10-14T10:00:00Z', jobs: { a: { costUsd: 0.25 }, b: { costUsd: 0.5 }, c: { costUsd: '9' }, d: {} } });
  await writeRun(root, 'zz-corrupt', '{broken');
  const result = await projectStatus(root, options(root));
  assert.equal(result.lastRun.id, 'a-new');
  assert.equal(result.lastRun.costUsd, 0.75);
  assert.equal(result.lastRun.counts, null);
});

test('directory names order runs when startedAt is absent', async t => {
  const root = await project(t);
  await writeRun(root, 'run-001', { status: 'complete' });
  await writeRun(root, 'run-002', { status: 'running' });
  const result = await projectStatus(root, options(root));
  assert.equal(result.lastRun.id, 'run-002');
  assert.equal(result.lastRun.costUsd, null);
});

test('lanes classify all healthy statuses and preserve spend', async t => {
  const root = await project(t);
  const spend = { usd: 2.5, byLane: { alpha: 2.5 } };
  const status = await projectStatus(root, options(root, {
    doctorAll: async () => ({ providers: [
      { agent: 'alpha', status: 'compatible' }, { agent: 'beta', status: 'configured' },
      { agent: 'gamma', status: 'reachable' }, { agent: 'delta', status: 'missing' },
    ] }),
    spendToday: async () => spend,
  }));
  assert.deepEqual(status.lanes, { up: ['alpha', 'beta', 'gamma'], down: ['delta'] });
  assert.deepEqual(status.spendToday, spend);
});

test('doctor and spend failures leave usable status', async t => {
  const root = await project(t);
  const status = await projectStatus(root, options(root, {
    doctorAll: async () => { throw new Error('offline'); },
    spendToday: async () => { throw new Error('no ledger'); },
  }));
  assert.deepEqual(status.lanes, { up: [], down: [], error: 'offline' });
  assert.deepEqual(status.spendToday, { usd: null, byLane: {} });
});

test('format is short plain text with commands, counts, cost and relative ages', async t => {
  const root = await project(t);
  const startedAt = Date.parse('2026-10-14T10:00:00Z');
  await writeRun(root, 'latest', { status: 'complete', startedAt, summary: { counts: { complete: 2 }, costUsd: 0.5 } });
  const status = await projectStatus(root, options(root));
  for (const [elapsed, label] of [[120_000, '2m ago'], [7_200_000, '2h ago'], [172_800_000, '2d ago']]) {
    const text = formatStatus(status, { now: () => startedAt + elapsed });
    assert.ok(text.split('\n').length <= 14);
    assert.ok(text.startsWith(`Project Swarm status for ${root}\n`));
    assert.ok(text.includes(label));
    assert.match(text, /counts: complete: 2; cost: \$0\.50/);
    assert.match(text, /Today's spend: unknown/);
    assert.match(text, /Lanes up: none\nLanes down: none/);
    assert.ok(!text.includes('\u001b'));
    for (const command of status.next) assert.ok(text.includes(`  ${command}`));
  }
  status.spendToday.usd = 0;
  assert.match(formatStatus(status), /Today's spend: \$0\.00/);
});
