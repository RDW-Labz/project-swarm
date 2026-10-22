// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardApi, stripMoney } from '../tools/watch-cli.mjs';
import { checkProjectCap } from '../tools/project-spend.mjs';
import { projectId } from '../tools/projects.mjs';
import { createWatchServer, WATCH_ROUTES } from '../tools/watch-server.mjs';
import { buildRunSnapshot } from '../tools/watch-state.mjs';

const MONEY_KEY = /usd|Usd|USD|cost|Cost|billed|Billed|listValue|flatRate|price|Price|spend|Spend|budget|Budget/;
const DOLLAR_IN_TEXT = /\$\s?\d/;
/** Substrings allowed to contain dollar figures in otherwise-scanned response bodies (none today). */
const BODY_DOLLAR_EXCEPTIONS = [];
const assetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/watch-assets');
const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));
const SOURCE_FORBIDDEN = [
  [/usd\s*\(/, 'usd( helper'],
  [/'\$'\s*\+/, '$ + number formatting'],
  [/list value/i, 'list value'],
  [/\bBilled\b/, 'Billed'],
  [/tile\s*\(\s*['"]Cost['"]/, 'Cost tile label'],
];

function assertNoMoney(value, at = '$') {
  if (Array.isArray(value)) return value.forEach((item, i) => assertNoMoney(item, `${at}[${i}]`));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') assert.doesNotMatch(value, DOLLAR_IN_TEXT, at);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, MONEY_KEY, `${at}.${key}`);
    assert.notEqual(key, 'cap', `${at}.${key}`);
    assert.notEqual(key, 'caps', `${at}.${key}`);
    assertNoMoney(child, `${at}.${key}`);
  }
}

function assertBodyNoDollars(body, at) {
  if (!body) return;
  for (const exception of BODY_DOLLAR_EXCEPTIONS) {
    if (body.includes(exception)) return;
  }
  assert.doesNotMatch(body, DOLLAR_IN_TEXT, at);
}

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-no-money-')));
  const root = path.join(home, 'parts-request-app');
  await fs.mkdir(path.join(root, '.swarm/runs/run-paid'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-paid/state.json'), JSON.stringify({
    id: 'run-paid', status: 'running', startedAt: '2026-10-21T12:00:00.000Z',
    jobs: [{ id: 'T-1', agent: 'anthropic', model: 'claude', status: 'complete', costUsd: 2.5, usage: { total_tokens: 100 }, durationMs: 4000 }],
  }));
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 100 } } }));
  await fs.mkdir(path.join(home, 'spend'), { recursive: true });
  await fs.writeFile(path.join(home, 'spend/daily.json'), JSON.stringify({ version: 1, entries: {
    paid: { day: '2026-10-21', lane: 'anthropic', kind: 'actual', usd: 2.5, tokens: 100 },
  } }));
  const project = { id: projectId(root), name: 'parts-request-app', root, addedAt: '2026-10-21T12:00:00.000Z', lastSeen: '2026-10-21T12:00:00.000Z' };
  const env = {
    ...process.env,
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_HISTORY_FILE: path.join(home, 'history.ndjson'),
    SWARM_CONFIG: path.join(home, 'config.json'),
    SWARM_LANES_DIR: path.join(home, 'lanes'),
    SWARM_SPEND_DIR: path.join(home, 'spend'),
  };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [project] }));
  const historyAt = '2026-10-21T12:00:00.000Z';
  const historyLines = [
    { at: historyAt, project: project.name, projectId: project.id, kind: 'spend', key: 'spend:fixture', title: 'Spent $9.99 on run', run: 'run-paid', usd: 9.99 },
    { at: historyAt, project: project.name, projectId: project.id, kind: 'run', key: 'run:fixture', title: 'Run complete', run: 'run-paid', usd: 2.5 },
    { at: historyAt, project: project.name, projectId: project.id, kind: 'merge', key: 'merge:fixture', title: 'Merged #1', ref: '#1', usd: 0.01 },
    { at: historyAt, project: project.name, projectId: project.id, kind: 'stage', key: 'stage:fixture', title: 'Stage S1 done', ref: 'S1', usd: 100 },
  ].map(line => `${JSON.stringify(line)}\n`).join('');
  await fs.writeFile(env.SWARM_HISTORY_FILE, historyLines);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, root, project, env };
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openSse(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream', ...headers },
    }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          let event = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      });
      resolve({ req, res, events });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitFor(events, predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timeout waiting for SSE'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function boardRoutePath(routePath, projectId, runId) {
  switch (routePath) {
    case '/':
    case '/api/snapshot':
    case '/events':
    case '/board':
    case '/api/board':
    case '/api/history':
    case '/history.csv':
    case '/api/nav':
    case '/nav/board':
    case '/nav/project':
      return routePath;
    case '/api/project':
    case '/api/live':
      return `${routePath}?id=${encodeURIComponent(projectId)}`;
    case '/api/run':
    case '/project':
    case '/run':
    case '/open/run':
      return `${routePath}?id=${encodeURIComponent(projectId)}&run=${encodeURIComponent(runId)}`;
    default:
      throw new Error(`unexpected WATCH_ROUTES entry: ${routePath}`);
  }
}

