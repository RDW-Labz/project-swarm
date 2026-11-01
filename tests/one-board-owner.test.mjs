// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { restartRegisteredServers, writeRegistryRecord } from '../tools/server-restart.mjs';
import { readBoardIdentity, boardIdentityPath } from '../tools/board-keepalive.mjs';
import { findRunningBoard, runWatchCommand } from '../tools/watch-cli.mjs';

const identity = { token: 'a'.repeat(48), port: 51058 };
const identityUrl = `http://127.0.0.1:${identity.port}/?t=${identity.token}`;
const boardResponse = () => ({ ok: true, json: async () => ({ ok: true, version: '1.0.0' }) });

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'one-board-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, '.project-swarm', 'board.json');
  const installRoot = path.join(home, 'install');
  const runner = path.join(installRoot, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {};\n');
  return { home, file, installRoot, runner };
}

async function restartFixture(t, {
  loaded = true, plist = true, held = false, platform = 'darwin',
  printError, kickError, stalePid = false, defaultPlist = false,
} = {}) {
  const f = await fixture(t);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  if (held) t.after(() => new Promise(resolve => socket.close(resolve)));
  else await new Promise(resolve => socket.close(resolve));
  const record = {
    pid: 880001, version: '1.0.0', port, url: `http://127.0.0.1:${port}/?t=old`,
    argv: ['watch', '--all'], cwd: f.home, env: {}, mode: 'background',
    explicitBackground: true, startedAt: new Date().toISOString(),
  };
  await writeRegistryRecord(f.file, record);
  if (defaultPlist) {
    const plistFile = path.join(f.home, 'Library', 'LaunchAgents', 'com.project-swarm.board.plist');
    await fs.mkdir(path.dirname(plistFile), { recursive: true });
    await fs.writeFile(plistFile, 'test plist');
  }
  const calls = [], signals = [], spawns = [], lines = [];
  let alive = !stalePid;
  let healthCalls = 0;
  const result = await restartRegisteredServers({
    ...f, targetVersion: '2.0.0', home: f.home, env: { HOME: f.home },
    platform, getuid: () => 502, launchdBoardPlistExists: defaultPlist ? undefined : () => plist,
    write: line => lines.push(line), strictPidCheck: false, sleep: async () => {},
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'launchctl' && args[0] === 'print') {
        if (printError) throw printError;
        if (!loaded) throw new Error('Could not find service');
        return { stdout: 'state = running\n pid = 880001\n' };
      }
      if (cmd === 'launchctl' && args[0] === 'kickstart' && kickError) throw kickError;
      return { stdout: '' };
    },
    pidAliveImpl: pid => (pid === record.pid && alive) || pid === 880002,
    killImpl: (pid, signal) => { signals.push([pid, signal]); alive = false; },
    spawnImpl: (...args) => {
      spawns.push(args);
      writeFileSync(f.file, JSON.stringify({ ...record, pid: 880002, version: '2.0.0' }));
      return { pid: 880002, on() {}, unref() {} };
    },
    fetchImpl: async url => {
      assert.equal(url, `http://127.0.0.1:${port}/api/health`);
      healthCalls += 1;
      // A successful kickstart can return before the old server stops answering.
      return { ok: true, json: async () => ({ version: healthCalls === 1 ? '1.0.0' : '2.0.0', pid: 880002 }) };
    },
  });
  return { ...result, calls, signals, spawns, lines, port, healthCalls };
}

test('update restarts the loaded launchd board through its job without signaling or spawning', async t => {
  const r = await restartFixture(t);
  assert.equal(r.servers[0]?.status, 'restarted-launchd');
  assert.deepEqual(r.calls.filter(c => c[0] === 'launchctl'), [
    ['launchctl', 'print', 'gui/502/com.project-swarm.board'],
    ['launchctl', 'kickstart', '-k', 'gui/502/com.project-swarm.board'],
  ]);
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.spawns, []);
  assert.equal(r.healthCalls, 2);
  assert.ok(r.lines.some(line => line.includes(`board restarted through launchd: 1.0.0 to 2.0.0 (port ${r.port})`)));
});

test('launchd ownership survives a stale registry pid and uses the home-specific plist', async t => {
  const r = await restartFixture(t, { stalePid: true, defaultPlist: true });
  assert.equal(r.servers[0]?.status, 'restarted-launchd');
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.spawns, []);
});

test('an unloaded launchd job with a busy port is skipped with bootstrap guidance', async t => {
  const r = await restartFixture(t, { loaded: false, held: true });
  assert.equal(r.servers[0]?.status, 'launchd-not-loaded');
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.spawns, []);
  assert.ok(r.lines.some(line => /launchctl bootstrap gui\/502/.test(line)
    && /Library\/LaunchAgents\/com.project-swarm.board.plist/.test(line)
    && /swarm watch --all --keep-up/.test(line)));
});

