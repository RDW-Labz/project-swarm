// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLocalLaneBlock, doctorLocal } from '../tools/local-lane.mjs';
import { resolveLanes, claimLaneSlots, releaseLaneSlots, lanesDir, withLaneStore, LaneScheduler } from '../tools/lanes.mjs';
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
  const grantedIds = claim.granted.filter(Boolean);
  assert.equal(grantedIds.length, 2, 'only one fast slot and one agency docs slot');
  const store = await withLaneStore(s => s, { dir });
  const held = store.slots.local ?? [];
  assert.equal(held.length, 2);
  assert.equal(held.filter(s => s.localEndpoint === 'fast').length, 1);
  assert.equal(held.filter(s => s.localEndpoint === 'docs').length, 1);
  assert.equal(held.filter(s => s.localAgency).length, 1);
  await releaseLaneSlots({ dir, slots: grantedIds.map(id => ({ agent: 'local', slotId: id })) });
});

test('claimLaneSlots skips a full endpoint waiter and still grants others', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-skip-'));
  const full = { endpoint: 'busy', slotsLimit: 1, agency: false, agencyConcurrency: 1 };
  const open = { endpoint: 'idle', slotsLimit: 2, agency: false, agencyConcurrency: 1 };
  const block = await claimLaneSlots({ dir, agent: 'local', concurrency: 4, count: 1, local: full });
  assert.equal(block.granted.filter(Boolean).length, 1);
  const claim = await claimLaneSlots({
    dir,
    agent: 'local',
    concurrency: 4,
    count: 2,
    local: [full, open],
  });
  const grantedIds = claim.granted.filter(Boolean);
  assert.equal(grantedIds.length, 1);
  assert.equal(claim.granted[0], null);
  assert.ok(grantedIds[0]);
  const store = await withLaneStore(s => s, { dir });
  assert.equal(store.slots.local.filter(s => s.localEndpoint === 'idle').length, 1);
  await releaseLaneSlots({
    dir,
    slots: [...block.granted, ...grantedIds].filter(Boolean).map(id => ({ agent: 'local', slotId: id })),
  });
});

test('claimLaneSlots counts slots granted earlier in the same claim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-batch-'));
  const local = { endpoint: 'dev2', slotsLimit: 2, agency: false, agencyConcurrency: 1 };
  const claim = await claimLaneSlots({ dir, agent: 'local', concurrency: 2, count: 2, local });
  assert.equal(claim.granted.length, 2);
  await releaseLaneSlots({ dir, slots: claim.granted.map(id => ({ agent: 'local', slotId: id })) });
});

test('claimLaneSlots tags each grant with its waiter job id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-jobid-'));
  const locals = [
    { endpoint: 'fast', slotsLimit: 1, agency: false, agencyConcurrency: 1 },
    { endpoint: 'docs', slotsLimit: 3, agency: true, agencyConcurrency: 1 },
  ];
  const claim = await claimLaneSlots({
    dir,
    agent: 'local',
    concurrency: 4,
    count: 2,
    jobIds: ['job-fast', 'job-docs'],
    local: locals,
  });
  assert.equal(claim.granted.length, 2);
  assert.deepEqual(claim.granted[0], { jobId: 'job-fast', slotId: claim.granted[0].slotId });
  assert.deepEqual(claim.granted[1], { jobId: 'job-docs', slotId: claim.granted[1].slotId });
  await releaseLaneSlots({
    dir,
    slots: claim.granted.map(entry => ({ agent: 'local', slotId: entry.slotId })),
  });
});

test('scheduler matches grants by job id when a middle waiter is cancelled during claim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-cancel-shift-'));
  const lanes = resolveLanes({
    config: {
      lanes: {
        local: {
          endpoints: [loopbackEp('fast', 18010, 2), loopbackEp('docs', 18011, 3)],
          agencyConcurrency: 1,
        },
      },
    },
  });
  const fast = { endpoint: 'fast', slotsLimit: 2, agency: false, agencyConcurrency: 1 };
  const docsAgency = { endpoint: 'docs', slotsLimit: 3, agency: true, agencyConcurrency: 1 };
  const scheduler = new LaneScheduler({
    lanes,
    globalConcurrency: 8,
    shared: {
      dir,
      runId: 'review-cancel',
      claimWait: async ({ waiters }) => {
        waiters[1].abort();
      },
    },
  });
  const middle = new AbortController();
  const releases = [];
  const settled = await Promise.allSettled([
    scheduler.acquire('local', { jobId: 'j-fast-1', local: fast }).then(release => { releases.push(release); }),
    scheduler.acquire('local', { jobId: 'j-docs', local: docsAgency, signal: middle.signal }),
    scheduler.acquire('local', { jobId: 'j-fast-2', local: fast }).then(release => { releases.push(release); }),
  ]);
  assert.equal(settled[1].status, 'rejected');
  assert.equal(releases.length, 2);
  const store = await withLaneStore(s => s, { dir });
  const held = store.slots.local ?? [];
  assert.equal(held.length, 2);
  assert.equal(held.filter(s => s.localEndpoint === 'fast').length, 2);
  assert.equal(held.filter(s => s.localAgency).length, 0);
  for (const release of releases) await release();
  await scheduler.close();
});

test('scheduler releases a grant when its job is no longer pending after claim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-cancel-release-'));
  const lanes = resolveLanes({
    config: {
      lanes: {
        local: {
          endpoints: [loopbackEp('docs', 18012, 3)],
          agencyConcurrency: 1,
        },
      },
    },
  });
  const docsAgency = { endpoint: 'docs', slotsLimit: 3, agency: true, agencyConcurrency: 1 };
  const scheduler = new LaneScheduler({
    lanes,
    globalConcurrency: 8,
    shared: {
      dir,
      runId: 'review-release',
      claimWait: async ({ waiters }) => {
        waiters[0].abort();
      },
    },
  });
  const ctrl = new AbortController();
  await assert.rejects(
    scheduler.acquire('local', { jobId: 'j-cancelled', local: docsAgency, signal: ctrl.signal }),
    { name: 'AbortError' },
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  const store = await withLaneStore(s => s, { dir });
  assert.equal(store.slots.local?.length ?? 0, 0);
  await scheduler.close();
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

test('executeApi local job fails on HTTP redirect without a follow-up request', async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-redir-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [loopbackEp('dev2', 18000)] } },
  }));
  let calls = 0;
  const result = await executeApi(
    { id: 's2b', agent: 'local', model: 'local:dev2', sensitive: false, prompt: 'secret prompt', context: [], outputs: [] },
    [],
    {
      env: { SWARM_CONFIG: configPath },
      readLocal: () => 'token',
      fetchImpl: async (_url, init) => {
        calls += 1;
        assert.equal(init.redirect, 'error');
        throw Object.assign(new TypeError('redirect'), { cause: 'redirect' });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /redirect|transport/i);
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

test('doctorLocal reports malformed lanes.local as invalid instead of throwing', async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-bad-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ lanes: { local: { agencyConcurrency: 0 } } }));
  const report = await doctorLocal({ SWARM_CONFIG: configPath });
  assert.equal(report.status, 'invalid');
  assert.match(report.note, /agencyConcurrency/);
});

test('probeLocalProvider handles local doctor without endpoint field', async () => {
  const report = await probeLocalProvider('local', {}, { fetchImpl: async () => ({ ok: false, status: 503, body: { cancel: async () => {} } }) });
  assert.equal(report.agent, 'local');
  assert.equal(report.configured, false);
});
