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
import { buildCommandCenterSnapshot, buildProjectCockpit } from '../tools/command-center-snapshot.mjs';

const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));

function fakeBoardPayload() {
  return {
    at: '2026-10-26T12:00:00.000Z',
    machine: {
      agents: { total: 4 },
      cost: { allUsd: 42.5 },
    },
    projects: [
      {
        id: 'alpha',
        name: 'Alpha',
        machine: 'host-a',
        parentId: null,
        agents: { total: 2, jobs: { running: 2 } },
        spend: { usd: 10 },
        card: { blocked: { needYou: 1 }, now: { buildingTickets: 3 }, next: { ready: 2, items: [{ id: 'T-1', title: 'One' }] } },
        progress: { overall: 40 },
        tickets: { byStatus: { failed: 1 } },
        orchestrator: { sessions: [{ id: 's1', state: 'working', lastAt: '2026-10-26T11:00:00.000Z' }] },
        live: [{ runId: 'run-1', status: 'running', jobs: 4, done: 1 }],
        ledger: {
          tickets: [
            { id: 'T-1', title: 'One', status: 'ready', stage: 'S1' },
            { id: 'T-2', title: 'Two', status: 'done', stage: 'S1' },
          ],
          scope: { stages: [{ id: 'S1', name: 'Stage 1' }] },
        },
      },
      {
        id: 'beta',
        name: 'Beta',
        machine: 'host-b',
        agents: { total: 2 },
        spend: { usd: 32.5 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 0 }, next: { ready: 0 } },
        progress: { overall: 80 },
        tickets: { byStatus: {} },
      },
    ],
  };
}

test('buildCommandCenterSnapshot maps labelled stats and project cards', () => {
  const snap = buildCommandCenterSnapshot(fakeBoardPayload());
  assert.equal(snap.at, '2026-10-26T12:00:00.000Z');
  assert.equal(snap.stats.projectsTotal.value, 2);
  assert.equal(snap.stats.agentsLive.source, 'machine.agents.total');
  assert.equal(snap.stats.needsYouCount.value, 1);
  assert.equal(snap.stats.spendUsd.unit, 'usd');
  const alpha = snap.projects.find(p => p.id === 'alpha');
  assert.ok(alpha.liveAgents);
  assert.ok(alpha.percentDone);
  assert.ok(alpha.ticketsBuilding);
  assert.ok(alpha.asks);
  assert.ok(alpha.out);
  assert.ok(alpha.fails);
  assert.equal(alpha.meter.value, 40);
});

test('project cards carry ledger counts by status for the Hive', () => {
  const board = fakeBoardPayload();
  board.projects[0].tickets.byStatus = { done: 2, ready: 1, blocked: 1, review: 1, cancelled: 1, proposed: 9 };
  const snap = buildCommandCenterSnapshot(board);
  const alpha = snap.projects.find(p => p.id === 'alpha');
  assert.deepEqual(alpha.ticketCounts, {
    total: 6, done: 2, ready: 1, blocked: 1, review: 1, cancelled: 1, remaining: 3,
    source: 'projects[0].tickets.byStatus',
  });
  const beta = snap.projects.find(p => p.id === 'beta');
  assert.equal(beta.ticketCounts, undefined, 'no counts: no field, not zeros');
});

test('hive extras: completions per hour, session events, lanes and pull requests', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  const board = fakeBoardPayload();
  board.machine.lanes = { cursor: { jobs24h: 7, running: 1 }, claude: 3, junk: { jobs24h: 'x' } };
  board.prs = [{ number: 5, title: 'Fix it' }, { number: 'x', title: 'bad' }];
  board.projects[0].ledger.tickets = [
    { id: 'T-1', title: 'One', status: 'done', doneAt: new Date(now - 10 * 60000).toISOString() },
    { id: 'T-2', title: 'Two', status: 'done', doneAt: new Date(now - 3 * 3600000 - 1000).toISOString() },
    { id: 'T-3', title: 'Old', status: 'done', doneAt: new Date(now - 30 * 3600000).toISOString() },
    { id: 'T-4', title: 'Look', status: 'review' },
    { id: 'T-5', title: 'Stuck', status: 'blocked' },
  ];
  const { hive } = buildCommandCenterSnapshot(board);
  assert.equal(hive.throughput24h.length, 24);
  assert.equal(hive.throughput24h[23], 1, 'newest hour is last');
  assert.equal(hive.throughput24h[20], 1, 'three full hours ago');
  assert.equal(hive.throughput24h.reduce((a, v) => a + v, 0), 2, 'completions older than 24 h are left out');
  assert.equal(hive.doneLast24h, 2);
  assert.deepEqual(hive.events.map(e => [e.kind, e.id]), [['review', 'T-4'], ['blocked', 'T-5'], ['done', 'T-1'], ['done', 'T-2'], ['pr', '#5']]);
  assert.deepEqual(hive.lanes, { cursor: { jobs24h: 7, running: 1 }, claude: { jobs24h: 3, running: 0 } });
  assert.deepEqual(hive.prs, [{ number: 5, title: 'Fix it' }]);
});