for (const [name, options] of [
  ['no plist', { plist: false }],
  ['unloaded job with a free port', { loaded: false }],
  ['non-macOS', { platform: 'linux' }],
  ['unavailable launchctl', { printError: Object.assign(new Error('unsupported'), { code: 'ENOENT' }) }],
]) {
  test(`${name} keeps the manual restart path`, async t => {
    const r = await restartFixture(t, options);
    assert.equal(r.servers[0]?.status, 'restarted');
    assert.deepEqual(r.signals, [[880001, 'SIGTERM']]);
    assert.equal(r.spawns.length, 1);
  });
}

test('a failed launchd kickstart never falls back to signaling or spawning', async t => {
  const r = await restartFixture(t, { kickError: new Error('kickstart failed') });
  assert.equal(r.servers[0]?.status, 'failed');
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.spawns, []);
  assert.ok(r.lines.some(line => /restart through launchd failed/.test(line)));
});

async function saveIdentity(file, data = identity, mode = 0o600) {
  const idFile = boardIdentityPath(path.dirname(file));
  await fs.mkdir(path.dirname(idFile), { recursive: true });
  await fs.writeFile(idFile, JSON.stringify(data), { mode });
  return idFile;
}

test('identity discovery is read-only for valid, missing, invalid and untrusted files', async t => {
  const { file } = await fixture(t);
  const dir = path.dirname(file);
  const warnings = [];
  const read = options => readBoardIdentity({ dir, fs, warn: msg => warnings.push(msg), ...options });
  assert.equal(await read(), null);
  await assert.rejects(fs.access(dir), { code: 'ENOENT' });
  const idFile = await saveIdentity(file);
  const before = await fs.stat(idFile);
  assert.deepEqual(await read(), identity);
  assert.equal((await fs.stat(idFile)).mtimeMs, before.mtimeMs);
  assert.equal(await read({ uid: before.uid + 1 }), null);
  assert.equal(await fs.readFile(idFile, 'utf8'), JSON.stringify(identity));
  await fs.chmod(idFile, 0o644);
  assert.equal(await read(), null);
  assert.equal((await fs.stat(idFile)).mode & 0o777, 0o644);
  await fs.chmod(idFile, 0o600);
  for (const text of ['{bad', JSON.stringify({ ...identity, token: 'x'.repeat(48) }),
    ...[0, 65536, 1.5].map(port => JSON.stringify({ ...identity, port }))]) {
    await fs.writeFile(idFile, text);
    assert.equal(await read(), null);
    assert.equal(await fs.readFile(idFile, 'utf8'), text);
  }
  assert.ok(warnings.length > 0);
});

test('identity discovery refuses a symlink without changing it or its target', async t => {
  const { file, home } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const target = path.join(home, 'identity-target.json');
  await fs.writeFile(target, JSON.stringify(identity), { mode: 0o600 });
  const idFile = boardIdentityPath(path.dirname(file));
  await fs.symlink(target, idFile);
  assert.equal(await readBoardIdentity({ dir: path.dirname(file), fs, warn() {} }), null);
  assert.equal((await fs.lstat(idFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), JSON.stringify(identity));
});

async function watch(t, file, options = {}, args = ['--all']) {
  const previous = process.env.SWARM_BOARD_FILE;
  process.env.SWARM_BOARD_FILE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.SWARM_BOARD_FILE;
    else process.env.SWARM_BOARD_FILE = previous;
  });
  // The stale-identity case completes a stub server immediately; remove its signal hooks.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const before = process.listeners(signal);
    t.after(() => {
      for (const listener of process.listeners(signal)) {
        if (!before.includes(listener)) process.removeListener(signal, listener);
      }
    });
  }
  const output = [];
  const result = await runWatchCommand(path.dirname(file), args, {
    write: text => output.push(text),
    startBoardServer: async () => assert.fail('must reuse the existing board'),
    fetchImpl: boardResponse, ...options,
  });
  return { ...result, output: output.join('') };
}

test('watch --all reuses a healthy board when the board payload times out', async t => {
  const { file } = await fixture(t);
  await saveIdentity(file);
  let starts = 0;
  const probes = [];
  const timeouts = [];
  const signal = new AbortController().signal;
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return signal; });
  const result = await watch(t, file, {
    fetchImpl: async (url, options) => {
      probes.push({ url, options });
      if (new URL(url).pathname === '/api/board') {
        throw new DOMException('board payload timed out', 'TimeoutError');
      }
      return boardResponse();
    },
    startBoardServer: async () => {
      starts += 1;
      return { url: 'http://127.0.0.1:59811/?t=new', server: { done: Promise.resolve(), close() {} }, api: { async close() {} } };
    },
  });
  assert.equal(starts, 0);
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(identityUrl));
  assert.deepEqual(probes.map(probe => probe.url), [`${new URL(identityUrl).origin}/api/health`]);
  assert.equal(probes[0].options.headers, undefined);
  assert.equal(probes[0].options.redirect, 'manual');
  assert.equal(probes[0].options.signal, signal);
  assert.deepEqual(timeouts, [3000]);
});

