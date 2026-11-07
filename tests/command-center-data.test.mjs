// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const modulePath = path.join(repo, 'tools', 'watch-assets', 'command-center-data.js');
const moduleSource = () => fs.readFileSync(modulePath, 'utf8');

function loadCommandCenterData() {
  const box = { self: {} };
  vm.runInNewContext(moduleSource(), box);
  return box.self.CommandCenterData;
}

function loadViaCjs() {
  const box = { module: { exports: {} }, exports: {} };
  box.module.exports = box.exports;
  vm.runInNewContext(moduleSource(), box);
  return box.module.exports;
}

function labelled(over) {
  return Object.assign({
    label: 'Projects',
    value: 3,
    unit: 'count',
    source: 'board.projects.length',
    explanation: 'Registered projects on this board.',
  }, over || {});
}

function validSnapshotBody(over) {
  return Object.assign({
    at: '2026-10-26T12:00:00.000Z',
    stats: {
      projectsTotal: labelled({ label: 'Projects', value: 2, source: 'projects.length' }),
      agentsLive: labelled({ label: 'Agents live', value: 5, source: 'machine.agents.total' }),
      needsYouCount: labelled({ label: 'Needs you', value: 1, source: 'inbox.needYou' }),
    },
    projects: [
      {
        id: 'p1',
        name: 'Alpha',
        liveAgents: labelled({ label: 'Live', value: 2, source: 'p1.agents.total' }),
        needsYou: labelled({ label: 'Needs you', value: 0, source: 'p1.inbox.needYou' }),
        spendUsd: labelled({ label: 'Spend', value: 12.5, unit: 'usd', source: 'p1.spend.usd' }),
      },
      {
        id: 'p2',
        name: 'Beta',
        liveAgents: labelled({ label: 'Live', value: 3, source: 'p2.agents.total' }),
        needsYou: labelled({ label: 'Needs you', value: 1, source: 'p2.inbox.needYou' }),
        spendUsd: labelled({ label: 'Spend', value: 4, unit: 'usd', source: 'p2.spend.usd' }),
      },
    ],
  }, over || {});
}

test('module loads in browser and CJS test harness contexts', () => {
  const viaBrowser = loadCommandCenterData();
  const viaCjs = loadViaCjs();
  assert.equal(typeof viaBrowser.fetchCommandCenterSnapshot, 'function');
  assert.equal(typeof viaCjs.deriveCommandCenterSharedStats, 'function');
});

test('valid snapshot parses and Hive and Cockpit derive identical shared values', async () => {
  const mod = loadCommandCenterData();
  const body = validSnapshotBody();
  const snapshot = mod.parseCommandCenterSnapshot(body);
  const hive = mod.deriveCommandCenterSharedStats(snapshot);
  const cockpit = mod.deriveCommandCenterSharedStats(snapshot);
  assert.deepEqual(hive, cockpit);
  assert.deepEqual(hive.projects, snapshot.projects);
  assert.equal(hive.projectsTotal.value, 2);
  assert.equal(hive.agentsLive.value, 5);
  assert.equal(hive.needsYouCount.value, 1);

  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  const fetched = await mod.fetchCommandCenterSnapshot({
    fetchImpl,
    baseUrl: 'http://127.0.0.1:4242',
    token: 'secret',
  });
  assert.deepEqual(mod.deriveCommandCenterSharedStats(fetched), hive);
});

test('omitted or untrusted stat keys are not synthesized with defaults', () => {
  const mod = loadCommandCenterData();
  const body = validSnapshotBody({
    stats: {
      projectsTotal: labelled({ label: 'Projects', value: 2, source: 'projects.length' }),
      agentsLive: { label: 'Agents', value: 9, unit: 'count', source: '', explanation: 'bad' },
      needsYouCount: null,
    },
  });
  const snapshot = mod.parseCommandCenterSnapshot(body);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.stats, 'projectsTotal'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.stats, 'agentsLive'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.stats, 'needsYouCount'), false);

  const shared = mod.deriveCommandCenterSharedStats(snapshot);
  assert.equal(shared.projectsTotal.value, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(shared, 'agentsLive'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(shared, 'needsYouCount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(shared, 'projectsTotal'), true);
});

test('non-200 and malformed responses throw clear errors', async () => {
  const mod = loadCommandCenterData();
  await assert.rejects(
    () => mod.fetchCommandCenterSnapshot({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    () => mod.fetchCommandCenterSnapshot({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error('bad json'); },
      }),
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
    }),
    /not valid JSON/,
  );
  assert.throws(
    () => mod.parseCommandCenterSnapshot({ at: '2026-01-01T00:00:00.000Z' }),
    /projects must be an array/,
  );
  assert.throws(
    () => mod.parseCommandCenterSnapshot(validSnapshotBody({ at: 'not-a-date' })),
    /valid at timestamp/,
  );
});

test('fetch uses x-watch-token header and snapshot path', async () => {
  const mod = loadCommandCenterData();
  let seenUrl = '';
  let seenHeaders = null;
  await mod.fetchCommandCenterSnapshot({
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return { ok: true, status: 200, json: async () => validSnapshotBody() };
    },
    baseUrl: 'http://127.0.0.1:8080/',
    token: 'board-token',
    local: true,
  });
  assert.equal(seenUrl, 'http://127.0.0.1:8080/api/command-center/snapshot?local=1');
  assert.equal(seenHeaders['x-watch-token'], 'board-token');
});