test('board HTML assets and shell pages ship no literal dollar figures', async t => {
  const htmlFiles = (await fs.readdir(assetDir)).filter(n => n.endsWith('.html')).sort();
  assert.ok(htmlFiles.length > 0, 'watch-assets HTML pages exist');
  for (const name of htmlFiles) {
    const body = await fs.readFile(path.join(assetDir, name), 'utf8');
    assertBodyNoDollars(body, `watch-assets/${name}`);
  }

  const fx = await fixture(t);
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const state = JSON.parse(await fs.readFile(path.join(fx.root, '.swarm/runs/run-paid/state.json'), 'utf8'));
  let runSnapshot = buildRunSnapshot(state, { now: NOW });
  runSnapshot.project = { noCap: true };

  const runWatch = createWatchServer({
    root: fx.home,
    assetDir,
    deltaFile,
    idleMs: 600000,
    getRunSnapshot: async () => runSnapshot,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: async () => ({ runs: [] }),
    indexName: 'index.html',
    commandList: [],
    contextCommands: () => [],
  });
  await runWatch.listen();
  const runPort = Number(new URL(runWatch.url).port);
  const runAuth = { 'x-watch-token': runWatch.token };
  t.after(async () => { await runWatch.close(); });

  const runHome = await httpGet(runPort, '/', runAuth);
  assert.notEqual(runHome.status, 403, 'run Watch / must accept x-watch-token');
  assertBodyNoDollars(runHome.body, 'run Watch GET /');

  const api = createBoardApi({
    env: fx.env,
    now: () => NOW,
    live: async () => [{ runId: 'run-paid', root: fx.root, startedAt: '2026-10-21T12:00:00.000Z' }],
    cacheMs: 0,
    runServer: () => ({
      listen: async () => ({ url: 'http://127.0.0.1:9/?t=deadbeef', port: 9 }),
      close: async () => {},
      done: Promise.resolve(),
      token: 'deadbeef',
    }),
  });
  t.after(() => api.close());
  const boardWatch = createWatchServer({
    root: fx.home,
    assetDir,
    deltaFile,
    idleMs: 600000,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: async () => ({ runs: [] }),
    board: api,
    nav: { project: { id: fx.project.id, name: fx.project.name }, runId: 'run-paid', openBoard: async () => 'http://127.0.0.1:9/' },
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
  });
  await boardWatch.listen();
  const boardPort = Number(new URL(boardWatch.url).port);
  const boardAuth = { 'x-watch-token': boardWatch.token };
  t.after(async () => { await boardWatch.close(); await api.close(); });

  for (const pathname of [
    `/project?id=${encodeURIComponent(fx.project.id)}&run=${encodeURIComponent('run-paid')}`,
    `/run?id=${encodeURIComponent(fx.project.id)}&run=${encodeURIComponent('run-paid')}`,
  ]) {
    const res = await httpGet(boardPort, pathname, boardAuth);
    assert.notEqual(res.status, 403, `${pathname} must accept x-watch-token`);
    assertBodyNoDollars(res.body, `board Watch GET ${pathname}`);
  }
});

