// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { writeBusyMarker, liveBusyMarkers } from '../tools/busy-marker.mjs';

function spawnExitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', () => resolve(child.pid));
  });
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-busy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}

test('writeBusyMarker for current pid is listed by liveBusyMarkers', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const command = 'node tools/swarm.mjs go --scope x';
  const remove = await writeBusyMarker({ command, root, dir });
  const live = await liveBusyMarkers({ dir });
  assert.equal(live.length, 1);
  assert.equal(live[0].pid, process.pid);
  assert.equal(live[0].command, 'swarm go');
  assert.equal(live[0].root, root);
  await remove();
});

test('dead pid marker is removed and not returned', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const deadPid = await spawnExitedPid();
  await writeBusyMarker({ command: 'node tools/swarm.mjs run x', root, pid: deadPid, dir });
  const live = await liveBusyMarkers({ dir });
  assert.deepEqual(live, []);
  await assert.rejects(fs.access(path.join(dir, `${deadPid}.json`)));
});

test('remove deletes the marker and is safe to call twice', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const remove = await writeBusyMarker({ command: 'node tools/swarm.mjs ship', root, dir });
  await remove();
  await assert.rejects(fs.access(path.join(dir, `${process.pid}.json`)));
  await remove();
});

test('writeBusyMarker strips secrets from command and stores swarm verb only', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const remove = await writeBusyMarker({ command: 'ship --token abc123secret', root, dir });
  const live = await liveBusyMarkers({ dir });
  assert.equal(live.length, 1);
  assert.equal(live[0].command, 'swarm ship');
  await remove();
});

test('liveBusyMarkers removes markers with pid 0 or negative and does not return them', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  for (const badPid of [0, -5]) {
    await writeBusyMarker({ command: 'node tools/swarm.mjs go', root, pid: badPid, dir });
    await fs.access(path.join(dir, `${badPid}.json`));
  }
  assert.deepEqual(await liveBusyMarkers({ dir }), []);
  for (const badPid of [0, -5]) {
    await assert.rejects(fs.access(path.join(dir, `${badPid}.json`)));
  }
});

test('missing busy directory returns no markers', async t => {
  const dir = path.join(await tempDir(t), 'no-such-busy');
  assert.deepEqual(await liveBusyMarkers({ dir }), []);
});

test('matching procStart keeps marker alive', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const start = 'Mon Oct 20 10:00:00 2025';
  const procStart = () => start;
  const remove = await writeBusyMarker({
    command: 'node tools/swarm.mjs go',
    root,
    dir,
    procStart,
  });
  const live = await liveBusyMarkers({ dir, procStart });
  assert.equal(live.length, 1);
  assert.equal(live[0].pid, process.pid);
  await remove();
});

test('same pid with different procStart is dead and file is deleted', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const remove = await writeBusyMarker({
    command: 'node tools/swarm.mjs go',
    root,
    dir,
    procStart: () => 'Mon Oct 20 10:00:00 2025',
  });
  const live = await liveBusyMarkers({
    dir,
    procStart: () => 'Mon Oct 20 11:00:00 2025',
  });
  assert.deepEqual(live, []);
  await assert.rejects(fs.access(path.join(dir, `${process.pid}.json`)));
  await remove();
});

test('marker without procStart is alive when pid is alive', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const target = path.join(dir, `${process.pid}.json`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    target,
    `${JSON.stringify({ pid: process.pid, command: 'swarm go', root, startedAt: new Date().toISOString() })}\n`,
  );
  const live = await liveBusyMarkers({
    dir,
    procStart: () => 'Mon Oct 20 11:00:00 2025',
  });
  assert.equal(live.length, 1);
  await fs.unlink(target);
});

test('unreadable current procStart keeps marker alive', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const remove = await writeBusyMarker({
    command: 'node tools/swarm.mjs go',
    root,
    dir,
    procStart: () => 'Mon Oct 20 10:00:00 2025',
  });
  const live = await liveBusyMarkers({ dir, procStart: () => null });
  assert.equal(live.length, 1);
  await remove();
});

test('writeBusyMarker stores injected procStart in the marker file', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const start = 'Tue Oct 20 12:00:00 2025';
  const remove = await writeBusyMarker({
    command: 'node tools/swarm.mjs go',
    root,
    dir,
    procStart: () => start,
  });
  const raw = JSON.parse(await fs.readFile(path.join(dir, `${process.pid}.json`), 'utf8'));
  assert.equal(raw.procStart, start);
  await remove();
});
