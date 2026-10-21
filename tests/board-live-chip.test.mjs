// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWatchServer, createWatchStreamManager, MAX_STREAM_BUFFER_BYTES } from '../tools/watch-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = path.join(root, 'tools', 'watch-assets');
const deltaFile = path.join(root, 'tools', 'watch-delta.mjs');

async function boardLib() {
  const box = { self: {} };
  const source = await fs.readFile(path.join(assets, 'board-lib.js'), 'utf8');
  vm.runInNewContext(source, box);
  return box.self.BoardLib;
}

test('chipState stays live through one missed poll, connects after two, and never flickers inside the grace window', async () => {
  const L = await boardLib();
  const pollMs = 1000;
  assert.equal(L.chipState({ lastOkAt: 0, now: 1000, pollMs, everOk: false }).state, 'connecting');
  assert.equal(L.chipState({ lastOkAt: 1000, now: 2500, pollMs, everOk: true }).state, 'live', 'a slow answer after one missed poll stays live');
  assert.equal(L.chipState({ lastOkAt: 1000, now: 3000, pollMs, everOk: true }).state, 'live', 'the second poll interval is still live');
  assert.equal(L.chipState({ lastOkAt: 1000, now: 3001, pollMs, everOk: true }).state, 'connecting', 'two missed polls connect');
  assert.equal(L.chipState({ lastOkAt: 1000, now: 3001, pollMs, everOk: true }).ageS, 2);
  assert.equal(L.chipState({ lastOkAt: 1000, now: 3001, pollMs, slackMs: 500, everOk: true }).state, 'live', 'slack keeps an in-flight answer live');
});

test('project-live leaves the shared live chip to project.js', async () => {
  const source = await fs.readFile(path.join(assets, 'project-live.js'), 'utf8');
  assert.doesNotMatch(source, /liveText|liveDot/);
  assert.match(await fs.readFile(path.join(assets, 'project.js'), 'utf8'), /chipState/);
});

test('streamState waits for two missed heartbeats before connecting', async () => {
  const L = await boardLib();
  assert.equal(L.streamState({ lastMessageAt: 1000, now: 20999, heartbeatMs: 10000 }).state, 'live');
  assert.equal(L.streamState({ lastMessageAt: 1000, now: 21001, heartbeatMs: 10000 }).state, 'connecting');
  assert.equal(L.streamState({ lastMessageAt: 0, now: 1000, heartbeatMs: 10000 }).state, 'connecting');
});

test('back-pressure pauses deltas, drains with one fresh snapshot, and bounds stuck streams', async () => {
  let now = 1000;
  let latest = { schema: 1, runId: 'r1', status: 'live' };
  const res = new EventEmitter();
  res.writableLength = 0;
  res.writes = [];
  res.results = [true, false, false, true];
  res.write = function write(chunk) {
    this.writes.push(String(chunk));
    return this.results.shift() ?? true;
  };
  res.end = function end() {
    this.ended = true;
    this.emit('close');
  };
  const manager = createWatchStreamManager({ getRunSnapshot: () => latest, now: () => now });
  manager.open(res, latest);

  now += 1000;
  latest = { ...latest, status: 'first' };
  await manager.pushUpdates();
  latest = { ...latest, status: 'second' };
  await manager.pushUpdates();
  manager.writeHeartbeats();
  assert.equal(manager.size, 1, 'two false writes keep the stream open');
  assert.equal(res.writes.filter((chunk) => chunk.includes('event: delta')).length, 1, 'deltas pause after back-pressure');

  res.emit('drain');
  assert.equal(res.writes.filter((chunk) => chunk.includes('event: snapshot')).length, 2, 'drain sends one fresh snapshot');
  assert.match(res.writes.at(-1), /"status":"second"/);

  now += 1000;
  latest = { ...latest, status: 'resumed' };
  await manager.pushUpdates();
  assert.equal(res.writes.filter((chunk) => chunk.includes('event: delta')).length, 2, 'updates resume after the drain snapshot');
  manager.close();

  const capped = new EventEmitter();
  capped.writableLength = 0;
  capped.write = () => false;
  capped.end = function end() { this.ended = true; this.emit('close'); };
  const cappedManager = createWatchStreamManager({ getRunSnapshot: () => ({ status: 'changed' }), now: () => now });
  cappedManager.open(capped, { status: 'live' });
  await cappedManager.pushUpdates();
  capped.writableLength = MAX_STREAM_BUFFER_BYTES + 1;
  cappedManager.writeHeartbeats();
  assert.equal(cappedManager.size, 0, 'a buffer over the cap drops the stream');
  assert.equal(capped.ended, true);

  const expired = new EventEmitter();
  expired.writableLength = 0;
  expired.write = () => false;
  expired.end = function end() { this.ended = true; this.emit('close'); };
  const expiredManager = createWatchStreamManager({ getRunSnapshot: () => ({ status: 'changed' }), now: () => now });
  expiredManager.open(expired, { status: 'live' });
  await expiredManager.pushUpdates();
  now += 60001;
  expiredManager.writeHeartbeats();
  assert.equal(expiredManager.size, 0, 'a pause over 60 seconds drops the stream');
  assert.equal(expired.ended, true);
});

function openStream(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/events?t=${token}`, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding('utf8');
      resolve({ req, res });
    });
    req.on('error', reject);
  });
}

test('event streams receive a ping without rereading the run and stop receiving it after close', async () => {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-chip-assets-'));
  await fs.writeFile(path.join(assetDir, 'index.html'), '<!doctype html><title>watch</title>');
  await fs.writeFile(path.join(assetDir, 'app.js'), 'void 0;\n');
  let reads = 0;
  let heartbeat;
  const cleared = [];
  const server = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    getRunSnapshot: () => { reads += 1; return { schema: 1, runId: 'r1', status: 'live' }; },
    getPlanSnapshot: () => ({ present: false }),
    getGallery: () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
    heartbeatMs: 25,
    setIntervalFn: (fn, ms) => {
      if (ms === 25) heartbeat = fn;
      return { unref() {} };
    },
    clearIntervalFn: (timer) => cleared.push(timer),
  });
  let stream;
  try {
    await server.listen();
    stream = await openStream(Number(new URL(server.url).port), server.token);
    assert.equal(stream.res.statusCode, 200);
    await new Promise((resolve) => stream.res.once('data', resolve));
    assert.equal(reads, 1, 'opening the stream reads one snapshot');
    assert.equal(typeof heartbeat, 'function');

    const ping = new Promise((resolve) => stream.res.once('data', resolve));
    heartbeat();
    const chunk = String(await ping);
    assert.match(chunk, /: ping\n\n/);
    assert.match(chunk, /event: ping\ndata: \{\}\n\n/);
    assert.equal(reads, 1, 'heartbeat does not call getRunSnapshot');

    const ended = new Promise((resolve) => stream.req.once('close', resolve));
    stream.req.destroy();
    await ended;
    const before = reads;
    heartbeat();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, before, 'a closed stream is removed from the heartbeat set');
  } finally {
    if (stream) stream.req.destroy();
    await server.close();
    await fs.rm(assetDir, { recursive: true, force: true });
  }
  assert.ok(cleared.length >= 1, 'heartbeat timer is cleared on close');
});
