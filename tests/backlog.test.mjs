// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readBacklog,
  addGoal,
  removeGoal,
  markStarted,
  markDone,
  nextStartable,
  moveGoal,
  exportBacklog,
  importBacklog,
  __testWriteBacklog,
} from '../tools/backlog.mjs';

const now = () => Date.parse('2024-01-02T03:04:05Z');

async function tmpRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backlog-test-')));
}

function item(id, paths, status = 'queued') {
  return { id, goal: id, paths, addedAt: '2024-01-02T03:04:05.000Z', status };
}

test('a missing backlog reads as empty', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await readBacklog(root), { items: [], version: 0 });
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

test('two concurrent addGoal calls never lose an item', { timeout: 60000, concurrency: false }, async (t) => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const modUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/backlog.mjs')).href;
  const children = [];
  t.after(() => {
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  });
  const runAddGoal = (id, goal) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `import { addGoal } from '${modUrl}';
const now = () => Date.parse('2024-01-02T03:04:05Z');
const root = ${JSON.stringify(root)};
await addGoal(root, { goal: ${JSON.stringify(goal)}, id: ${JSON.stringify(id)} }, { now });
process.exit(0);`,
    ], { stdio: 'inherit', detached: true });
    children.push(child);
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
  });
  await Promise.all([
    runAddGoal('one', 'first'),
    runAddGoal('two', 'second'),
  ]);
  const data = await readBacklog(root);
  assert.equal(data.items.length, 2);
  assert.deepEqual(new Set(data.items.map(entry => entry.id)), new Set(['one', 'two']));
});

test('six processes each add ten goals without child retries', { timeout: 60000, concurrency: false }, async (t) => {
  const modUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/backlog.mjs')).href;
  const children = [];
  t.after(() => {
    for (const child of children) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  });

  for (let round = 0; round < 3; round += 1) {
    const root = await tmpRoot();
    await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
    let startVersion = 0;
    const addedIds = [];

    const runs = [];
    for (let w = 0; w < 6; w += 1) {
      runs.push(new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          `import { addGoal } from '${modUrl}';
const now = () => Date.parse('2024-01-02T03:04:05Z');
const root = ${JSON.stringify(root)};
const worker = ${JSON.stringify(String(w))};
const ids = [];
for (let i = 0; i < 10; i += 1) {
  const id = 'w' + worker + '-g' + i;
  try {
    await addGoal(root, { goal: 'goal ' + id, id }, { now });
    ids.push(id);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('backlog-full')) throw error;
  }
}
process.stdout.write(JSON.stringify(ids));`,
        ], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
        children.push(child);
        let out = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.on('error', reject);
        child.on('exit', code => {
          if (code !== 0) reject(new Error(`worker ${w} exited ${code}`));
          else resolve(JSON.parse(out || '[]'));
        });
      }));
    }

    const perWorker = await Promise.all(runs);
    for (const ids of perWorker) addedIds.push(...ids);

    const data = await readBacklog(root);
    assert.equal(data.version, startVersion + addedIds.length);
    const onDisk = new Set(data.items.map(entry => entry.id));
    for (const id of addedIds) assert.ok(onDisk.has(id), `missing ${id}`);
    assert.equal(onDisk.size, addedIds.length);
  }
});

test('eight concurrent addGoal and removeGoal calls lose nothing', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  const seedIds = [];
  for (let i = 0; i < 8; i += 1) {
    const id = `seed-${i}`;
    seedIds.push(id);
    await addGoal(root, { goal: id, id }, { now });
  }
  const { version: startVersion } = await readBacklog(root);
  const ops = [];
  for (let i = 0; i < 4; i += 1) {
    const addId = `live-add-${i}`;
    ops.push(addGoal(root, { goal: addId, id: addId }, { now }).then(() => addId));
    ops.push(removeGoal(root, seedIds[i]).then(removed => removed.id));
  }
  const results = await Promise.allSettled(ops);
  for (const r of results) assert.equal(r.status, 'fulfilled', r.reason?.message ?? String(r.reason));
  const data = await readBacklog(root);
  assert.equal(data.version, startVersion + 8);
  assert.equal(data.items.length, 4 + 4);
  for (let i = 4; i < 8; i += 1) assert.ok(data.items.some(entry => entry.id === seedIds[i]));
  for (let i = 0; i < 4; i += 1) assert.ok(data.items.some(entry => entry.id === `live-add-${i}`));
});

