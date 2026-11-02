// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WATCH_ROUTES } from '../tools/watch-server.mjs';
import { makeRunServer, startBoardServer } from '../tools/watch-cli.mjs';
import { projectId } from '../tools/projects.mjs';

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'classic-routes-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const get = (port, pathname, { method = 'GET', headers = {}, host } = {}) => new Promise((resolve, reject) => {
  const req = http.request(
    { hostname: '127.0.0.1', port, path: pathname, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } },
    res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    },
  );
  req.on('error', reject);
  req.end();
});

const portOf = url => Number(new URL(url).port);
const tokenOf = url => new URL(url).searchParams.get('t');

/** Classic HTML pages (pre–Command Center): board shell and run watch, not JSON/API/nav redirects. */
const CLASSIC_HTML_ROUTES = Object.freeze(['/', '/project', '/run']);

function assertNonEmptyMain(body, routeLabel) {
  const openIdx = body.search(/<main[\s>]/i);
  assert.notEqual(openIdx, -1, `${routeLabel}: response must include a <main> landmark`);
  const closeIdx = body.indexOf('</main>', openIdx);
  assert.notEqual(closeIdx, -1, `${routeLabel}: response must close </main>`);
  const openTagEnd = body.indexOf('>', openIdx);
  const inner = body.slice(openTagEnd + 1, closeIdx);
  assert.ok(inner.replace(/\s+/g, '').length > 0, `${routeLabel}: <main> must contain non-whitespace content`);
}

async function setupProject(t) {
  const home = await tmp(t);
  const root = path.join(home, 'parts-app');
  await fs.mkdir(path.join(root, '.swarm/runs/run-1'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.swarm/runs/run-1/state.json'),
    JSON.stringify({
      id: 'run-1',
      status: 'running',
      startedAt: new Date().toISOString(),
      jobs: [{ id: 'a', status: 'running', agent: 'codex' }],
    }),
  );
  const real = await fs.realpath(root);
  const env = {
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'),
    SWARM_BOARD_FILE: path.join(home, 'board.json'),
    SWARM_CONFIG: path.join(home, 'none.json'),
  };
  await fs.writeFile(
    env.SWARM_PROJECTS_FILE,
    JSON.stringify({
      version: 1,
      projects: [{ id: projectId(real), root: real, name: 'parts-app', addedAt: 'x', lastSeen: 'x' }],
    }),
  );
  return { home, root: real, env, id: projectId(real) };
}

test('WATCH_ROUTES lists every classic board path (no Command Center)', () => {
  for (const route of CLASSIC_HTML_ROUTES) {
    assert.ok(WATCH_ROUTES.includes(route), `expected classic route ${route} in WATCH_ROUTES`);
  }
  for (const route of WATCH_ROUTES) {
    assert.ok(!route.startsWith('/api/command-center'), `unexpected Command Center route in WATCH_ROUTES: ${route}`);
  }
});

test('board classic HTML routes return 200 with a non-empty <main>', async t => {
  const { env, root, id } = await setupProject(t);
  const board = await startBoardServer({ env, root });
  t.after(async () => {
    await board.server.close();
    await board.api.close();
  });
  const port = portOf(board.url);
  const token = tokenOf(board.url);
  const auth = { headers: { 'x-watch-token': token } };

  const cases = [
    { label: 'board home', path: `/?t=${encodeURIComponent(token)}` },
    { label: 'project page', path: `/project?id=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}` },
    { label: 'run inspector', path: `/run?id=${encodeURIComponent(id)}&run=run-1&t=${encodeURIComponent(token)}` },
  ];

  for (const { label, path: pathname } of cases) {
    const res = await get(port, pathname, auth);
    assert.equal(res.status, 200, `${label}: status`);
    assertNonEmptyMain(res.body, label);
  }
});

test('run watch classic HTML route returns 200 with a non-empty <main>', async t => {
  const { root } = await setupProject(t);
  const runServer = makeRunServer(root, 'run-1');
  await runServer.listen();
  t.after(() => runServer.close());
  const port = portOf(runServer.url);
  const token = tokenOf(runServer.url);
  const res = await get(port, `/?t=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200);
  assertNonEmptyMain(res.body, 'run watch /');
});
