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

const BOARD_MARK = '<!doctype html><title>classic-board</title>';
const CC_HTML = `<!doctype html><title>command-center</title>
<script type="module" src="assets/command-center-boot.js"></script>`;

function fakeBoardPayload() {
  return {
    at: '2026-10-26T12:00:00.000Z',
    machine: {
      agents: { total: 3 },
      cost: { allUsd: 12 },
    },
    projects: [
      {
        id: 'abc',
        name: 'Abc',
        machine: 'host-a',
        agents: { total: 1 },
        spend: { usd: 5 },
        card: { blocked: { needYou: 0 }, now: { buildingTickets: 1 }, next: { ready: 0 } },
        progress: { overall: 25 },
        tickets: { byStatus: {} },
        ledger: { tickets: [], scope: { stages: [] } },
      },
    ],
  };
}

function request({ port, reqPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: reqPath,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function unknownPathResponse(port) {
  return request({ port, reqPath: '/no-such-watch-route' });
}

async function expectSameAsUnknown(port, reqPath, headers = {}) {
  const baseline = await unknownPathResponse(port);
  const res = await request({ port, reqPath, headers });
  assert.equal(res.status, baseline.status);
  assert.equal(res.body, baseline.body);
}

async function startWatchServer({ commandCenter, env } = {}) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-routes-flag-'));
  await fs.writeFile(path.join(assetDir, 'board.html'), BOARD_MARK);
  await fs.writeFile(path.join(assetDir, 'project.html'), '<!doctype html><title>project</title>');
  await fs.writeFile(path.join(assetDir, 'run.html'), '<!doctype html><title>run</title>');
  await fs.writeFile(path.join(assetDir, 'command-center.html'), CC_HTML);
  await fs.writeFile(path.join(assetDir, 'command-center-boot.js'), 'export {};\n');

  const board = {
    snapshot: async () => fakeBoardPayload(),
    project: async (id) => (id === 'abc' ? { id: 'abc', name: 'Abc' } : null),
    live: async () => null,
    history: async () => ({ events: [] }),
    historyCsv: async () => '',
    openRun: async () => null,
    run: async () => null,
  };

  const nav = {
    project: { id: 'abc', name: 'Abc' },
    runId: 'run-1',
    openBoard: async () => null,
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
    nav,
    indexName: 'board.html',
    commandList: [],
    contextCommands: () => [],
    ...(commandCenter !== undefined ? { commandCenter } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  await srv.listen();
  const port = Number(new URL(srv.url).port);
  const watchAuth = { 'x-watch-token': srv.token };
  return {
    port,
    watchAuth,
    pageQuery: () => `t=${srv.token}`,
    dispose: async () => {
      await srv.close();
      await fs.rm(assetDir, { recursive: true, force: true });
    },
  };
}

test('command center routes are absent when the flag is off', async () => {
  const off = await startWatchServer({ commandCenter: false });
  try {
    const paths = [
      '/command-center',
      '/command-center/project/abc',
      '/api/command-center',
      '/api/command-center/project?id=abc',
    ];
    for (const reqPath of paths) {
      await expectSameAsUnknown(off.port, reqPath);
      await expectSameAsUnknown(off.port, reqPath, off.watchAuth);
    }

    const homeDenied = await request({ port: off.port, reqPath: '/' });
    assert.equal(homeDenied.status, 403);

    const home = await request({ port: off.port, reqPath: `/?${off.pageQuery()}` });
    assert.equal(home.status, 200);
    assert.equal(home.body, BOARD_MARK);

    const classicDenied = await request({ port: off.port, reqPath: '/classic' });
    assert.equal(classicDenied.status, 403);
    const classic = await request({ port: off.port, reqPath: `/classic?${off.pageQuery()}` });
    assert.equal(classic.status, 200);
    assert.equal(classic.body, BOARD_MARK);
  } finally {
    await off.dispose();
  }
});

test('command center routes are on by default when env and option leave the flag unset', async () => {
  const on = await startWatchServer({ env: {} });
  try {
    const api = await request({ port: on.port, reqPath: '/api/command-center', headers: on.watchAuth });
    assert.equal(api.status, 200);
    const root = await request({ port: on.port, reqPath: `/?${on.pageQuery()}` });
    assert.match(root.body, /command-center-boot\.js/);
  } finally {
    await on.dispose();
  }
});

test('command center HTML and JSON when the flag is on', async () => {
  const on = await startWatchServer({ commandCenter: true });
  try {
    const deniedPage = await request({ port: on.port, reqPath: '/command-center' });
    const deniedRoot = await request({ port: on.port, reqPath: '/' });
    assert.equal(deniedPage.status, deniedRoot.status);
    assert.equal(deniedPage.body, deniedRoot.body);

    const hive = await request({ port: on.port, reqPath: `/command-center?${on.pageQuery()}` });
    assert.equal(hive.status, 200);
    assert.match(hive.body, /command-center-boot\.js/);

    const dashboardRoot = await request({ port: on.port, reqPath: `/?${on.pageQuery()}` });
    assert.equal(dashboardRoot.status, 200);
    assert.match(dashboardRoot.body, /command-center-boot\.js/);

    const classicDenied = await request({ port: on.port, reqPath: '/classic' });
    assert.equal(classicDenied.status, 403);
    const classic = await request({ port: on.port, reqPath: `/classic?${on.pageQuery()}` });
    assert.equal(classic.status, 200);
    assert.equal(classic.body, BOARD_MARK);

    const deniedApi = await request({ port: on.port, reqPath: '/api/command-center' });
    assert.equal(deniedApi.status, 403);

    const api = await request({ port: on.port, reqPath: '/api/command-center', headers: on.watchAuth });
    assert.equal(api.status, 200);
    const body = JSON.parse(api.body);
    assert.equal(body.stats.projectsTotal.value, 1);
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].id, 'abc');

    const cockpit = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=abc',
      headers: on.watchAuth,
    });
    assert.equal(cockpit.status, 200);
    assert.equal(JSON.parse(cockpit.body).id, 'abc');

    const missing = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=missing',
      headers: on.watchAuth,
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body, 'not found');
  } finally {
    await on.dispose();
  }
});

