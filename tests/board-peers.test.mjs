// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createPeerCache,
  fetchPeer,
  listPeers,
  mergeMachines,
  validPeerUrl,
} from '../tools/board-peers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = ['token', '1234567890123456'].join('_');

test('peer URLs are tailnet-only except loopback test URLs', () => {
  assert.equal(validPeerUrl('https://mac.ts.net/'), true);
  assert.equal(validPeerUrl('https://mini.tail.ts.net/'), true);
  assert.equal(validPeerUrl('https://example.com/'), false);
  assert.equal(validPeerUrl('http://127.0.0.1:8443/'), true);
  assert.equal(validPeerUrl('http://localhost:8443/'), true);
  assert.equal(validPeerUrl('http://192.168.1.2:8443/'), false);
  assert.equal(validPeerUrl('ftp://mac.ts.net/'), false);
});

test('CLI add/list/remove uses stdin for the token and writes mode 600', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-peers-'));
  const file = path.join(dir, 'peers.json');
  const env = { ...process.env, SWARM_PEERS_FILE: file };
  const run = (args, input = '') => spawnSync(process.execPath, [path.join(root, 'tools/board-peers.mjs'), ...args], { cwd: root, env, input, encoding: 'utf8' });

  const added = run(['add', 'mac', 'https://mac.ts.net/'], `${token}\n`);
  assert.equal(added.status, 0);
  assert.deepEqual(JSON.parse(added.stdout), { ok: true, peer: { name: 'mac', url: 'https://mac.ts.net/' } });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const listed = run(['list']);
  assert.equal(listed.status, 0);
  assert.deepEqual(JSON.parse(listed.stdout), { ok: true, peers: [{ name: 'mac', url: 'https://mac.ts.net/' }] });
  assert.equal(listed.stdout.includes(token), false);
  assert.equal((await listPeers(env)).at(0).token, token);

  const removed = run(['remove', 'mac']);
  assert.equal(removed.status, 0);
  assert.deepEqual(JSON.parse(removed.stdout), { ok: true, name: 'mac', removed: true });
  assert.deepEqual(await listPeers(env), []);
});

test('fetchPeer authenticates in the header, validates the board, and handles errors safely', async () => {
  const calls = [];
  const peer = { name: 'mini', url: 'https://mini.ts.net/', token };
  const result = await fetchPeer(peer, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ at: 'now', machine: { host: 'mini-host', orchestrator: { sessions: [{ id: 's1' }] } }, server: { version: '2.0.0' }, projects: [{ id: 'p1' }] }),
      };
    },
  });
  assert.deepEqual(result, { name: 'mini', ok: true, at: 'now', machine: 'mini-host', version: '2.0.0', projects: [{ id: 'p1' }], orchestrators: [{ id: 's1' }] });
  assert.equal(calls[0].url, 'https://mini.ts.net/api/board');
  assert.equal(calls[0].url.includes(token), false);
  assert.equal(calls[0].options.headers['x-watch-token'], token);
  assert.equal(calls[0].options.redirect, 'error');

  const timedOut = await fetchPeer(peer, {
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(`aborted ${token}`)))),
  });
  assert.deepEqual(timedOut, { name: 'mini', ok: false, error: 'timeout' });

  const invalidJson = await fetchPeer(peer, { fetchImpl: async () => ({ status: 200, ok: true, text: async () => `not json ${token}` }) });
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.error, 'invalid-json');
  assert.equal(JSON.stringify(invalidJson).includes(token), false);

  const redirect = await fetchPeer(peer, { fetchImpl: async () => ({ status: 302, ok: false, text: async () => '' }) });
  assert.deepEqual(redirect, { name: 'mini', ok: false, error: 'redirect' });
});

test('peer cache refreshes only after its TTL', async () => {
  let now = 1000;
  let calls = 0;
  const peer = { name: 'mini', url: 'http://127.0.0.1:8443/', token };
  const cache = createPeerCache({ ttlMs: 100, now: () => now, fetchImpl: async () => {
    calls += 1;
    return { status: 200, ok: true, text: async () => JSON.stringify({ projects: [] }) };
  } });
  await cache.all([peer]);
  await cache.all([peer]);
  assert.equal(calls, 1);
  now = 1100;
  await cache.all([peer]);
  assert.equal(calls, 2);
});

test('mergeMachines tags cards, preserves duplicate project IDs, flags drift, and reports unreachable peers', () => {
  const merged = mergeMachines(
    { name: 'mac', version: '2.0.0', projects: [{ id: 'same' }, { id: 'local' }], orchestrators: [{ id: 'local-session' }] },
    [
      { name: 'mini', machine: 'mini-host', ok: true, version: '1.0.0', projects: [{ id: 'same' }], orchestrators: [{ id: 'remote-session' }] },
      { name: 'down', machine: 'down-host', ok: false, error: 'timeout', version: null, projects: [], orchestrators: [] },
    ],
  );
  assert.deepEqual(merged.drift, { versions: ['1.0.0', '2.0.0'], drifted: true, newest: '2.0.0' });
  assert.deepEqual(merged.machines, [
    { name: 'mac', version: '2.0.0', ok: true, projectCount: 2 },
    { name: 'mini-host', version: '1.0.0', ok: true, projectCount: 1 },
    { name: 'down-host', version: null, ok: false, error: 'timeout', projectCount: 0 },
  ]);
  assert.equal(merged.projects.length, 3);
  assert.equal(merged.projects.filter(project => project.id === 'same').length, 2);
  assert.deepEqual(merged.projects[0], { id: 'same', machine: 'mac', version: '2.0.0' });
  assert.deepEqual(merged.projects[2], { id: 'same', machine: 'mini-host', version: '1.0.0', remote: true, versionDrift: true });
  assert.deepEqual(merged.orchestrators[1], { id: 'remote-session', machine: 'mini-host', version: '1.0.0', remote: true, versionDrift: true });
});