test('hive extras are left out when the board cannot back them', () => {
  const { hive } = buildCommandCenterSnapshot(fakeBoardPayload());
  assert.equal(hive.throughput24h, undefined, 'no completion times in the ledger: no chart data');
  assert.equal(hive.doneLast24h, undefined);
  assert.equal(hive.lanes, undefined);
  assert.deepEqual(hive.prs, []);
});

test('untrusted agent totals are omitted not zero-filled', () => {
  const board = fakeBoardPayload();
  board.machine.agents.total = undefined;
  const snap = buildCommandCenterSnapshot(board);
  assert.equal(Object.hasOwn(snap.stats, 'agentsLive'), false);
});

test('buildProjectCockpit returns ledger and run stream or null', () => {
  const board = fakeBoardPayload();
  const cockpit = buildProjectCockpit(board, 'alpha');
  assert.equal(cockpit.id, 'alpha');
  assert.equal(cockpit.ledger.tickets.length, 2);
  assert.equal(cockpit.sessions.length, 1);
  assert.equal(cockpit.runStream.length, 1);
  assert.equal(buildProjectCockpit(board, 'missing'), null);
});

function request({ port, reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: reqPath,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer({ commandCenter }) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-watch-'));
  await fs.writeFile(path.join(assetDir, 'board.html'), '<!doctype html><title>board</title>');
  await fs.writeFile(path.join(assetDir, 'command-center.html'), '<!doctype html><title>cc</title>');
  const board = {
    snapshot: async () => fakeBoardPayload(),
    project: async () => null,
    live: async () => null,
    history: async () => ({ events: [] }),
    historyCsv: async () => '',
    openRun: async () => null,
    run: async () => null,
  };
  const srv = createWatchServer({
    root: assetDir,
    assetDir,
    deltaFile,
    idleMs: 60000,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    board,
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
    commandCenter,
  });
  await srv.listen();
  const port = Number(new URL(srv.url).port);
  const authHeader = { 'x-watch-token': srv.token };
  return {
    port,
    authHeader,
    dispose: async () => {
      await srv.close();
      await fs.rm(assetDir, { recursive: true, force: true });
    },
  };
}

test('routes respect command center flag and board token', async () => {
  const off = await startServer({ commandCenter: false });
  try {
    let res = await request({ port: off.port, reqPath: '/command-center' });
    assert.equal(res.status, 404);
    res = await request({ port: off.port, reqPath: '/api/command-center', headers: off.authHeader });
    assert.equal(res.status, 404);
  } finally {
    await off.dispose();
  }

  const on = await startServer({ commandCenter: true });
  try {
    let res = await request({ port: on.port, reqPath: '/command-center' });
    assert.equal(res.status, 403);
    res = await request({ port: on.port, reqPath: `/command-center?t=${on.authHeader['x-watch-token']}` });
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>cc<\/title>/);

    res = await request({ port: on.port, reqPath: '/api/command-center' });
    assert.equal(res.status, 403);

    res = await request({ port: on.port, reqPath: '/api/command-center', headers: on.authHeader });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.stats.projectsTotal.value, 2);

    res = await request({ port: on.port, reqPath: '/api/command-center/project?id=alpha', headers: on.authHeader });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).id, 'alpha');

    res = await request({ port: on.port, reqPath: '/api/command-center/project?id=unknown', headers: on.authHeader });
    assert.equal(res.status, 404);
  } finally {
    await on.dispose();
  }
});
