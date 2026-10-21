// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createWatchServer, createWatchStreamManager } from '../tools/watch-server.mjs';

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

test('a slow snapshot and two back-pressured writes keep the stream open and Live pings flowing', async () => {
  const L = await boardLib();
  let now = 1000;
  let reads = 0;
  const timers = [];
  const advance = async (ms) => {
    now += ms;
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (timers[i].at <= now) timers.splice(i, 1)[0].resolve();
    }
    await Promise.resolve();
  };
  const getRunSnapshot = async () => {
    reads += 1;
    await new Promise((resolve) => timers.push({ at: now + 1500, resolve }));
    return { schema: 1, runId: 'r1', status: 'changed-' + reads };
  };
  const manager = createWatchStreamManager({ getRunSnapshot, now: () => now });
  let updateWrites = 0;
  const chunks = [];
  const listeners = {};
  const res = {
    on(event, fn) { listeners[event] = fn; },
    write(chunk) {
      const text = String(chunk);
      chunks.push(text);
      if (text.includes('event: delta')) {
        updateWrites += 1;
        return updateWrites > 2;
      }
      return true;
    },
    end() { listeners.end?.(); },
  };
  manager.open(res, { schema: 1, runId: 'r1', status: 'live' });
  assert.equal(updateWrites, 0);

  const update = manager.pushUpdates();
  assert.equal(reads, 1, 'the update read is in flight');
  let lastMessageAt = now;
  await advance(500);
  manager.writeHeartbeats();
  lastMessageAt = now;
  assert.equal(manager.size, 1, 'a false write is back-pressure, not a closed stream');
  assert.equal(L.streamState({ lastMessageAt, now, heartbeatMs: 1000 }).state, 'live');

  await advance(500);
  manager.writeHeartbeats();
  lastMessageAt = now;
  assert.equal(L.streamState({ lastMessageAt, now, heartbeatMs: 1000 }).state, 'live');
  assert.equal(chunks.filter((chunk) => chunk.includes('event: ping')).length, 2, 'heartbeats go out while the read is slow');

  await advance(500);
  await update;
  assert.equal(updateWrites, 1, 'the first changed snapshot hit back-pressure');
  const nextUpdate = manager.pushUpdates();
  await advance(500);
  manager.writeHeartbeats();
  lastMessageAt = now;
  assert.equal(L.streamState({ lastMessageAt, now, heartbeatMs: 1000 }).state, 'live');
  await advance(500);
  manager.writeHeartbeats();
  lastMessageAt = now;
  assert.equal(L.streamState({ lastMessageAt, now, heartbeatMs: 1000 }).state, 'live');
  await advance(500);
  await nextUpdate;
  assert.equal(updateWrites, 2, 'the second changed snapshot also hit back-pressure');
  assert.equal(manager.size, 1, 'the slow snapshot does not close the stream');
  manager.close();
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
