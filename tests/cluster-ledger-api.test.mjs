// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  startClusterLedgerListener,
  stopClusterLedgerListener,
  createClusterLedgerServer,
  remoteClusterModeEnabled,
  CLUSTER_LEDGER_NODE_HEADER,
  authorizeClusterNode,
} from '../tools/cluster-ledger-api.mjs';
import { claim, readLeases } from '../tools/ledger-lease.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';

const LOGIN = 'peer@tailnet.example';
const NODE_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NODE_UNKNOWN = '11111111-2222-4333-8444-555555555555';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-ledger-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function seedTicket(root, id = 'T-9100') {
  const ledger = createLedger({
    tickets: [{
      id,
      title: 'cluster api',
      type: 'human',
      scopeRefs: [],
      size: 'S',
      risk: 'low',
      status: 'ready',
      steps: ['work'],
    }],
  });
  await writeLedger(root, ledger);
  return id;
}

function registryFor(...ids) {
  const nodes = {};
  for (const id of ids) nodes[id] = { host: 'test' };
  return { version: 1, nodes };
}

function httpJson(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        Host: `127.0.0.1:${port}`,
        'Tailscale-User-Login': LOGIN,
        [CLUSTER_LEDGER_NODE_HEADER]: NODE_A,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startTestServer(t, root, registry) {
  const server = createClusterLedgerServer({ root, registry });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return port;
}

test('listener does not start when remote cluster mode is off', async t => {
  const root = await tmp(t);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-home-off-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configFile = path.join(home, 'config.json');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, '{}\n');
  const env = { HOME: home, SWARM_CONFIG: configFile };
  assert.equal(remoteClusterModeEnabled({ env, home }), false);
  const started = await startClusterLedgerListener({ root, env, home });
  assert.equal(started, null);
  const probe = await new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(9448, '127.0.0.1', () => {
      s.close(() => resolve(true));
    });
  });
  assert.equal(probe, true, 'default port stays free when mode is off');
  await stopClusterLedgerListener();
});

test('verified node can claim, renew, release via HTTP', async t => {
  const root = await tmp(t);
  const ticketId = await seedTicket(root);
  const port = await startTestServer(t, root, registryFor(NODE_A));
  const t0 = Date.now();

  const claimed = await httpJson(port, '/api/cluster/ledger/claim', {
    method: 'POST',
    body: { ticketId, leaseTtlMs: 60_000 },
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.holderId, NODE_A);
  assert.equal(claimed.json.fencingToken, 1);

  const renewed = await httpJson(port, '/api/cluster/ledger/renew', {
    method: 'POST',
    body: { ticketId, fencingToken: 1, leaseTtlMs: 90_000 },
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.json.fencingToken, 1);

  const released = await httpJson(port, '/api/cluster/ledger/release', {
    method: 'POST',
    body: { ticketId, fencingToken: 1 },
  });
  assert.equal(released.status, 200);
  assert.equal(released.json.released, true);

  const direct = await claim(root, ticketId, NODE_A, { now: t0 + 5000, leaseTtlMs: 30_000 });
  assert.equal(direct.fencingToken, 2);
});

test('unverified or unknown node id is refused on every route', async t => {
  const root = await tmp(t);
  const ticketId = await seedTicket(root);
  const port = await startTestServer(t, root, registryFor(NODE_A));

  const routes = [
    { path: '/api/cluster/ledger/read', method: 'GET' },
    { path: '/api/cluster/ledger/claim', method: 'POST', body: { ticketId } },
    { path: '/api/cluster/ledger/renew', method: 'POST', body: { ticketId, fencingToken: 1 } },
    { path: '/api/cluster/ledger/release', method: 'POST', body: { ticketId, fencingToken: 1 } },
  ];

  for (const route of routes) {
    const noLogin = await httpJson(port, route.path, {
      method: route.method,
      headers: { 'Tailscale-User-Login': '' },
      body: route.body,
    });
    assert.equal(noLogin.status, 401, `${route.path} without tailnet login`);

    const funnel = await httpJson(port, route.path, {
      method: route.method,
      headers: { 'Tailscale-Funnel-Request': '?1' },
      body: route.body,
    });
    assert.equal(funnel.status, 401, `${route.path} with funnel`);

    const unknown = await httpJson(port, route.path, {
      method: route.method,
      headers: { [CLUSTER_LEDGER_NODE_HEADER]: NODE_UNKNOWN },
      body: route.body,
    });
    assert.equal(unknown.status, 403, `${route.path} unknown node`);
  }

  const badId = await httpJson(port, '/api/cluster/ledger/read', {
    headers: { [CLUSTER_LEDGER_NODE_HEADER]: 'not-a-uuid' },
  });
  assert.equal(badId.status, 401);
});

test('HTTP claim matches direct ledger-lease.mjs state', async t => {
  const root = await tmp(t);
  const ticketId = await seedTicket(root);
  const port = await startTestServer(t, root, registryFor(NODE_A));
  const t0 = Date.now();

  const viaApi = await httpJson(port, '/api/cluster/ledger/claim', {
    method: 'POST',
    body: { ticketId, leaseTtlMs: 45_000 },
  });
  assert.equal(viaApi.status, 200);

  const store = await readLeases(root);
  const lease = store.leases[ticketId];
  assert.equal(lease.holderId, NODE_A);
  assert.equal(lease.fencingToken, viaApi.json.fencingToken);

  await seedTicket(root, 'T-9101');
  const direct = await claim(root, 'T-9101', NODE_A, { now: t0, leaseTtlMs: 45_000 });
  const directStore = await readLeases(root);
  assert.equal(directStore.leases['T-9101'].fencingToken, direct.fencingToken);
  assert.equal(directStore.leases['T-9101'].holderId, direct.holderId);

  const read = await httpJson(port, '/api/cluster/ledger/read');
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.leases[ticketId], lease);
});

test('authorizeClusterNode is fail-closed', () => {
  const registry = registryFor(NODE_A);
  const req = { headers: { 'Tailscale-User-Login': LOGIN, [CLUSTER_LEDGER_NODE_HEADER]: NODE_A } };
  assert.equal(authorizeClusterNode(req, '127.0.0.1', registry).ok, true);
  assert.equal(authorizeClusterNode({ headers: {} }, '127.0.0.1', registry).ok, false);
});

test('listener starts when remote cluster mode is on', async t => {
  const root = await tmp(t);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-home-on-'));
  t.after(async () => {
    await stopClusterLedgerListener();
    await fs.rm(home, { recursive: true, force: true });
  });
  const configFile = path.join(home, 'config.json');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  const port = await new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  await fs.writeFile(configFile, `${JSON.stringify({ remoteClusterMode: true, clusterLedgerPort: port })}\n`);
  const env = { HOME: home, SWARM_CONFIG: configFile };
  const regFile = path.join(home, '.project-swarm', 'nodes', 'registry.json');
  await fs.mkdir(path.dirname(regFile), { recursive: true });
  await fs.writeFile(regFile, `${JSON.stringify(registryFor(NODE_A))}\n`);
  env.SWARM_HOME = path.join(home, '.project-swarm');

  const started = await startClusterLedgerListener({ root, env, home });
  assert.ok(started?.server);
  assert.equal(started.port, port);

  const health = await httpJson(port, '/api/cluster/ledger/read');
  assert.equal(health.status, 200);
});