test('every board Watch route returns no money-shaped JSON or dollar figures', async t => {
  const fx = await fixture(t);
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const api = createBoardApi({
    env: fx.env,
    now: () => NOW,
    live: async () => [{ runId: 'run-paid', root: fx.root, startedAt: '2026-10-21T12:00:00.000Z' }],
    cacheMs: 0,
    runServer: () => ({
      listen: async () => ({ url: 'http://127.0.0.1:9/?t=deadbeef', port: 9 }),
      close: async () => {},
      done: Promise.resolve(),
      token: 'deadbeef',
    }),
  });
  t.after(() => api.close());
  const server = createWatchServer({
    root: fx.home,
    assetDir,
    deltaFile,
    idleMs: 600000,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: async () => ({ runs: [] }),
    board: api,
    nav: { project: { id: fx.project.id, name: fx.project.name }, runId: 'run-paid', openBoard: async () => 'http://127.0.0.1:9/' },
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
  });
  await server.listen();
  const token = server.token;
  const port = Number(new URL(server.url).port);
  t.after(async () => { await server.close(); await api.close(); });

  assert.ok(WATCH_ROUTES.length > 0, 'WATCH_ROUTES is exported');
  for (const routePath of WATCH_ROUTES) {
    if (routePath === '/events') continue;
    const pathname = boardRoutePath(routePath, fx.project.id, 'run-paid');
    const res = await httpGet(port, pathname, { 'x-watch-token': token });
    assert.notEqual(res.status, 403, `${pathname} must accept x-watch-token`);
    assertBodyNoDollars(res.body, routePath);
    const type = res.headers['content-type'] ?? '';
    if (type.includes('application/json')) {
      assertNoMoney(JSON.parse(res.body), routePath);
    }
  }

  const stream = await openSse(port, '/events', { 'x-watch-token': token });
  t.after(() => stream.req.destroy());
  await waitFor(stream.events, () => stream.events.some(e => e.event === 'snapshot'));
  const snapshotEvent = stream.events.find(e => e.event === 'snapshot');
  assertNoMoney(snapshotEvent.data, 'events/snapshot');
  assertBodyNoDollars(snapshotEvent.data ? JSON.stringify(snapshotEvent.data) : '', 'events/snapshot');
});

test('stripMoney deep-copies and removes money objects while preserving non-money fields', () => {
  const input = {
    ok: 1,
    noCap: true,
    capBasis: 'billed+list',
    spend: { usd: 3 },
    cost: { total: 3 },
    cap: { maxUsd: 4 },
    nested: [{ price: 2, label: 'jobs' }],
  };
  const output = stripMoney(input);
  assert.deepEqual(output, { ok: 1, noCap: true, capBasis: 'billed+list', nested: [{ label: 'jobs' }] });
  assert.equal(input.spend.usd, 3, 'the response source is not mutated');
});

test('a project cap still refuses a new run after spend is recorded', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 1 } } }));
  const decision = await checkProjectCap(fx.root, { env: fx.env });
  assert.ok(decision, 'the cap refuses the run');
  assert.match(decision.message, /project-cap/);
});

