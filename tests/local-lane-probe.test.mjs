// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeLocalEndpoint,
  verifyLocalEndpointKey,
  doctorLocal,
  probeLocalEndpointsBeforeRoute,
  createLocalEndpointPauseTracker,
} from '../tools/local-lane.mjs';
import { resolveLanes } from '../tools/lanes.mjs';
import { routeJob } from '../tools/router.mjs';

const endpoint = {
  name: 'dev2',
  model: 'demo-model',
  slots: 2,
  baseUrl: 'http://127.0.0.1:18000',
  modelsUrl: 'http://127.0.0.1:18000/v1/models',
  keychain: { service: 'project-swarm', account: 'local.dev2' },
};

function mockResponse(status) {
  return { ok: status >= 200 && status < 300, status, body: { cancel: async () => {} } };
}

test('probeLocalEndpoint classifies HTTP statuses without sending a key', async () => {
  const cases = [
    { status: 200, statusLabel: 'ok', reachable: true, liveVerified: true },
    { status: 401, statusLabel: 'ok-auth-required', reachable: true, liveVerified: false },
    { status: 403, statusLabel: 'ok-auth-required', reachable: true, liveVerified: false },
    { status: 404, statusLabel: 'ok-unverified', reachable: false, liveVerified: false },
    { status: 405, statusLabel: 'ok-unverified', reachable: false, liveVerified: false },
    { status: 500, statusLabel: 'unreachable', reachable: false, liveVerified: false },
  ];
  for (const item of cases) {
    let auth;
    const result = await probeLocalEndpoint(endpoint, {
      now: () => 0,
      fetchImpl: async (url, init) => {
        assert.equal(url, endpoint.modelsUrl);
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        auth = init.headers?.authorization;
        return mockResponse(item.status);
      },
    });
    assert.equal(auth, undefined);
    assert.equal(result.status, item.statusLabel);
    assert.equal(result.reachable, item.reachable);
    assert.equal(result.liveVerified, item.liveVerified);
    assert.equal(result.httpStatus, item.status);
  }
});

test('probeLocalEndpoint timeout is unreachable', async () => {
  const result = await probeLocalEndpoint(endpoint, {
    timeoutMs: 10,
    now: () => 0,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(result.reachable, false);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.httpStatus, null);
});

test('401 reachable does not pause routing health tracker', async () => {
  const tracker = createLocalEndpointPauseTracker({ now: () => 1_000 });
  await probeLocalEndpointsBeforeRoute([endpoint], tracker, {
    fetchImpl: async () => mockResponse(401),
    now: () => 1_000,
  });
  assert.equal(tracker.health('dev2').state, 'ok');
});

test('verifyLocalEndpointKey accepts 2xx and rejects 401 without leaking secret', async () => {
  const secret = ['probe', 'key', 'material'].join('-');
  let seenAuth;
  const ok = await verifyLocalEndpointKey(endpoint, {}, {
    readKey: () => secret,
    fetchImpl: async (url, init) => {
      seenAuth = init.headers?.authorization;
      assert.equal(init.redirect, 'error');
      return mockResponse(200);
    },
    now: () => 0,
  });
  assert.equal(seenAuth, `Bearer ${secret}`);
  assert.equal(ok.liveVerified, true);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.keyStatus, 'accepted');

  const rejected = await verifyLocalEndpointKey(endpoint, {}, {
    readKey: () => secret,
    fetchImpl: async () => mockResponse(401),
    now: () => 0,
  });
  assert.equal(rejected.liveVerified, false);
  assert.equal(rejected.status, 'key-rejected');
  assert.equal(rejected.note, 'key rejected');
  const blob = JSON.stringify(rejected);
  assert.ok(!blob.includes(secret));
});

test('verifyLocalEndpointKey blocks non-loopback http before key read or fetch', async () => {
  const remote = {
    ...endpoint,
    name: 'remote',
    baseUrl: 'http://192.168.1.50:8000',
    modelsUrl: 'http://192.168.1.50:8000/v1/models',
  };
  let readCalls = 0;
  let fetchCalls = 0;
  const result = await verifyLocalEndpointKey(remote, {}, {
    readKey: () => {
      readCalls += 1;
      return 'must-not-read';
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return mockResponse(200);
    },
  });
  assert.equal(readCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(result.keyStatus, 'key-blocked');
  assert.equal(result.status, 'key-blocked');
});

test('doctorLocal health cache marks key-rejected endpoints unhealthy', async () => {
  const configPath = process.env.SWARM_CONFIG;
  const fs = await import('node:fs');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: {
      local: {
        endpoints: [{
          name: 'dev2',
          baseUrl: 'http://127.0.0.1:18000',
          model: 'demo-model',
          slots: 1,
          keychain: { service: 'project-swarm', account: 'local.dev2' },
        }],
      },
    },
  }));
  const cache = new Map();
  await doctorLocal({ SWARM_CONFIG: configPath }, {
    verifyKey: true,
    healthCache: cache,
    readKey: () => 'bad-key',
    fetchImpl: async (url, init) => {
      if (init.headers?.authorization) return mockResponse(401);
      return mockResponse(401);
    },
    now: () => 0,
  });
  assert.equal(cache.get('dev2'), false);
});

test('sensitive jobs never route to non-loopback local endpoints even when health is ok', () => {
  const keychain = { service: 'project-swarm', account: 'local.test' };
  const lanes = resolveLanes({
    config: {
      lanes: {
        local: {
          endpoints: [
            { name: 'remote', baseUrl: 'https://gpu.example.com', model: 'm', slots: 2, keychain },
            { name: 'home', baseUrl: 'http://127.0.0.1:18001', model: 'm', slots: 2, keychain },
          ],
        },
      },
    },
  });
  const job = { id: 'sens-1', agent: 'auto', type: 'docs', sensitive: true, outputs: ['README.md'] };
  const route = routeJob(job, {
    lanes,
    failures: { cursor: 9, codex: 9, anthropic: 9 },
    endpointHealth: () => ({ state: 'ok' }),
  });
  assert.equal(route.agent, 'local');
  assert.equal(route.model, 'local:home');
});

test('doctorLocal with verifyKey sets liveVerified from keyed probe', async () => {
  const configPath = process.env.SWARM_CONFIG;
  const fs = await import('node:fs');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: {
      local: {
        endpoints: [{
          name: 'dev2',
          baseUrl: 'http://127.0.0.1:18000',
          model: 'demo-model',
          slots: 1,
          keychain: { service: 'project-swarm', account: 'local.dev2' },
        }],
      },
    },
  }));
  const secret = 'verify-only-token';
  const report = await doctorLocal({ SWARM_CONFIG: configPath }, {
    verifyKey: true,
    readKey: () => secret,
    fetchImpl: async (url, init) => {
      if (init.headers?.authorization) return mockResponse(200);
      return mockResponse(401);
    },
    now: () => 0,
  });
  assert.equal(report.status, 'reachable');
  assert.equal(report.liveVerified, true);
  assert.equal(report.endpoints[0].status, 'ok');
  assert.equal(report.endpoints[0].reachable, true);
  assert.ok(!JSON.stringify(report).includes(secret));
});
