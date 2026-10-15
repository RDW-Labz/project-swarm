// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBacklog, addGoal, removeGoal, markStarted, markDone, nextStartable } from '../tools/backlog.mjs';

const now = () => Date.parse('2024-01-02T03:04:05Z');

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'backlog-test-'));
}

function item(id, paths, status = 'queued') {
  return { id, goal: id, paths, addedAt: '2024-01-02T03:04:05.000Z', status };
}

test('a missing backlog reads as empty', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await readBacklog(root), { items: [] });
});

test('addGoal stores a queued item with normalized paths and an ISO timestamp', async () => {
  const root = await tmpRoot();
  const added = await addGoal(root, { goal: 'Add search', paths: ['src//app/', './docs'], id: 'search' }, { now });
  assert.equal(added.status, 'queued');
  assert.deepEqual(added.paths, ['src/app', 'docs']);
  assert.equal(added.addedAt, '2024-01-02T03:04:05.000Z');
  const data = await readBacklog(root);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 'search');
});

test('goal length is limited to 1-2000 characters', async () => {
  const root = await tmpRoot();
  await assert.rejects(addGoal(root, { goal: '   ' }, { now }), /backlog-goal-invalid/);
  await assert.rejects(addGoal(root, { goal: 'word '.repeat(400) + 'x' }, { now }), /backlog-goal-invalid/);
  const ok = await addGoal(root, { goal: 'word '.repeat(400), id: 'long' }, { now });
  assert.ok([...ok.goal].length <= 2000);
});

test('at most 50 items are stored', async () => {
  const root = await tmpRoot();
  for (let i = 0; i < 50; i += 1) await addGoal(root, { goal: `goal ${i}`, id: `g${i}` }, { now });
  await assert.rejects(addGoal(root, { goal: 'one more', id: 'g50' }, { now }), /backlog-full/);
  assert.equal((await readBacklog(root)).items.length, 50);
});

test('invalid maxUsd and ids are refused', async () => {
  const root = await tmpRoot();
  await assert.rejects(addGoal(root, { goal: 'x', maxUsd: -1 }, { now }), /backlog-max-usd-invalid/);
  await assert.rejects(addGoal(root, { goal: 'x', id: 'bad id!' }, { now }), /backlog-id-invalid/);
  const kept = await addGoal(root, { goal: 'x', maxUsd: 2.5, id: 'ok' }, { now });
  assert.equal(kept.maxUsd, 2.5);
});

test('paths outside the project or absolute are refused', async () => {
  const root = await tmpRoot();
  for (const bad of ['../x', 'a/../b', '/abs', 'a\\b', '', '.']) {
    await assert.rejects(addGoal(root, { goal: 'g', paths: [bad] }, { now }), /backlog-path-invalid/);
  }
});

test('duplicate ids are refused', async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'one', id: 'same' }, { now });
  await assert.rejects(addGoal(root, { goal: 'two', id: 'same' }, { now }), /backlog-duplicate-id/);
});

test('goals are sanitized before they are stored', async () => {
  const root = await tmpRoot();
  const added = await addGoal(root, { goal: 'deploy with TOKEN=abc123secret now' + String.fromCharCode(7) }, { now });
  assert.ok(!added.goal.includes('abc123secret'));
  assert.ok(!added.goal.includes(String.fromCharCode(7)));
  const text = await fs.readFile(path.join(root, '.swarm', 'project', 'backlog.json'), 'utf8');
  assert.ok(!text.includes('abc123secret'));
});

test('a symlinked .swarm is refused for reads and writes', async () => {
  const root = await tmpRoot();
  const outside = await tmpRoot();
  await fs.symlink(outside, path.join(root, '.swarm'));
  await assert.rejects(readBacklog(root), /backlog-path-unsafe/);
  await assert.rejects(addGoal(root, { goal: 'x' }, { now }), /path-unsafe/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a symlinked .swarm/project is refused', async () => {
  const root = await tmpRoot();
  const outside = await tmpRoot();
  await fs.mkdir(path.join(root, '.swarm'));
  await fs.symlink(outside, path.join(root, '.swarm', 'project'));
  await assert.rejects(readBacklog(root), /backlog-path-unsafe/);
  await assert.rejects(addGoal(root, { goal: 'x' }, { now }), /path-unsafe/);
});

test('overlap: equal paths block the item', async () => {
  assert.equal(nextStartable([item('a', ['src/app'])], { activeClaims: ['src/app'] }), null);
});

test('overlap: an item inside a claim blocks, and a claim inside an item blocks', async () => {
  assert.equal(nextStartable([item('a', ['src/app/index.js'])], { activeClaims: ['src/app'] }), null);
  assert.equal(nextStartable([item('a', ['src'])], { activeClaims: ['src/app/x.js'] }), null);
});

test('overlap: sibling names that only share a prefix do not block', async () => {
  const found = nextStartable([item('a', ['src/apple'])], { activeClaims: ['src/app'] });
  assert.equal(found.id, 'a');
});

test('a no-paths item starts only when nothing is waiting', async () => {
  assert.equal(nextStartable([item('a', [])], { activeClaims: [] }).id, 'a');
  assert.equal(nextStartable([item('a', [])], { activeClaims: ['x'] }), null);
  assert.equal(nextStartable([item('a', [])]).id, 'a');
});

test('nextStartable returns the first queued item that does not overlap and skips started ones', async () => {
  const items = [
    item('s', ['docs'], 'started'),
    item('b', ['src']),
    item('c', ['docs']),
  ];
  assert.equal(nextStartable(items, { activeClaims: ['src/x'] }).id, 'c');
  assert.equal(nextStartable(items, { activeClaims: ['src', 'docs'] }), null);
});

test('remove deletes an item and unknown ids are refused', async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'one', id: 'one' }, { now });
  await addGoal(root, { goal: 'two', id: 'two' }, { now });
  const removed = await removeGoal(root, 'one');
  assert.equal(removed.id, 'one');
  assert.deepEqual((await readBacklog(root)).items.map(entry => entry.id), ['two']);
  await assert.rejects(removeGoal(root, 'nope'), /backlog-unknown/);
});

test('status changes: queued to started to done, with no repeats', async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'work', id: 'w' }, { now });
  const started = await markStarted(root, 'w', 'run-1');
  assert.equal(started.status, 'started');
  assert.equal(started.run, 'run-1');
  await assert.rejects(markStarted(root, 'w', 'run-2'), /backlog-not-queued/);
  const done = await markDone(root, 'w');
  assert.equal(done.status, 'done');
  await assert.rejects(markDone(root, 'w'), /backlog-not-started/);
  await assert.rejects(markDone(root, 'missing'), /backlog-unknown/);
});

test('a malformed backlog file is refused', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'backlog.json'), 'not json');
  await assert.rejects(readBacklog(root), /backlog-invalid/);
  await fs.writeFile(path.join(root, '.swarm', 'project', 'backlog.json'), JSON.stringify({ items: 'nope' }));
  await assert.rejects(readBacklog(root), /backlog-invalid/);
});