test('watch --all reuses the identity board before board.json and opens the same URL', async t => {
  const { file } = await fixture(t);
  const idFile = await saveIdentity(file);
  const json = JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:59811/?t=other' });
  await fs.writeFile(file, json);
  const probes = [], opened = [];
  const origin = new URL(identityUrl).origin;
  const result = await watch(t, file, {
    fetchImpl: async (url, options) => {
      probes.push({ url, headers: options.headers, redirect: options.redirect });
      return boardResponse();
    },
    open: url => opened.push(url),
  }, ['--all', '--open']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.match(result.output, /already running/);
  assert.ok(result.output.includes(identityUrl));
  assert.deepEqual(opened, [identityUrl]);
  assert.deepEqual(probes, [{ url: `${origin}/api/health`, headers: undefined, redirect: 'manual' }]);
  assert.equal(await fs.readFile(file, 'utf8'), json);
  assert.equal(await fs.readFile(idFile, 'utf8'), JSON.stringify(identity));
});

for (const [name, response] of [
  ['404', () => ({ ok: false, status: 404, json: async () => ({ ok: true, version: '1.0.0' }) })],
  ['HTML', () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
  ['missing ok', () => ({ ok: true, json: async () => ({ version: '1.0.0' }) })],
  ['missing version', () => ({ ok: true, json: async () => ({ ok: true }) })],
  ['false ok', () => ({ ok: true, json: async () => ({ ok: false, version: '1.0.0' }) })],
  ['truthy ok', () => ({ ok: true, json: async () => ({ ok: 1, version: '1.0.0' }) })],
  ['non-string version', () => ({ ok: true, json: async () => ({ ok: true, version: 1 }) })],
  ['null body', () => ({ ok: true, json: async () => null })],
  ['board payload', () => ({ ok: true, json: async () => ({ projects: [], machine: { name: 'test' } }) })],
]) {
  test(`a health response with ${name} is not reused and starts one board`, async t => {
    const { file } = await fixture(t);
    await saveIdentity(file);
    let starts = 0;
    const probes = [];
    const result = await watch(t, file, {
      fetchImpl: async (url, options) => {
        probes.push({ url, headers: options.headers });
        return response();
      },
      startBoardServer: async () => {
        starts += 1;
        return { url: 'http://127.0.0.1:59811/?t=new', server: { done: Promise.resolve(), close() {} }, api: { async close() {} } };
      },
    });
    assert.equal(starts, 1);
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.output, /already running/);
    assert.deepEqual(probes, [{
      url: `${new URL(identityUrl).origin}/api/health`,
      headers: undefined,
    }]);
  });
}

test('stale identity and no board.json starts one board', async t => {
  const { file } = await fixture(t);
  const idFile = await saveIdentity(file);
  let starts = 0;
  const result = await watch(t, file, {
    fetchImpl: async () => { throw new Error('stale'); },
    startBoardServer: async () => {
      starts += 1;
      return { url: 'http://127.0.0.1:59811/?t=new', server: { done: Promise.resolve(), close() {} }, api: { async close() {} } };
    },
  });
  assert.equal(starts, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(idFile, 'utf8'), JSON.stringify(identity));
});

for (const stale of [false, true]) {
  test(`live board.json is reused ${stale ? 'after a stale identity' : 'without an identity'}`, async t => {
    const { file } = await fixture(t);
    if (stale) await saveIdentity(file);
    const url = 'http://127.0.0.1:59811/?t=recorded';
    await writeRegistryRecord(file, { pid: process.pid, url });
    const json = await fs.readFile(file, 'utf8');
    const probes = [];
    const result = await watch(t, file, { fetchImpl: async (probe, options) => {
      probes.push({ url: probe, headers: options.headers, redirect: options.redirect });
      if (String(probe).includes(':51058/')) throw new Error('stale');
      return boardResponse();
    } });
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes(url));
    assert.deepEqual(probes, [
      ...(stale ? [{ url: `${new URL(identityUrl).origin}/api/health`, headers: undefined, redirect: 'manual' }] : []),
      { url: `${new URL(url).origin}/api/health`, headers: undefined, redirect: 'manual' },
    ]);
    assert.equal(await fs.readFile(file, 'utf8'), json);
  });
}

test('findRunningBoard honors home and returns null for a non-board response', async t => {
  const { file, home } = await fixture(t);
  await saveIdentity(file);
  assert.equal(await findRunningBoard({ env: {}, home, fetchImpl: boardResponse }), identityUrl);
  assert.equal(await findRunningBoard({ env: {}, home, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null);
});