test('command center flag follows SWARM_COMMAND_CENTER=1 in env', async () => {
  const on = await startWatchServer({ env: { SWARM_COMMAND_CENTER: '1' } });
  try {
    const res = await request({ port: on.port, reqPath: '/api/command-center', headers: on.watchAuth });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).stats.projectsTotal.value, 1);
  } finally {
    await on.dispose();
  }
});

test('command center project paths reject unsafe ids', async () => {
  const on = await startWatchServer({ commandCenter: true });
  try {
    const badPaths = [
      '/command-center/project/a/b',
      `/command-center/project/${encodeURIComponent('..')}`,
      '/command-center/project/x%2Fy',
    ];
    for (const reqPath of badPaths) {
      await expectSameAsUnknown(on.port, `${reqPath}?${on.pageQuery()}`);
    }

    const slashApi = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=a%2Fb',
      headers: on.watchAuth,
    });
    assert.equal(slashApi.status, 404);

    const dotApi = await request({
      port: on.port,
      reqPath: '/api/command-center/project?id=..',
      headers: on.watchAuth,
    });
    assert.equal(dotApi.status, 404);

    const ok = await request({
      port: on.port,
      reqPath: `/command-center/project/abc?${on.pageQuery()}`,
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /command-center-boot\.js/);
  } finally {
    await on.dispose();
  }
});

test('classic board routes stay the same with the flag on or off', async () => {
  const off = await startWatchServer({ commandCenter: false });
  const on = await startWatchServer({ commandCenter: true });
  try {
    for (const ctx of [off, on]) {
      const projectDenied = await request({ port: ctx.port, reqPath: '/project' });
      assert.equal(projectDenied.status, 403);
      const project = await request({ port: ctx.port, reqPath: `/project?${ctx.pageQuery()}` });
      assert.equal(project.status, 200);
      assert.match(project.body, /<title>project<\/title>/);

      const runDenied = await request({ port: ctx.port, reqPath: '/run' });
      assert.equal(runDenied.status, 403);
      const run = await request({ port: ctx.port, reqPath: `/run?${ctx.pageQuery()}` });
      assert.equal(run.status, 200);
      assert.match(run.body, /<title>run<\/title>/);
    }

    const offHome = await request({ port: off.port, reqPath: `/?${off.pageQuery()}` });
    assert.equal(offHome.body, BOARD_MARK);
    const offClassic = await request({ port: off.port, reqPath: `/classic?${off.pageQuery()}` });
    assert.equal(offClassic.body, BOARD_MARK);

    const onRoot = await request({ port: on.port, reqPath: `/?${on.pageQuery()}` });
    assert.match(onRoot.body, /command-center-boot\.js/);
    const onClassic = await request({ port: on.port, reqPath: `/classic?${on.pageQuery()}` });
    assert.equal(onClassic.body, BOARD_MARK);
  } finally {
    await off.dispose();
    await on.dispose();
  }
});