test('board history JSON and CSV drop spend events and strip money fields', async t => {
  const fx = await fixture(t);
  const NOW = Date.parse('2026-10-21T12:00:00.000Z');
  const api = createBoardApi({
    env: fx.env,
    now: () => NOW,
    live: async () => [],
    cacheMs: 0,
    runServer: () => ({
      listen: async () => ({ url: 'http://127.0.0.1:9/?t=deadbeef', port: 9 }),
      close: async () => {},
      done: Promise.resolve(),
      token: 'deadbeef',
    }),
  });
  t.after(() => api.close());
  const server = createWatchServer({
    root: fx.home,
    assetDir,
    deltaFile,
    idleMs: 600000,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: async () => ({ runs: [] }),
    board: api,
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
  });
  await server.listen();
  const auth = { 'x-watch-token': server.token };
  const port = Number(new URL(server.url).port);
  t.after(async () => { await server.close(); await api.close(); });

  const history = JSON.parse((await httpGet(port, '/api/history?scratch=1', auth)).body);
  assert.ok(history.events.length > 0, 'non-spend history events remain');
  assert.equal(history.events.some(e => e.kind === 'spend'), false, 'spend rows are omitted');
  assertNoMoney(history, '/api/history');

  const csv = await httpGet(port, '/history.csv?scratch=1', auth);
  assertBodyNoDollars(csv.body, '/history.csv');
  assert.doesNotMatch(csv.body.split('\n')[0], /usd/i, 'CSV header has no money column');
  assert.equal(csv.body.split('\n').some(line => /,spend,/.test(line)), false, 'CSV has no spend rows');
  assert.doesNotMatch(csv.body, /\b9\.99\b/, 'CSV has no dollar amounts from the fixture');
});

test('every board browser script avoids money output patterns', async () => {
  const names = (await fs.readdir(assetDir)).filter(n => n.endsWith('.js')).sort();
  assert.ok(names.length > 0);
  for (const name of names) {
    const source = await fs.readFile(path.join(assetDir, name), 'utf8');
    for (const [re, label] of SOURCE_FORBIDDEN) {
      assert.doesNotMatch(source, re, `${name}: ${label}`);
    }
  }
});

test('run API and per-run Watch payloads strip money from snapshots and SSE', async t => {
  const fx = await fixture(t);
  const NOW = Date.parse('2026-10-21T12:05:00.000Z');
  const state = JSON.parse(await fs.readFile(path.join(fx.root, '.swarm/runs/run-paid/state.json'), 'utf8'));
  let snapshot = buildRunSnapshot(state, { now: NOW });
  snapshot.project = { noCap: false, reached: false, capUsd: 100 };
  const api = createBoardApi({ env: fx.env, now: () => NOW, live: async () => [], cacheMs: 0 });
  t.after(() => api.close());
  const server = createWatchServer({
    root: fx.home,
    assetDir,
    deltaFile,
    idleMs: 600000,
    getRunSnapshot: async () => snapshot,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: async () => ({ runs: [] }),
    board: api,
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
  });
  await server.listen();
  const token = server.token;
  const port = Number(new URL(server.url).port);
  const auth = { 'x-watch-token': token };
  t.after(async () => { await server.close(); await api.close(); });

  const runDetail = JSON.parse((await httpGet(port, `/api/run?id=${fx.project.id}&run=run-paid`, auth)).body);
  assertNoMoney(runDetail, 'api/run');

  const snap = JSON.parse((await httpGet(port, '/api/snapshot', auth)).body);
  assertNoMoney(snap, 'api/snapshot');
  assert.equal(snap.run?.project?.noCap, false);

  const stream = await openSse(port, '/events', auth);
  t.after(() => stream.req.destroy());
  await waitFor(stream.events, () => stream.events.some(e => e.event === 'snapshot'));
  assertNoMoney(stream.events.find(e => e.event === 'snapshot').data, 'events/snapshot');

  snapshot = buildRunSnapshot({ ...state, status: 'complete', finishedAt: new Date(NOW).toISOString() }, { now: NOW });
  snapshot.project = { noCap: true };
  await waitFor(stream.events, () => stream.events.some(e => e.event === 'delta'));
  const delta = stream.events.find(e => e.event === 'delta');
  assertNoMoney(delta.data, 'events/delta');
});
