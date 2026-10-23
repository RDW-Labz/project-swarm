// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  tunnelAdd,
  tunnelRemove,
  tunnelStatus,
  buildTunnelPlist,
  buildSshProgramArguments,
  tunnelPlistPath,
  tunnelLogPath,
  TunnelError,
  patchZshCompletion,
} from '../tools/tunnel.mjs';
import { LOCAL_ENDPOINT_UNHEALTHY_PAUSE_MS } from '../tools/local-lane.mjs';
import { resolveLanes } from '../tools/lanes.mjs';
import { routeJobWithLocalHealthGate } from '../tools/router.mjs';
import { zshCompletion } from '../tools/completion.mjs';

function fakeDeps(over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-home-'));
  const files = new Map();
  const dirs = new Set([home]);
  const launchctlCalls = [];
  const ports = new Set(over.busyPorts ?? []);
  const now = over.now ?? (() => Date.now());
  return {
    platform: 'darwin',
    home,
    uid: 502,
    env: { HOME: home, SWARM_CONFIG: over.configPath },
    readFileSync: (file, enc) => {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
    writeFileSync: (file, data) => files.set(file, data),
    mkdirSync: (dir) => dirs.add(dir),
    unlinkSync: (file) => files.delete(file),
    existsSync: file => files.has(file) || dirs.has(file),
    readdirSync: (dir) => {
      const prefix = `${dir}${path.sep}`;
      const names = new Set();
      for (const file of files.keys()) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split(path.sep)[0]);
      }
      return [...names];
    },
    statSync: (file) => {
      if (over.keyPath && file === over.keyPath) return { isFile: () => true };
      if (files.has(file)) return { isFile: () => true };
      throw new Error('ENOENT');
    },
    launchctl: (args) => {
      launchctlCalls.push(args);
      if (args[0] === 'print') return { code: 0, stdout: 'state = running\npid = 4242\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    connect: async ({ port }) => ports.has(port),
    fetchImpl: over.fetchImpl ?? (async () => ({ ok: true, status: 200, body: { cancel: async () => {} } })),
    now,
    loadEndpoints: () => over.endpoints ?? [],
    _files: files,
    _launchctlCalls: launchctlCalls,
    _ports: ports,
    ...over.deps,
  };
}

test('tunnel add writes plist argv and bootstraps launchd', async () => {
  const keyPath = path.join(os.tmpdir(), `tunnel-key-${process.pid}`);
  fs.writeFileSync(keyPath, 'not-a-real-key');
  const deps = fakeDeps({ keyPath });
  const added = await tunnelAdd('dev2', {
    host: 'user@dev2.example',
    key: keyPath,
    localPort: 18001,
    remotePort: 8000,
  }, deps);
  const plist = deps._files.get(tunnelPlistPath(deps.home, 'dev2'));
  assert.ok(plist.includes('<key>KeepAlive</key>'));
  assert.ok(plist.includes('<integer>10</integer>'));
  assert.ok(!plist.includes('not-a-real-key'));
  assert.deepEqual(
    buildSshProgramArguments({
      key: keyPath,
      localPort: 18001,
      remoteHost: '127.0.0.1',
      remotePort: 8000,
      host: 'user@dev2.example',
    }),
    added.programArguments,
  );
  assert.ok(deps._launchctlCalls.some(args => args[0] === 'bootstrap' && args[1] === 'gui/502'));
  fs.unlinkSync(keyPath);
});

test('tunnel add refuses duplicate name, busy port, and bad tokens', async () => {
  const keyPath = path.join(os.tmpdir(), `tunnel-key2-${process.pid}`);
  fs.writeFileSync(keyPath, 'x');
  const deps = fakeDeps({ keyPath, busyPorts: [18001] });
  deps._files.set(tunnelPlistPath(deps.home, 'dev2'), buildTunnelPlist({
    name: 'dev2',
    programArguments: buildSshProgramArguments({
      key: keyPath,
      localPort: 18002,
      remoteHost: '127.0.0.1',
      remotePort: 8000,
      host: 'user@h',
    }),
    logPath: tunnelLogPath(deps.home, 'dev2'),
  }));
  await assert.rejects(
    () => tunnelAdd('dev2', { host: 'user@h', key: keyPath, localPort: 18003, remotePort: 8000 }, deps),
    err => err instanceof TunnelError && err.code === 'tunnel-exists',
  );
  await assert.rejects(
    () => tunnelAdd('other', { host: 'user@h', key: keyPath, localPort: 18001, remotePort: 8000 }, deps),
    err => err instanceof TunnelError && err.code === 'tunnel-port-busy',
  );
  await assert.rejects(
    () => tunnelAdd('bad name', { host: 'user@h', key: keyPath, localPort: 18004, remotePort: 8000 }, deps),
    /tunnel-invalid/,
  );
  fs.unlinkSync(keyPath);
});

test('tunnel remove bootouts and deletes plist only', async () => {
  const keyPath = path.join(os.tmpdir(), `tunnel-key3-${process.pid}`);
  fs.writeFileSync(keyPath, 'x');
  const deps = fakeDeps({ keyPath });
  await tunnelAdd('dev2', { host: 'user@h', key: keyPath, localPort: 18005, remotePort: 8000 }, deps);
  const logPath = tunnelLogPath(deps.home, 'dev2');
  deps._files.set(logPath, 'line1\nline2\n');
  await tunnelRemove('dev2', deps);
  assert.equal(deps.existsSync(tunnelPlistPath(deps.home, 'dev2')), false);
  assert.equal(deps._files.has(logPath), true);
  assert.ok(deps._launchctlCalls.some(args => args[0] === 'bootout'));
  fs.unlinkSync(keyPath);
});

test('tunnel status reports launchctl, port, log tail, and models probe', async () => {
  const keyPath = path.join(os.tmpdir(), `tunnel-key4-${process.pid}`);
  fs.writeFileSync(keyPath, 'x');
  const deps = fakeDeps({
    keyPath,
    endpoints: [{ name: 'dev2', baseUrl: 'http://127.0.0.1:18006', model: 'm', slots: 1 }],
    fetchImpl: async url => {
      assert.match(url, /\/v1\/models$/);
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });
  await tunnelAdd('dev2', { host: 'user@h', key: keyPath, localPort: 18006, remotePort: 8000 }, deps);
  deps._ports.add(18006);
  deps._files.set(tunnelLogPath(deps.home, 'dev2'), 'a\nb\nc\nd\n');
  const status = await tunnelStatus('dev2', deps);
  assert.equal(status.launchctl.state, 'running');
  assert.equal(status.launchctl.pid, 4242);
  assert.equal(status.localPortOpen, true);
  assert.deepEqual(status.logTail, ['b', 'c', 'd']);
  assert.equal(status.reachability[0].reachable, true);
  fs.unlinkSync(keyPath);
});

test('routeJobWithLocalHealthGate pauses unreachable endpoint for 60s', async () => {
  const lanes = resolveLanes({
    config: {
      lanes: {
        local: {
          endpoints: [
            { name: 'dev2', baseUrl: 'http://127.0.0.1:18000', model: 'm', slots: 1, keychain: { service: 'p', account: 'a' } },
            { name: 'backup', baseUrl: 'http://127.0.0.1:18001', model: 'm', slots: 1, keychain: { service: 'p', account: 'b' } },
          ],
        },
      },
    },
  });
  const job = { id: 'auto-1', agent: 'auto', sensitive: false, outputs: ['docs/a.md'] };
  let now = 1_000_000;
  const fetchImpl = async url => {
    if (url.includes('18000')) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { ok: true, status: 200, body: { cancel: async () => {} } };
  };
  const first = await routeJobWithLocalHealthGate(job, {
    lanes,
    failures: { cursor: 9, codex: 9 },
    fetchImpl,
    now: () => now,
  });
  assert.equal(first.agent, 'local');
  assert.equal(first.model, 'local:backup');
  const until = first.localHealthTracker.pauseUntil.get('dev2');
  assert.equal(until, now + LOCAL_ENDPOINT_UNHEALTHY_PAUSE_MS);
  now += 30_000;
  const second = await routeJobWithLocalHealthGate(job, {
    lanes,
    failures: { cursor: 9, codex: 9 },
    fetchImpl,
    now: () => now,
    localHealthTracker: first.localHealthTracker,
    probeLocalEndpoints: false,
  });
  assert.equal(second.model, 'local:backup');
  assert.equal(second.localHealthTracker.health('dev2').state, 'paused');
});

test('zsh completion includes tunnel command', () => {
  const script = patchZshCompletion(zshCompletion());
  assert.match(script, /'tunnel:/);
  assert.match(script, /tunnel\)/);
});
