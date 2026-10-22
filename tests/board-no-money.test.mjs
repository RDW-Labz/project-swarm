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
import { createWatchServer } from '../tools/watch-server.mjs';
import { buildRunSnapshot } from '../tools/watch-state.mjs';

const MONEY_KEY = /usd|Usd|USD|cost|Cost|billed|Billed|listValue|flatRate|price|Price|spend|Spend|budget|Budget/;
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
    if (typeof value === 'string') assert.doesNotMatch(value, /\$\d/, at);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, MONEY_KEY, `${at}.${key}`);
    assert.notEqual(key, 'cap', `${at}.${key}`);
    assert.notEqual(key, 'caps', `${at}.${key}`);
    assertNoMoney(child, `${at}.${key}`);
  }
}

async function fixture(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-no-money-')));
  const root = path.join(home, 'parts-request-app');
  await fs.mkdir(path.join(root, '.swarm/runs/run-paid'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/run-paid/state.json'), JSON.stringify({
    id: 'run-paid', status: 'running', startedAt: '2026-10-21T12:00:00.000Z',
    jobs: [{ id: 'T-1', agent: 'anthropic', model: 'claude', status: 'complete', costUsd: 2.5, usage: { total_tokens: 100 }, durationMs: 4000 }],
  }));
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
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, root, project, env };
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openSse(port, pathname) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Accept: 'text/event-stream' } }, res => {
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

test('watch board, project and live responses contain no money-shaped keys or dollar figures', async t => {
  const fx = await fixture(t);
  const api = createBoardApi({
    env: fx.env,
    now: () => Date.parse('2026-10-21T12:00:00.000Z'),
    live: async () => [{ runId: 'run-paid', root: fx.root, startedAt: '2026-10-21T12:00:00.000Z' }],
    cacheMs: 0,
  });
  t.after(() => api.close());
  for (const [name, response] of [
    ['board', await api.snapshot({ scratch: true, t: 'test-token' })],
    ['project', await api.project(fx.project.id)],
    ['live', await api.live(fx.project.id)],
  ]) {
    assert.ok(response, `${name} response exists`);
    assertNoMoney(response, name);
  }
});

test('stripMoney deep-copies and removes money objects while preserving non-money text', () => {
  const input = { ok: 1, capBasis: 'billed+list', spend: { usd: 3 }, cost: { total: 3 }, cap: { maxUsd: 4 }, nested: [{ price: 2, label: 'jobs' }] };
  const output = stripMoney(input);
  assert.deepEqual(output, { ok: 1, capBasis: 'billed+list', nested: [{ label: 'jobs' }] });
  assert.equal(input.spend.usd, 3, 'the response source is not mutated');
});

test('a project cap still refuses a new run after spend is recorded', async t => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.root, '.project-swarm.json'), JSON.stringify({ profile: { budget: { projectMaxUsd: 1 } } }));
  const decision = await checkProjectCap(fx.root, { env: fx.env });
  assert.ok(decision, 'the cap refuses the run');
  assert.match(decision.message, /project-cap/);
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
  t.after(async () => { await server.close(); await api.close(); });

  const runDetail = JSON.parse((await httpGet(port, `/api/run?id=${fx.project.id}&run=run-paid&t=${token}`)).body);
  assertNoMoney(runDetail, 'api/run');

  const snap = JSON.parse((await httpGet(port, `/api/snapshot?t=${token}`)).body);
  assertNoMoney(snap, 'api/snapshot');

  const stream = await openSse(port, `/events?t=${token}`);
  t.after(() => stream.req.destroy());
  await waitFor(stream.events, () => stream.events.some(e => e.event === 'snapshot'));
  assertNoMoney(stream.events.find(e => e.event === 'snapshot').data, 'events/snapshot');

  snapshot = buildRunSnapshot({ ...state, status: 'complete', finishedAt: new Date(NOW).toISOString() }, { now: NOW });
  await waitFor(stream.events, () => stream.events.some(e => e.event === 'delta'));
  assertNoMoney(stream.events.find(e => e.event === 'delta').data, 'events/delta');
});
