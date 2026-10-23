// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { createWatchServer, formatRunLocationMessage, resolveBoardRun } from '../tools/watch-server.mjs';
import { projectId } from '../tools/projects.mjs';
import { addPeer } from '../tools/board-peers.mjs';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();
const assets = fileURLToPath(new URL('../tools/watch-assets', import.meta.url));
const deltaFile = fileURLToPath(new URL('../tools/watch-delta.mjs', import.meta.url));

async function tmp(t) {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'board-run-fed-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

async function writeRun(root, runId, jobs = 1) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    id: runId,
    status: 'complete',
    startedAt: iso(NOW - 10000),
    finishedAt: iso(NOW),
    jobs: Array.from({ length: jobs }, (_, i) => ({
      id: `job-${i}`,
      agent: 'claude',
      model: 'sonnet',
      status: 'complete',
      queuedAt: iso(NOW - 9000),
      startedAt: iso(NOW - 8000),
      finishedAt: iso(NOW - 2000),
      durationMs: 6000,
      costUsd: 0.5,
      attempts: [{ agent: 'claude', model: 'sonnet', status: 'complete' }],
    })),
  }));
}

async function boardServer(t, { env, fetchImpl, listPeers } = {}) {
  const api = createBoardApi({
    env,
    now: () => NOW,
    live: async () => [],
    cacheMs: 0,
    ...(listPeers ? { listPeers } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const server = createWatchServer({
    root: env.SWARM_TEST_HOME,
    env,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    getBoard: async () => ({ runs: [] }),
    board: api,
    indexName: 'board.html',
    assetDir: assets,
    deltaFile,
    commandList: [],
    contextCommands: () => [],
  });
  const { url } = await server.listen();
  t.after(() => server.close());
  const token = new URL(url).searchParams.get('t');
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get(new URL(p, url), { headers: { 'x-watch-token': token, ...headers } }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
  return { server, url, token, get, api, boardToken: server.token };
}

test('formatRunLocationMessage names machine and path', () => {
  assert.equal(
    formatRunLocationMessage({ machine: 'mini-host', path: '/scratch/worktree-1', boardUrl: 'https://mini.ts.net/' }),
    'Run lives on mini-host at /scratch/worktree-1 (board: https://mini.ts.net/)',
  );
});

test('resolveBoardRun finds a run under a scratch worktree path for the registered main project', async t => {
  const home = await tmp(t);
  const scratch = path.join(home, 'scratch');
  const mainRoot = path.join(home, 'main');
  const worktree = path.join(scratch, 'worktree-job');
  await fs.mkdir(mainRoot, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await writeRun(worktree, 'scratch-only-run', 2);
  const mainProject = { id: projectId(mainRoot), name: 'main', root: mainRoot };
  const env = {
    ...process.env,
    SWARM_TEST_HOME: home,
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_SCRATCH_ROOT: scratch,
    SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'),
    SWARM_LANES_DIR: path.join(home, 'l'),
    SWARM_SPEND_DIR: path.join(home, 's'),
    SWARM_PHONE_DIR: path.join(home, 'ph'),
  };
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({
    version: 1,
    projects: [{ ...mainProject, addedAt: iso(NOW), lastSeen: iso(NOW) }],
  }));
  const api = createBoardApi({ env, now: () => NOW, live: async () => [], cacheMs: 0 });
  const resolved = await resolveBoardRun({
    board: api,
    projectId: mainProject.id,
    runId: 'scratch-only-run',
    env,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.detail.runId, 'scratch-only-run');
  assert.equal(resolved.detail.totals.jobs, 2);
  assert.equal(resolved.location.local, true);
  assert.equal(resolved.location.path, worktree);
});

test('board /api/run resolves a federated peer run instead of a generic not-found', async t => {
  const home = await tmp(t);
  const remoteHome = await tmp(t);
  const remoteRoot = path.join(remoteHome, 'remote');
  await fs.mkdir(remoteRoot, { recursive: true });
  await writeRun(remoteRoot, 'peer-run-1', 3);
  const remoteProject = { id: projectId(remoteRoot), name: 'remote', root: remoteRoot };
  const remoteEnv = {
    ...process.env,
    SWARM_TEST_HOME: remoteHome,
    SWARM_PROJECTS_FILE: path.join(remoteHome, 'projects.json'),
    SWARM_HISTORY_FILE: path.join(remoteHome, 'h.ndjson'),
    SWARM_LANES_DIR: path.join(remoteHome, 'l'),
    SWARM_SPEND_DIR: path.join(remoteHome, 's'),
    SWARM_PHONE_DIR: path.join(remoteHome, 'ph'),
  };
  await fs.writeFile(remoteEnv.SWARM_PROJECTS_FILE, JSON.stringify({
    version: 1,
    projects: [{ ...remoteProject, addedAt: iso(NOW), lastSeen: iso(NOW) }],
  }));
  const remoteBoard = await boardServer(t, { env: remoteEnv });
  const peersFile = path.join(home, 'peers.json');
  const localEnv = {
    ...process.env,
    SWARM_TEST_HOME: home,
    SWARM_PROJECTS_FILE: path.join(home, 'projects.json'),
    SWARM_PEERS_FILE: peersFile,
    SWARM_HISTORY_FILE: path.join(home, 'h.ndjson'),
    SWARM_LANES_DIR: path.join(home, 'l'),
    SWARM_SPEND_DIR: path.join(home, 's'),
    SWARM_PHONE_DIR: path.join(home, 'ph'),
  };
  await fs.writeFile(localEnv.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [] }));
  await addPeer('mini', remoteBoard.url, remoteBoard.boardToken, localEnv, home);

  const localBoard = await boardServer(t, { env: localEnv });
  const res = await localBoard.get(`/api/run?id=${remoteProject.id}&run=peer-run-1`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.runId, 'peer-run-1');
  assert.equal(body.totals.jobs, 3);
  assert.equal(body.remoteBoard, true);
  assert.equal(body.runLocation.remote, true);
  assert.equal(body.runLocation.boardUrl, remoteBoard.url);
});
