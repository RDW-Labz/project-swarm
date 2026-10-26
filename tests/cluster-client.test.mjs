// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLUSTER_LEDGER_NODE_HEADER,
  CLUSTER_LEDGER_SIGNATURE_HEADER,
  CLUSTER_LEDGER_TIMESTAMP_HEADER,
  clusterLedgerAuthHeaders,
} from '../tools/cluster-ledger-api.mjs';
import {
  CLUSTER_LEDGER_CLAIM_PATH,
  CLUSTER_LEDGER_READ_PATH,
  clusterLedgerRemoteFetch,
  followerRemoteClusterConfigured,
  remoteClusterClaim,
  remoteClusterRead,
  resolveClusterCanonicalHost,
} from '../tools/cluster-client.mjs';

const NODE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SECRET = 'aa'.repeat(32);

async function isolatedHome(t, config) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cluster-client-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configFile = path.join(home, '.swarm', 'config.json');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, `${JSON.stringify(config)}\n`);
  const env = { HOME: home, SWARM_CONFIG: configFile };
  return { env, home };
}

async function seedNodeIdentity(home, env, { nodeId = NODE_ID, secret = SECRET } = {}) {
  const install = path.join(home, '.project-swarm');
  await fs.mkdir(path.join(install, 'nodes'), { recursive: true });
  await fs.writeFile(path.join(install, 'nodes', 'self'), `${nodeId}\n`);
  await fs.writeFile(
    path.join(install, 'nodes', 'registry.json'),
    `${JSON.stringify({ version: 1, nodes: { [nodeId]: { secret } } })}\n`,
  );
  return { ...env, SWARM_HOME: install };
}

function listenMock(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      t.after(
        () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      );
      resolve({ server, port });
    });
  });
}

test('remoteClusterClaim returns parsed lease from mocked HTTP server', async t => {
  const lease = {
    ticketId: 'T-100',
    holderId: NODE_ID,
    fencingToken: 3,
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
  const { port } = await listenMock(t, (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, CLUSTER_LEDGER_CLAIM_PATH);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lease));
  });

  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: port });
  const fullEnv = await seedNodeIdentity(home, env);

  const result = await remoteClusterClaim('T-100', { leaseTtlMs: 60_000, env: fullEnv, home });
  assert.deepEqual(result, lease);
});

test('network failure and non-2xx reject without local ledger fallback', async t => {
  const { port } = await listenMock(t, (_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unavailable', message: 'down' }));
  });

  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: port });
  const fullEnv = await seedNodeIdentity(home, env);

  await assert.rejects(
    () => remoteClusterClaim('T-200', { env: fullEnv, home }),
    err => err.status === 503 && err.code === 'unavailable',
  );

  const { env: env2, home: home2 } = await isolatedHome(t, {
    clusterCanonicalHost: '127.0.0.1',
    clusterLedgerPort: 1,
  });
  const fullEnv2 = await seedNodeIdentity(home2, env2);
  await assert.rejects(
    () => remoteClusterClaim('T-201', { env: fullEnv2, home: home2 }),
    err => err.code === 'cluster-request-failed',
  );

  const clientSource = await fs.readFile(new URL('../tools/cluster-client.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(clientSource, /ledger-lease/);
  assert.doesNotMatch(clientSource, /readLeases/);
});

test('requests include HMAC auth headers matching clusterLedgerAuthHeaders', async t => {
  const signAt = 1_700_000_000_000;
  let captured = null;
  const { port } = await listenMock(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    captured = {
      method: req.method,
      path: req.url,
      nodeId: req.headers[CLUSTER_LEDGER_NODE_HEADER.toLowerCase()],
      timestamp: req.headers[CLUSTER_LEDGER_TIMESTAMP_HEADER.toLowerCase()],
      signature: req.headers[CLUSTER_LEDGER_SIGNATURE_HEADER.toLowerCase()],
      rawBody,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 1, leases: {}, maxTokenByTicket: {} }));
  });

  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: port });
  const fullEnv = await seedNodeIdentity(home, env);

  await remoteClusterRead({ env: fullEnv, home, now: signAt });

  assert.ok(captured);
  assert.equal(captured.method, 'GET');
  assert.equal(captured.path, '/api/cluster/ledger/read');
  assert.equal(captured.nodeId, NODE_ID);
  assert.equal(captured.rawBody, '');

  const expected = clusterLedgerAuthHeaders(SECRET, 'GET', '/api/cluster/ledger/read', '', { now: signAt });
  assert.equal(captured.timestamp, expected[CLUSTER_LEDGER_TIMESTAMP_HEADER]);
  assert.equal(captured.signature, expected[CLUSTER_LEDGER_SIGNATURE_HEADER]);
});

