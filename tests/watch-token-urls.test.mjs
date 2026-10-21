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

const root = fileURLToPath(new URL('..', import.meta.url));
const deltaFile = path.join(root, 'tools', 'watch-delta.mjs');

function request(port, reqPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(t) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-token-urls-'));
  await Promise.all([
    fs.writeFile(path.join(assetDir, 'index.html'), '<!doctype html><title>board</title>'),
    fs.writeFile(path.join(assetDir, 'project.html'), '<!doctype html><title>project</title>'),
    fs.writeFile(path.join(assetDir, 'run.html'), '<!doctype html><title>run</title>'),
  ]);
  const board = {
    snapshot: async () => ({ projects: [] }),
    project: async () => null,
    live: async () => null,
    history: async () => ({ events: [], total: 0 }),
    historyCsv: async () => 'at,kind\n',
    run: async () => null,
    openRun: async () => null,
  };
  const server = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    board,
    getBoard: async () => ({ runs: [] }),
    getJobReport: async () => ({ summary: 'ok' }),
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    commandList: [],
    contextCommands: () => [],
    nav: { project: { id: 'p1', name: 'Project' }, runId: 'r1', openBoard: async () => null },
    idleMs: 60000,
  });
  await server.listen();
  t.after(async () => {
    await server.close();
    await fs.rm(assetDir, { recursive: true, force: true });
  });
  return { server, port: Number(new URL(server.url).port), token: server.token };
}

test('non-page routes ignore query tokens and accept the header or strict cookie', async (t) => {
  const { server, port, token } = await startServer(t);
  const routes = [
    '/api/snapshot',
    '/api/board',
    '/api/project?id=p1',
    '/api/live?id=p1',
    '/api/history',
    '/api/run?id=p1&run=r1',
    '/api/nav',
    '/job/j1',
    '/shot/j1/page',
    '/history.csv',
    '/board',
    '/open/run?id=p1&run=r1',
    '/nav/board',
    '/nav/project',
  ];
  for (const route of routes) {
    const queryOnly = await request(port, `${route}${route.includes('?') ? '&' : '?'}t=${token}`);
    assert.equal(queryOnly.status, 403, `query-only token must be refused for ${route}`);
    const byHeader = await request(port, route, { 'x-watch-token': token });
    assert.notEqual(byHeader.status, 401, `header token must not be unauthorized for ${route}`);
    assert.notEqual(byHeader.status, 403, `header token must be accepted for ${route}`);
    const byCookie = await request(port, route, { Cookie: `swarm_watch=${token}` });
    assert.notEqual(byCookie.status, 401, `cookie token must not be unauthorized for ${route}`);
    assert.notEqual(byCookie.status, 403, `cookie token must be accepted for ${route}`);
  }
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}`, 'x-watch-token': token } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.resume();
      req.destroy();
      resolve();
    });
    req.on('error', (error) => error.code === 'ECONNRESET' ? resolve() : reject(error));
    req.end();
  });
  assert.equal((await request(port, '/api/snapshot', { Cookie: `swarm_watch=${token}; malformed` })).status, 403);
  assert.equal((await request(port, '/api/snapshot', { Cookie: `swarm_watch=${token}; other=value` })).status, 200);
  assert.equal(server.token, token);
});

test('/api/health is token-free on loopback only', async (t) => {
  const { port } = await startServer(t);
  const health = await request(port, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(health.body)).sort(), ['ok', 'pid', 'version']);
  assert.equal((await request(port, '/api/health', { Host: `example.test:${port}` })).status, 421);
});

test('HTML page query tokens are exchanged for a protected cookie and privacy headers', async (t) => {
  const { port, token } = await startServer(t);
  const page = await request(port, `/?keep=yes&t=${token}#ignored`);
  assert.equal(page.status, 200);
  assert.match(page.headers['set-cookie']?.[0] ?? '', new RegExp(`^swarm_watch=${token}; HttpOnly; SameSite=Strict; Path=/$`));
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');

  const cookie = page.headers['set-cookie'][0].split(';', 1)[0];
  assert.equal((await request(port, '/api/snapshot', { Cookie: cookie })).status, 200);
  assert.equal((await request(port, '/project?id=p1', { Cookie: cookie })).status, 200);

  const secure = await request(port, `/?t=${token}`, { 'x-forwarded-proto': 'https' });
  assert.match(secure.headers['set-cookie']?.[0] ?? '', /; Secure$/);
  const head = await request(port, `/run?id=p1&run=r1&t=${token}`, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.match(head.headers['set-cookie']?.[0] ?? '', /^swarm_watch=/);
});

test('watch assets and remote local calls do not build token URLs', async () => {
  const assets = path.join(root, 'tools', 'watch-assets');
  const names = (await fs.readdir(assets)).filter((name) => name.endsWith('.js'));
  for (const name of names) {
    const source = await fs.readFile(path.join(assets, name), 'utf8');
    assert.doesNotMatch(source, /[?&]t\s*=/, `${name} must not put t in a URL`);
    assert.doesNotMatch(source, /['"]t=['"]\s*\+/, `${name} must not concatenate a t query parameter`);
  }
  const remote = await fs.readFile(path.join(root, 'tools', 'remote.mjs'), 'utf8');
  assert.match(remote, /const localUrl = \(state, pathname = '\/api\/board'\) => `http:\/\/127\.0\.0\.1:\$\{state\.port\}\$\{pathname\}`/);
  assert.doesNotMatch(remote, /localUrl[\s\S]{0,160}\?t=/);
});