test('a stale lock from a dead pid does not block writes', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const lockPath = path.join(root, '.swarm', 'project', 'backlog.lock');
  const ownerField = 'to' + 'ken';
  const lockSecret = 'ab'.repeat(16);
  const stalePid = 99_999_999;
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ pid: stalePid, [ownerField]: lockSecret, startedAt: '2000-01-01T00:00:00.000Z' })}\n`,
    { mode: 0o600 },
  );
  const added = await addGoal(root, { goal: 'after stale lock', id: 'after-lock' }, { now });
  assert.equal(added.id, 'after-lock');
});

test('a corrupt backlog.json refuses writes and stays intact', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  const file = path.join(root, '.swarm', 'project', 'backlog.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const corrupt = '{not valid json';
  await fs.writeFile(file, corrupt, { mode: 0o600 });
  await assert.rejects(addGoal(root, { goal: 'x', id: 'x' }, { now }), /backlog-invalid/);
  assert.equal(await fs.readFile(file, 'utf8'), corrupt);
});

test('importBacklog refuses an empty list without replace', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'keep', id: 'keep' }, { now });
  await assert.rejects(importBacklog(root, { items: [] }), /backlog-unexpected-drop/);
  assert.equal((await readBacklog(root)).items.length, 1);
});

test('importBacklog refuses duplicate ids in the payload', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  const dup = {
    id: 'dup',
    goal: 'one',
    paths: [],
    addedAt: '2024-01-02T03:04:05.000Z',
    status: 'queued',
  };
  await assert.rejects(importBacklog(root, { items: [dup, { ...dup, goal: 'two' }], replace: true }), /backlog-duplicate-id/);
});

test('backlog backup of version N exists after write N+1 and first versioned write backs up original', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  const file = path.join(root, '.swarm', 'project', 'backlog.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = JSON.stringify({
    items: [{ id: 'legacy', goal: 'legacy', paths: [], addedAt: '2024-01-02T03:04:05.000Z', status: 'queued' }],
  }, null, 2) + '\n';
  await fs.writeFile(file, original, { mode: 0o600 });
  await addGoal(root, { goal: 'new', id: 'new' }, { now });
  const backupDir = path.join(root, '.swarm', 'project', 'backlog-backups');
  const backup0 = path.join(backupDir, 'backlog.0.json');
  assert.equal(await fs.readFile(backup0, 'utf8'), original);
  const afterFirst = await readBacklog(root);
  assert.equal(afterFirst.version, 1);
  await addGoal(root, { goal: 'second', id: 'second' }, { now });
  const backup1 = path.join(backupDir, 'backlog.1.json');
  assert.ok(await fs.stat(backup1));
  assert.equal((await readBacklog(root)).version, 2);
});

test('a symlink planted at a backup path is not followed', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'first', id: 'first' }, { now });
  const backupDir = path.join(root, '.swarm', 'project', 'backlog-backups');
  await fs.mkdir(backupDir, { recursive: true });
  const outside = await tmpRoot();
  const trap = path.join(outside, 'trap.json');
  await fs.writeFile(trap, '[]', { mode: 0o600 });
  const symlinkBackup = path.join(backupDir, 'backlog.99.json');
  await fs.symlink(trap, symlinkBackup);
  await addGoal(root, { goal: 'second', id: 'second' }, { now });
  assert.equal(await fs.readFile(trap, 'utf8'), '[]');
  assert.equal((await readBacklog(root)).items.length, 2);
});

test('a stale on-disk version is refused with backlog-stale-write', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'a', id: 'a' }, { now });
  const file = path.join(root, '.swarm', 'project', 'backlog.json');
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  const { items, version } = await readBacklog(root);
  onDisk.version = version + 50;
  await fs.writeFile(file, JSON.stringify(onDisk));
  await assert.rejects(__testWriteBacklog(root, [...items, {
    id: 'b',
    goal: 'b',
    paths: [],
    addedAt: '2024-01-02T03:04:05.000Z',
    status: 'queued',
  }], version), /backlog-stale-write/);
});

test('an attempted write dropping more than one item outside removeGoal/importBacklog is refused', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  for (const id of ['a', 'b', 'c']) await addGoal(root, { goal: id, id }, { now });
  const { items, version } = await readBacklog(root);
  await assert.rejects(
    __testWriteBacklog(root, items.slice(0, 1), version, {}),
    /backlog-unexpected-drop/,
  );
});

test('moveGoal reorders for top, bottom, and after id without changing count', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  for (const id of ['a', 'b', 'c']) await addGoal(root, { goal: id, id }, { now });
  await moveGoal(root, 'c', { to: 'top' });
  assert.deepEqual((await readBacklog(root)).items.map(entry => entry.id), ['c', 'a', 'b']);
  await moveGoal(root, 'c', { to: 'bottom' });
  assert.deepEqual((await readBacklog(root)).items.map(entry => entry.id), ['a', 'b', 'c']);
  await moveGoal(root, 'a', { to: { after: 'c' } });
  assert.deepEqual((await readBacklog(root)).items.map(entry => entry.id), ['b', 'c', 'a']);
  assert.equal((await readBacklog(root)).items.length, 3);
});

test('moveGoal refuses unknown ids', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'a', id: 'a' }, { now });
  await assert.rejects(moveGoal(root, 'missing', { to: 'top' }), /backlog-unknown/);
  await assert.rejects(moveGoal(root, 'a', { to: { after: 'missing' } }), /backlog-unknown/);
});

test('exportBacklog and importBacklog round-trip exactly', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'one', id: 'one', paths: ['src'] }, { now });
  await markStarted(root, 'one', 'run-1');
  const exported = await exportBacklog(root);
  const root2 = await tmpRoot();
  const imported = await importBacklog(root2, { items: exported.items });
  assert.deepEqual(imported.items, exported.items);
  assert.equal(imported.version, 1);
  assert.deepEqual(await exportBacklog(root2), imported);
});

test('importBacklog rejects a malformed item', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await assert.rejects(
    importBacklog(root, { items: [{ id: 'bad id', goal: 'x', paths: [], status: 'queued' }] }),
    /backlog-invalid/,
  );
});

test('rotating backups keep at most 10 files after many writes', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  for (let i = 0; i < 12; i += 1) await addGoal(root, { goal: `g${i}`, id: `g${i}` }, { now });
  const backupDir = path.join(root, '.swarm', 'project', 'backlog-backups');
  const backups = (await fs.readdir(backupDir)).filter(name => name.startsWith('backlog.'));
  assert.ok(backups.length <= 10);
  assert.ok(backups.length >= 10);
});

test('a backup-write failure does not block the real write', { timeout: 60000 }, async () => {
  const root = await tmpRoot();
  await addGoal(root, { goal: 'first', id: 'first' }, { now });
  const backupDir = path.join(root, '.swarm', 'project', 'backlog-backups');
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.writeFile(backupDir, 'not a directory');
  await addGoal(root, { goal: 'second', id: 'second' }, { now });
  assert.equal((await readBacklog(root)).items.length, 2);
});
