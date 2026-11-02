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
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

async function start(overrides = {}) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-assets-'));
  await fs.writeFile(path.join(assetDir, 'index.html'), '<!doctype html><title>watch</title>');
  await fs.writeFile(path.join(assetDir, 'app.js'), 'void 0;\n');
  const state = { run: { schema: 1, runId: 'r1', status: 'live', jobs: [{ id: 'a', status: 'queued' }] } };
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
    state,
    port,
    token: srv.token,
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

function request({ port, method = 'GET', path: reqPath, host, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: { Host: host ?? `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function parseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  return { event, data: JSON.parse(data.join('\n')) };
}

function openStream(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: reqPath,
        headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream' },
      },
      (res) => {
        const stream = { req, res, events: [], buf: '' };
        res.setEncoding('utf8');
        res.on('data', (d) => {
          stream.buf += d;
          let i;
          while ((i = stream.buf.indexOf('\n\n')) >= 0) {
            const block = stream.buf.slice(0, i);
            stream.buf = stream.buf.slice(i + 2);
            const ev = parseBlock(block);
            if (ev) stream.events.push(ev);
          }
        });
        res.on('error', () => {});
        resolve(stream);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('binds to 127.0.0.1 with a 24-byte hex token', async () => {
  const s = await start();
  try {
    const u = new URL(s.srv.url);
    assert.equal(u.hostname, '127.0.0.1');
    assert.match(s.token, /^[0-9a-f]{48}$/);
    assert.equal(u.searchParams.get('t'), s.token);
  } finally {
    await s.dispose();
  }
});

test('token is required for page, api, events and shot routes', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/api/snapshot', '/events', '/shot/x/page']) {
      const res = await request({ port: s.port, path: p });
      assert.equal(res.status, 403, `expected 403 for ${p}`);
    }
  } finally {
    await s.dispose();
  }
});

test('token accepted in query or x-watch-token header', async () => {
  const s = await start();
  try {
    const byQuery = await request({ port: s.port, path: `/api/snapshot?t=${s.token}` });
    assert.equal(byQuery.status, 200);
    const byHeader = await request({
      port: s.port,
      path: '/api/snapshot',
      headers: { 'x-watch-token': s.token },
    });
    assert.equal(byHeader.status, 200);
  } finally {
    await s.dispose();
  }
});

test('wrong Host header gives 421', async () => {
  const s = await start();
  try {
    const res = await request({
      port: s.port,
      path: `/?t=${s.token}`,
      host: `evil.example:${s.port}`,
    });
    assert.equal(res.status, 421);
  } finally {
    await s.dispose();
  }
});

test('localhost Host header with the right port is accepted', async () => {
  const s = await start();
  try {
    const res = await request({
      port: s.port,
      path: `/api/snapshot?t=${s.token}`,
      host: `localhost:${s.port}`,
    });
    assert.equal(res.status, 200);
  } finally {
    await s.dispose();
  }
});

test('POST, PUT, DELETE and PATCH give 405', async () => {
  const s = await start();
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await request({ port: s.port, method, path: `/api/snapshot?t=${s.token}` });
      assert.equal(res.status, 405, `expected 405 for ${method}`);
    }
  } finally {
    await s.dispose();
  }
});

test('assets need no token; unknown names and traversal give 404', async () => {
  const s = await start();
  try {
    const ok = await request({ port: s.port, path: '/assets/app.js' });
    assert.equal(ok.status, 200);
    const unknown = await request({ port: s.port, path: '/assets/missing.js' });
    assert.equal(unknown.status, 404);
    const traversal = await request({ port: s.port, path: '/assets/../index.html' });
    assert.equal(traversal.status, 404);
    const encoded = await request({ port: s.port, path: '/assets/..%2Findex.html' });
    assert.equal(encoded.status, 404);
  } finally {
    await s.dispose();
  }
});

test('every response carries the security headers with the exact CSP', async () => {
  const s = await start();
  try {
    const res = await request({ port: s.port, path: `/?t=${s.token}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-security-policy'], CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');

    const denied = await request({ port: s.port, path: '/api/snapshot' });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['content-security-policy'], CSP);
  } finally {
    await s.dispose();
  }
});

test('/api/snapshot returns the five keys', async () => {
  const s = await start();
  try {
    const res = await request({ port: s.port, path: `/api/snapshot?t=${s.token}` });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['commands', 'contextCommands', 'gallery', 'plan', 'run']);
    assert.equal(body.run.runId, 'r1');
    assert.equal(body.plan.present, false);
  } finally {
    await s.dispose();
  }
});

test('/events sends a snapshot event then a delta after the snapshot changes', async () => {
  const s = await start();
  let stream = null;
  try {
    stream = await openStream(s.port, `/events?t=${s.token}`);
    assert.equal(stream.res.statusCode, 200);
    await waitFor(() => stream.events.some((e) => e.event === 'snapshot'), 3000);
    assert.equal(stream.events[0].event, 'snapshot');
    assert.equal(stream.events[0].data.runId, 'r1');

    s.state.run = { ...s.state.run, status: 'complete', jobs: [{ id: 'a', status: 'complete' }] };
    await waitFor(() => stream.events.some((e) => e.event === 'delta'), 4000);
    const delta = stream.events.find((e) => e.event === 'delta');
    assert.equal(delta.data.keys.status, 'complete');
    assert.deepEqual(delta.data.jobs.upserts.map((j) => j.id), ['a']);
  } finally {
    if (stream) stream.req.destroy();
    await s.dispose();
  }
});

test('close() ends open event streams', async () => {
  const s = await start();
  let stream = null;
  try {
    stream = await openStream(s.port, `/events?t=${s.token}`);
    await waitFor(() => stream.events.some((e) => e.event === 'snapshot'), 3000);
    const ended = new Promise((resolve) => {
      stream.res.on('end', resolve);
      stream.res.on('close', resolve);
      stream.req.on('close', resolve);
    });
    await s.srv.close();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('stream did not end after close()')), 3000);
    });
    try {
      await Promise.race([ended, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (stream) stream.req.destroy();
    await s.dispose();
  }
});
