// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWatchServer } from '../tools/watch-server.mjs';

const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const vendorSource = fileURLToPath(new URL('../tools/watch-assets/vendor', import.meta.url));

async function start(overrides = {}) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-vendor-assets-'));
  await fs.writeFile(path.join(assetDir, 'index.html'), '<!doctype html><title>watch</title>');
  await fs.cp(vendorSource, path.join(assetDir, 'vendor'), { recursive: true });
  const state = { run: { schema: 1, runId: 'r1', status: 'live', jobs: [] } };
  const srv = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    idleMs: 60000,
    getRunSnapshot: () => state.run,
    getPlanSnapshot: () => ({ present: false }),
    getGallery: () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
    ...overrides,
  });
  await srv.listen();
  const port = Number(new URL(srv.url).port);
  return {
    srv,
    assetDir,
    port,
    dispose: async () => {
      try {
        await srv.close();
      } catch {
        // already closed
      }
      await fs.rm(assetDir, { recursive: true, force: true });
    },
  };
}

function request({ port, method = 'GET', path: reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

test('vendor assets are preloaded and served by exact key; symlinks and blocked paths 404', async () => {
  const s = await start();
  try {
    const fontPath = path.join(vendorSource, 'fonts', 'oxanium-latin-wght-normal.woff2');
    const expectedFont = await fs.readFile(fontPath);
    const fontRes = await request({
      port: s.port,
      path: '/assets/vendor/fonts/oxanium-latin-wght-normal.woff2',
    });
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers['content-type'], 'font/woff2');
    assert.equal(fontRes.body.compare(expectedFont), 0);

    const webpPath = path.join(vendorSource, 'fluent-emoji', 'robot_56.webp');
    const webpRes = await request({ port: s.port, path: '/assets/vendor/fluent-emoji/robot_56.webp' });
    assert.equal(webpRes.status, 200);
    assert.equal(webpRes.headers['content-type'], 'image/webp');

    assert.equal((await request({ port: s.port, path: '/assets/vendor/VENDOR.json' })).status, 404);
    assert.equal(
      (await request({ port: s.port, path: '/assets/vendor/fonts/LICENSE-oxanium' })).status,
      404,
    );
    assert.equal(
      (await request({ port: s.port, path: '/assets/vendor/../watch-server.mjs' })).status,
      404,
    );
    assert.equal((await request({ port: s.port, path: '/assets/%2e%2e/x' })).status, 404);
  } finally {
    await s.dispose();
  }
});

test('symlink under vendor at load time is not served', async () => {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-vendor-symlink-'));
  const outside = path.join(os.tmpdir(), `watch-vendor-outside-${process.pid}.txt`);
  await fs.writeFile(outside, 'secret');
  await fs.writeFile(path.join(assetDir, 'index.html'), '<!doctype html>');
  await fs.cp(vendorSource, path.join(assetDir, 'vendor'), { recursive: true });
  await fs.symlink(outside, path.join(assetDir, 'vendor', 'escape.txt'));
  const state = { run: { schema: 1, runId: 'r1', status: 'live', jobs: [] } };
  const srv = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    idleMs: 60000,
    getRunSnapshot: () => state.run,
    getPlanSnapshot: () => ({ present: false }),
    getGallery: () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
  });
  try {
    await srv.listen();
    const port = Number(new URL(srv.url).port);
    const linkRes = await request({ port, path: '/assets/vendor/escape.txt' });
    assert.equal(linkRes.status, 404);
  } finally {
    try {
      await srv.close();
    } catch {
      // already closed
    }
    await fs.rm(assetDir, { recursive: true, force: true });
    await fs.unlink(outside).catch(() => {});
  }
});
