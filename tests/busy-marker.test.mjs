// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeBusyMarker, liveBusyMarkers } from '../tools/busy-marker.mjs';

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
  assert.equal(live[0].command, command);
  assert.equal(live[0].root, root);
  await remove();
});

test('dead pid marker is removed and not returned', async t => {
  const dir = await tempDir(t);
  const root = await tempDir(t);
  const deadPid = 424242;
  await writeBusyMarker({ command: 'node tools/swarm.mjs run x', root, pid: deadPid, dir });
  const live = await liveBusyMarkers({ dir, isAlive: pid => pid === process.pid });
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

test('missing busy directory returns no markers', async t => {
  const dir = path.join(await tempDir(t), 'no-such-busy');
  assert.deepEqual(await liveBusyMarkers({ dir }), []);
});