test('followerRemoteClusterConfigured follows clusterCanonicalHost', async t => {
  const off = await isolatedHome(t, {});
  assert.equal(followerRemoteClusterConfigured({ env: off.env, home: off.home }), false);
  assert.equal(resolveClusterCanonicalHost({ env: off.env, home: off.home }), undefined);

  const on = await isolatedHome(t, { clusterCanonicalHost: 'canonical.tailnet.example' });
  assert.equal(followerRemoteClusterConfigured({ env: on.env, home: on.home }), true);
  assert.equal(resolveClusterCanonicalHost({ env: on.env, home: on.home }), 'canonical.tailnet.example');

  const blank = await isolatedHome(t, { clusterCanonicalHost: '   ' });
  assert.equal(followerRemoteClusterConfigured({ env: blank.env, home: blank.home }), false);
});

test('AbortSignal.timeout on real fetch rejects with cluster-request-timeout', async t => {
  const { port } = await listenMock(t, (req, res) => {
    // Never call res.end() — stall until the client aborts; tear down socket when it does.
    req.once('close', () => {
      if (!res.writableEnded) res.destroy();
    });
  });

  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: port });
  const fullEnv = await seedNodeIdentity(home, env);

  await assert.rejects(
    () =>
      clusterLedgerRemoteFetch(CLUSTER_LEDGER_READ_PATH, {
        env: fullEnv,
        home,
        timeoutMs: 50,
      }),
    err => err.code === 'cluster-request-timeout',
  );
});

test('HTTP redirect responses are not followed', async t => {
  const { port } = await listenMock(t, (_req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:9/steal' });
    res.end();
  });

  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: port });
  const fullEnv = await seedNodeIdentity(home, env);

  await assert.rejects(
    () => remoteClusterRead({ env: fullEnv, home }),
    err => err.code === 'cluster-request-failed',
  );
});

test('malicious clusterCanonicalHost is rejected before any request', async t => {
  let fetchCalled = false;
  const fetchSpy = () => {
    fetchCalled = true;
    return Promise.resolve({ ok: true, text: async () => '{}' });
  };

  for (const badHost of ['trusted@evil.example', 'evil.example/extra', 'evil:bad']) {
    const { env, home } = await isolatedHome(t, { clusterCanonicalHost: badHost, clusterLedgerPort: 9448 });
    const fullEnv = await seedNodeIdentity(home, env);
    fetchCalled = false;
    await assert.rejects(
      () => clusterLedgerRemoteFetch(CLUSTER_LEDGER_READ_PATH, { env: fullEnv, home, fetch: fetchSpy }),
      err => err.code === 'cluster-host-invalid',
    );
    assert.equal(fetchCalled, false);
  }
});

test('malformed node registry does not leak file contents in errors', async t => {
  const secretSnippet = 'super-secret-token-xyz-12345';
  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: 9448 });
  const install = path.join(home, '.project-swarm');
  await fs.mkdir(path.join(install, 'nodes'), { recursive: true });
  await fs.writeFile(path.join(install, 'nodes', 'self'), `${NODE_ID}\n`);
  await fs.writeFile(path.join(install, 'nodes', 'registry.json'), `{ not json and ${secretSnippet}\n`);
  const fullEnv = { ...env, SWARM_HOME: install };

  await assert.rejects(
    () => clusterLedgerRemoteFetch(CLUSTER_LEDGER_READ_PATH, { env: fullEnv, home }),
    err => {
      assert.equal(err.code, 'cluster-registry-invalid');
      assert.equal(err.message, 'cluster-client: node registry is invalid or unreadable');
      assert.equal(err.cause, undefined);
      assert.doesNotMatch(String(err.message), new RegExp(secretSnippet));
      return true;
    },
  );
});

test('weak node signing secret is rejected', async t => {
  const { port } = await listenMock(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 1, leases: {}, maxTokenByTicket: {} }));
  });

  const { env, home } = await isolatedHome(t, { clusterCanonicalHost: '127.0.0.1', clusterLedgerPort: port });
  const fullEnv = await seedNodeIdentity(home, env, { secret: 'changeme' });

  await assert.rejects(
    () => remoteClusterRead({ env: fullEnv, home }),
    err => err.code === 'cluster-node-unregistered',
  );
});
