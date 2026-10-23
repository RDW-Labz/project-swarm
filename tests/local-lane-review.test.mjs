// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLocalLaneBlock } from '../tools/local-lane.mjs';
import { resolveLanes, claimLaneSlots, releaseLaneSlots, lanesDir, withLaneStore } from '../tools/lanes.mjs';
import { routeJob } from '../tools/router.mjs';
import { executeApi, probeLocalProvider } from '../tools/api-adapters.mjs';

const keychain = { service: 'project-swarm', account: 'local.test' };
const loopbackEp = (name, port, slots = 1) => ({
  name,
  baseUrl: `http://127.0.0.1:${port}`,
  model: 'm',
  slots,
  keychain,
});
const remoteEp = (name, slots = 1) => ({
  name,
  baseUrl: 'https://gpu.example.com',
  model: 'm',
  slots,
  keychain,
});

test('claimLaneSlots tags each granted slot with its waiter endpoint and agency limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-slots-'));
  const locals = [
    { endpoint: 'fast', slotsLimit: 1, agency: false, agencyConcurrency: 1 },
    { endpoint: 'docs', slotsLimit: 3, agency: true, agencyConcurrency: 1 },
    { endpoint: 'docs', slotsLimit: 3, agency: true, agencyConcurrency: 1 },
    { endpoint: 'docs', slotsLimit: 3, agency: true, agencyConcurrency: 1 },
  ];
  const claim = await claimLaneSlots({
    dir,
    agent: 'local',
    concurrency: 6,
    count: 4,
    local: locals,
  });
  assert.equal(claim.granted.length, 2, 'only one fast slot and one agency docs slot');
  const store = await withLaneStore(s => s, { dir });
  const held = store.slots.local ?? [];
  assert.equal(held.length, 2);
  assert.equal(held.filter(s => s.localEndpoint === 'fast').length, 1);
  assert.equal(held.filter(s => s.localEndpoint === 'docs').length, 1);
  assert.equal(held.filter(s => s.localAgency).length, 1);
  await releaseLaneSlots({ dir, slots: claim.granted.map(id => ({ agent: 'local', slotId: id })) });
});

test('claimLaneSlots counts slots granted earlier in the same claim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-batch-'));
  const local = { endpoint: 'dev2', slotsLimit: 2, agency: false, agencyConcurrency: 1 };
  const claim = await claimLaneSlots({ dir, agent: 'local', concurrency: 2, count: 2, local });
  assert.equal(claim.granted.length, 2);
  await releaseLaneSlots({ dir, slots: claim.granted.map(id => ({ agent: 'local', slotId: id })) });
});

test('manifest local endpoints and agencyConcurrency are ignored for routing limits', () => {
  const config = {
    lanes: {
      local: {
        endpoints: [loopbackEp('real', 18000, 2)],
        agencyConcurrency: 2,
      },
    },
  };
  const manifest = {
    lanes: {
      local: {
        endpoints: [remoteEp('evil', 99)],
        agencyConcurrency: 64,
      },
    },
  };
  const lanes = resolveLanes({ config, manifest });
  assert.equal(lanes.local.endpoints.length, 1);
  assert.equal(lanes.local.endpoints[0].name, 'real');
  assert.equal(lanes.local.agencyConcurrency, 2);
  assert.throws(() => validateLocalLaneBlock({ agencyConcurrency: 0 }), /agencyConcurrency/);
});

test('sensitive jobs skip non-loopback local endpoints in routing', () => {
  const lanes = resolveLanes({
    config: {
      lanes: {
        local: {
          endpoints: [remoteEp('remote', 2), loopbackEp('home', 18001, 2)],
        },
      },
    },
  });
  const docs = { id: 'd1', agent: 'auto', type: 'docs', sensitive: true, outputs: ['README.md'] };
  const route = routeJob(docs, { lanes, failures: { cursor: 9, codex: 9, anthropic: 9 } });
  assert.equal(route.agent, 'local');
  assert.equal(route.model, 'local:home');
  const onlyRemote = resolveLanes({
    config: { lanes: { local: { endpoints: [remoteEp('remote')] } } },
  });
  assert.throws(
    () => routeJob(docs, { lanes: onlyRemote, failures: { cursor: 9, codex: 9, anthropic: 9 } }),
    { code: 'route-exhausted' },
  );
});

test('executeApi refuses sensitive jobs on non-loopback local endpoints', async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [remoteEp('remote')] } },
  }));
  const result = await executeApi(
    { id: 's1', agent: 'local', model: 'local:remote', prompt: 'x', context: [], outputs: [] },
    [],
    { env: { SWARM_CONFIG: configPath }, readLocal: () => 'token' },
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error, /sensitive-provider/);
});

test('executeApi local fetch uses redirect error', async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [loopbackEp('dev2', 18000)] } },
  }));
  let seen;
  await executeApi(
    { id: 's2', agent: 'local', model: 'local:dev2', sensitive: false, prompt: 'x', context: [], outputs: [] },
    [],
    {
      env: { SWARM_CONFIG: configPath },
      readLocal: () => 'token',
      fetchImpl: async (url, init) => {
        seen = init;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new Response(JSON.stringify({
            model: 'm',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'ok', files: [], edits: [] }) } }],
          })).body,
        };
      },
    },
  );
  assert.equal(seen.redirect, 'error');
});

test('probeLocalProvider handles local doctor without endpoint field', async () => {
  const report = await probeLocalProvider('local', {}, { fetchImpl: async () => ({ ok: false, status: 503, body: { cancel: async () => {} } }) });
  assert.equal(report.agent, 'local');
  assert.equal(report.configured, false);
});
