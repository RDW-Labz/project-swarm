import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRunSnapshot } from '../tools/watch-state.mjs';
import { contextCommands } from '../tools/watch-command-meta.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';
import { approveScreens, addComment, readGallery } from '../tools/watch-gallery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolPath = (name) => path.join(here, '..', 'tools', name);
const NOW = Date.parse('2026-01-01T00:10:00.000Z');

test('buildRunSnapshot skips jobs with unsafe ids and nulls unsafe run ids', () => {
  const state = {
    id: 'run 1',
    status: 'complete',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    jobs: [{ id: 'x; rm -rf ~', status: 'complete', attempts: [] }],
  };
  const snap = buildRunSnapshot(state, { now: NOW });
  assert.equal(snap.runId, null);
  assert.equal(snap.jobs.length, 0);
});

test('buildRunSnapshot cuts long worker text to 200 characters', () => {
  const state = {
    id: 'run-2',
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:05:00.000Z',
    jobs: [{ id: 'j1', status: 'failed', error: 'e'.repeat(400), attempts: [{}] }],
  };
  const snap = buildRunSnapshot(state, { now: NOW });
  const item = snap.attention.find((a) => a.kind === 'failure');
  assert.ok(item);
  assert.ok(item.text.length <= 200);
});

test('buildRunSnapshot does not throw on a null job entry', () => {
  const state = {
    id: 'run-3',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    jobs: [null, { id: 'j2', status: 'queued', attempts: [] }],
  };
  assert.doesNotThrow(() => buildRunSnapshot(state, { now: NOW }));
});

test('buildRunSnapshot maps statuses as specified', () => {
  const base = { id: 'run-4', startedAt: '2026-01-01T00:00:00.000Z', jobs: [] };
  assert.equal(buildRunSnapshot({ ...base, status: 'planning' }, { now: NOW }).status, 'live');
  assert.equal(
    buildRunSnapshot({ ...base, status: 'cancelled', pause: { at: '2026-01-01T00:01:00.000Z' } }, { now: NOW }).status,
    'failed',
  );
  assert.equal(
    buildRunSnapshot({ ...base, status: 'running', pause: { at: '2026-01-01T00:01:00.000Z' } }, { now: NOW }).status,
    'paused',
  );
});

test('contextCommands returns nothing for a null runId', () => {
  const snap = { runId: null, status: 'live', kpi: { failed: 0 }, jobs: [] };
  assert.deepEqual(contextCommands(snap, { present: false }), []);
});

test('contextCommands returns nothing for an unsafe runId', () => {
  const snap = { runId: 'bad id;x', status: 'live', kpi: { failed: 0 }, jobs: [] };
  assert.deepEqual(contextCommands(snap, { present: false }), []);
});

test('contextCommands shows the results inspect command for failed jobs and never retry', () => {
  const snap = {
    runId: 'run-1',
    status: 'complete',
    kpi: { failed: 1 },
    jobs: [{ id: 'j1', status: 'failed' }],
  };
  const list = contextCommands(snap, { present: false }).map((c) => c.command);
  assert.ok(list.includes('swarm inspect run-1 --results'));
  assert.ok(!list.some((c) => c.includes('retry')));
});

test('watch-delta.mjs source is browser-safe and exposes the delta functions', async () => {
  const src = readFileSync(toolPath('watch-delta.mjs'), 'utf8');
  assert.ok(!src.split(/\r?\n/).some((l) => /^\s*import\s/.test(l)));
  assert.ok(!src.includes('process.'));
  assert.ok(!src.includes('node:'));
  const mod = await import(pathToFileURL(toolPath('watch-delta.mjs')).href);
  assert.equal(typeof mod.diffSnapshots, 'function');
  assert.equal(typeof mod.applyDelta, 'function');
  assert.equal(typeof mod.createThrottle, 'function');
});

test('watch server enforces token, CSP, and the event stream limit', async () => {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-assets-'));
  await fs.writeFile(path.join(assetDir, 'index.html'), '<!doctype html><title>t</title>');
  const server = createWatchServer({
    root: assetDir,
    getRunSnapshot: () => ({ status: 'live' }),
    getPlanSnapshot: () => ({ present: false }),
    getGallery: () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
    assetDir,
    deltaFile: toolPath('watch-delta.mjs'),
    idleMs: 600000,
  });
  const reqs = [];
  try {
    await server.listen();
    const token = server.token;
    const port = new URL(server.url).port;
    const hostHeader = `127.0.0.1:${port}`;
    const get = (p, headers = {}) =>
      new Promise((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port: Number(port), path: p, headers: { Host: hostHeader, ...headers } },
          (res) => resolve({ req, res }),
        );
        req.on('error', reject);
        reqs.push(req);
      });

    const snap = await get('/api/snapshot?t=wrong', { 'x-watch-token': token });
    assert.equal(snap.res.statusCode, 200);
    assert.ok(String(snap.res.headers['content-security-policy']).includes("frame-ancestors 'none'"));
    snap.res.resume();

    const streams = [];
    for (let i = 0; i < 9; i++) {
      const s = await get('/events', { 'x-watch-token': token });
      streams.push(s);
      if (i < 8) assert.equal(s.res.statusCode, 200);
    }
    assert.equal(streams[8].res.statusCode, 503);
  } finally {
    for (const req of reqs) req.destroy();
    await server.close();
    await fs.rm(assetDir, { recursive: true, force: true });
  }
});

test('gallery refuses to approve a screen without a tree and writes nothing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-'));
  try {
    await fs.mkdir(path.join(root, '.swarm', 'ui'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.swarm', 'ui', 'results.json'),
      JSON.stringify({
        screens: {
          home: { pass: true, score: 1, reasons: [], at: '2026-01-01T00:00:00.000Z', tree: 't1' },
          bare: { pass: true, score: 1, reasons: [], at: '2026-01-01T00:00:00.000Z' },
        },
      }),
    );
    await assert.rejects(approveScreens(root, ['bare'], { by: 'owner', now: NOW }));
    await assert.rejects(fs.access(path.join(root, '.swarm', 'ui', 'gallery.json')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('addComment keeps an earlier comment text unchanged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gallery-'));
  try {
    await fs.mkdir(path.join(root, '.swarm', 'ui'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.swarm', 'ui', 'results.json'),
      JSON.stringify({
        screens: {
          home: { pass: true, score: 1, reasons: [], at: '2026-01-01T00:00:00.000Z', tree: 't1' },
        },
      }),
    );
    await addComment(root, 'home', 'first note', { now: NOW });
    await addComment(root, 'home', 'second note', { now: NOW + 1000 });
    const gallery = await readGallery(root);
    const home = gallery.screens.find((s) => s.id === 'home');
    assert.ok(home);
    assert.equal(home.comments[0].text, 'first note');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
