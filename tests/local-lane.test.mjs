// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSecrets } from '../tools/security-scan.mjs';
import { validateLocalLaneBlock, readLocalCredential, mapLocalUsage, probeLocalEndpoint, doctorLocal, isAgencyLocalJob } from '../tools/local-lane.mjs';
import { resolveLanes, claimLaneSlots, releaseLaneSlots, lanesDir } from '../tools/lanes.mjs';
import { routeJob } from '../tools/router.mjs';
import { executeApi, apiDoctor } from '../tools/api-adapters.mjs';

const endpointFixture = (over = {}) => ({
  name: 'dev2',
  baseUrl: 'http://127.0.0.1:18000',
  model: 'demo-model',
  slots: 3,
  keychain: { service: 'project-swarm', account: 'local.dev2' },
  ...over,
});

const bearerValue = () => ['fake', 'local', 'value'].join('-');

test('config validation rejects inline credential fields', () => {
  assert.throws(
    () => validateLocalLaneBlock({ endpoints: [{ ...endpointFixture(), apiKey: 'nope' }] }),
    /must not contain/,
  );
});

test('readLocalCredential uses injected reader and never appears in doctor errors', async () => {
  const material = bearerValue();
  const cred = readLocalCredential(endpointFixture(), {}, {
    platform: 'linux',
    readKey: () => material,
  });
  assert.equal(cred, material);
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-lane-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ lanes: { local: { endpoints: [endpointFixture()] } } }));
  const doctor = await doctorLocal({ SWARM_CONFIG: configPath }, {
    fetchImpl: async () => ({ ok: false, status: 503, body: { cancel: async () => {} } }),
    readKey: () => material,
  });
  const blob = JSON.stringify(doctor);
  assert.ok(!blob.includes(material));
});

test('executeApi local request shape, usage mapping, and zero cost', async () => {
  const material = bearerValue();
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-lane-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [endpointFixture()] } },
  }));
  const env = { SWARM_CONFIG: configPath };
  const answer = { summary: 'ok', files: [], edits: [] };
  let seen;
  const result = await executeApi(
    { id: 'j1', agent: 'local', model: 'local:dev2', prompt: 'hi', context: [], outputs: [] },
    [],
    {
      env,
      readLocal: () => material,
      fetchImpl: async (url, init) => {
        seen = { url, init, body: JSON.parse(init.body) };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new Response(JSON.stringify({
            model: 'demo-model',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          })).body,
        };
      },
    },
  );
  assert.equal(result.status, 'complete');
  assert.equal(result.costUsd, 0);
  assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7 });
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.temperature, 0.2);
  assert.equal(seen.init.headers.authorization, `Bearer ${material}`);
  assert.ok(!seen.init.body.includes(material));
  assert.equal(seen.body.model, 'demo-model');
});

test('failed local job omits bearer material from error text', async () => {
  const material = bearerValue();
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-lane-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [endpointFixture()] } },
  }));
  const env = { SWARM_CONFIG: configPath };
  const result = await executeApi(
    { id: 'j2', agent: 'local', model: 'local:dev2', prompt: 'hi', context: [], outputs: [] },
    [],
    {
      env,
      readLocal: () => material,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        body: new Response(`Bearer ${material} rejected`).body,
      }),
    },
  );
  assert.equal(result.status, 'failed');
  assert.ok(!result.error.includes(material));
});

test('slot cap and agencyConcurrency on shared lane store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-lane-slots-'));
  const env = { SWARM_LANES_DIR: dir };
  const local = { endpoint: 'dev2', slotsLimit: 1, agency: true, agencyConcurrency: 1 };
  const first = await claimLaneSlots({ dir: lanesDir(env), agent: 'local', concurrency: 3, count: 1, local });
  assert.equal(first.granted.length, 1);
  const second = await claimLaneSlots({ dir: lanesDir(env), agent: 'local', concurrency: 3, count: 1, local });
  assert.equal(second.granted.length, 0);
  await releaseLaneSlots({ dir: lanesDir(env), slots: first.granted.map(id => ({ agent: 'local', slotId: id })) });
  const third = await claimLaneSlots({ dir: lanesDir(env), agent: 'local', concurrency: 3, count: 1, local: { ...local, agency: false } });
  assert.equal(third.granted.length, 1);
});

test('doctor probe times out without hanging', async () => {
  const ep = {
    name: 'dev2',
    model: 'demo-model',
    slots: 3,
    modelsUrl: 'http://127.0.0.1:9/models',
  };
  const started = Date.now();
  const probe = await probeLocalEndpoint(ep, {
    timeoutMs: 50,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    now: () => started,
  });
  assert.equal(probe.reachable, false);
  assert.ok(probe.latencyMs >= 0);
});

test('router skips unhealthy local endpoint', () => {
  const lanes = resolveLanes({
    config: {
      lanes: {
        local: { endpoints: [endpointFixture(), endpointFixture({ name: 'backup', baseUrl: 'http://127.0.0.1:18001' })] },
      },
    },
  });
  const job = { id: 'auto-1', agent: 'auto', sensitive: false, outputs: ['docs/a.md'] };
  const route = routeJob(job, {
    lanes,
    health: () => ({ state: 'ok' }),
    endpointHealth: name => ({ state: name === 'dev2' ? 'paused' : 'ok' }),
    failures: { cursor: 9, codex: 9 },
  });
  assert.equal(route.agent, 'local');
  assert.equal(route.model, 'local:backup');
});

test('apiDoctor unconfigured by default', () => {
  const report = apiDoctor('local', {});
  assert.equal(report.configured, false);
});

test('mapLocalUsage maps openai usage fields', () => {
  assert.deepEqual(mapLocalUsage({ prompt_tokens: 3, completion_tokens: 4 }), { input_tokens: 3, output_tokens: 4 });
});

test('agency job detection respects SWARM_AGENCY_CALL', () => {
  assert.equal(isAgencyLocalJob({ type: 'docs' }, { agencyCall: true }), true);
  assert.equal(isAgencyLocalJob({ type: 'build' }, { agencyCall: true }), false);
});

test('local lane test file passes secret scan', () => {
  const content = fs.readFileSync(new URL('./local-lane.test.mjs', import.meta.url), 'utf8');
  assert.deepEqual(scanSecrets([{ path: 'tests/local-lane.test.mjs', content }]), []);
});
