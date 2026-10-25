// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  boardFile,
  safeEnvSubset,
  serverMode,
} from '../tools/watch-cli.mjs';
import {
  remoteServerFile,
  restartRegisteredServers,
  writeRegistryRecord,
  noRestartFromArgv,
} from '../tools/server-restart.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';
import { readFile } from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

/** @type {{ pid: number, child?: import('node:child_process').ChildProcess }[]} */
const trackedFakeServers = [];

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function trackFakeServer(childOrPid) {
  const pid = typeof childOrPid === 'number' ? childOrPid : childOrPid?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return childOrPid;
  const child = typeof childOrPid === 'number' ? undefined : childOrPid;
  if (!trackedFakeServers.some(e => e.pid === pid)) {
    trackedFakeServers.push({ pid, child });
  }
  return childOrPid;
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

async function stopTrackedFakeServers() {
  const pending = trackedFakeServers.splice(0, trackedFakeServers.length);
  for (const { pid, child } of pending) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
    await waitForPidExit(pid, 2000);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
      await waitForPidExit(pid, 2000);
    }
    if (child) {
      await new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
  }
}

afterEach(async () => {
  await stopTrackedFakeServers();
});

const FAKE_SERVER = `import http from 'node:http';
import fs from 'node:fs/promises';
const port = Number(process.env.TEST_PORT);
const version = process.env.TEST_VERSION || '1.0.0';
const recordFile = process.env.TEST_RECORD_FILE;
const ignoreTerm = process.env.TEST_IGNORE_SIGTERM === '1';
if (ignoreTerm) process.on('SIGTERM', () => {});
const body = JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:' + port + '/?t=x', startedAt: new Date().toISOString(), version, argv: ['watch', '--all'], cwd: process.cwd(), port, env: {}, mode: 'background' });
if (recordFile) await fs.writeFile(recordFile, body + '\\n', { mode: 0o600 });
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version, pid: process.pid }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1');
`;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

async function mkHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'server-restart-home-'));
  const swarmDir = path.join(home, '.project-swarm');
  await fs.mkdir(swarmDir, { recursive: true, mode: 0o700 });
  return home;
}

async function startFake({ home, version, port, ignoreSigterm = false, recordKind = 'board' }) {
  const script = path.join(home, 'fake-server.mjs');
  await fs.writeFile(script, FAKE_SERVER);
  const recordFile = recordKind === 'board' ? boardFile({ HOME: home }, home) : remoteServerFile({ HOME: home }, home);
  const child = spawn(process.execPath, [script], {
    env: {
      ...safeEnvSubset({ HOME: home, PATH: process.env.PATH }),
      TEST_PORT: String(port),
      TEST_VERSION: version,
      TEST_RECORD_FILE: recordFile,
      TEST_IGNORE_SIGTERM: ignoreSigterm ? '1' : '0',
      HOME: home,
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(recordFile, 'utf8');
      const data = JSON.parse(text);
      if (data.pid === child.pid) break;
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 50));
  }
  return trackFakeServer(child);
}

async function trackPidFromRegistry(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number.isInteger(data.pid) && data.pid > 0) trackFakeServer(data.pid);
  } catch { /* no record */ }
}

async function installLayout(home, { runnerBody }) {
  const install = path.join(home, 'install');
  await fs.mkdir(path.join(install, 'current', 'tools'), { recursive: true });
  await fs.writeFile(path.join(install, 'current', 'tools', 'swarm.mjs'), runnerBody);
  return install;
}

test('safeEnvSubset and serverMode', () => {
  const env = safeEnvSubset({ HOME: '/h', PATH: '/p', SWARM_X: '1', SECRET: 'nope' });
  assert.equal(env.HOME, '/h');
  assert.equal(env.SWARM_X, '1');
  assert.equal(env.SECRET, undefined);
  assert.equal(serverMode({ stdin: { isTTY: true }, stdout: { isTTY: true } }), 'terminal');
  assert.equal(serverMode({ stdin: { isTTY: false }, stdout: { isTTY: true } }), 'background');
});

test('no servers means no extra output', async () => {
  const home = await mkHome();
  const lines = [];
  const { servers, lines: out } = await restartRegisteredServers({
    installRoot: path.join(home, 'install'),
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  assert.deepEqual(servers, []);
  assert.deepEqual(out, []);
  assert.deepEqual(lines, []);
});

test('stale record is removed silently', async () => {
  const home = await mkHome();
  const file = boardFile({ HOME: home }, home);
  await writeRegistryRecord(file, {
    pid: 999999,
    url: 'http://127.0.0.1:9/?t=x',
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port: 9,
    env: {},
    mode: 'background',
  });
  await restartRegisteredServers({
    installRoot: path.join(home, 'install'),
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
  });
  await assert.rejects(() => fs.readFile(file), { code: 'ENOENT' });
});

test('unparsable record is reported and skipped', async () => {
  const home = await mkHome();
  const file = boardFile({ HOME: home }, home);
  await fs.writeFile(file, 'not json\n', { mode: 0o600 });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: path.join(home, 'install'),
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  assert.equal(servers[0]?.status, 'unparsable');
  assert.match(lines.join(''), /skipped/);
});

test('--no-restart skips everything', async () => {
  const home = await mkHome();
  const port = await freePort();
  const child = await startFake({ home, version: '1.0.0', port });
  const lines = [];
  await restartRegisteredServers({
    installRoot: path.join(home, 'install'),
    targetVersion: '2.0.0',
    noRestart: true,
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  assert.ok(child.kill(0));
  assert.deepEqual(lines, []);
  assert.equal(noRestartFromArgv(['node', 'swarm.mjs', 'update', '--no-restart']), true);
});

test('terminal-mode record is not killed', async () => {
  const home = await mkHome();
  const port = await freePort();
  const child = await startFake({ home, version: '1.0.0', port });
  const file = boardFile({ HOME: home }, home);
  await writeRegistryRecord(file, {
    pid: child.pid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: safeEnvSubset({ HOME: home, PATH: process.env.PATH }),
    mode: 'terminal',
  });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: path.join(home, 'install'),
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  assert.ok(child.kill(0));
  assert.equal(servers[0]?.status, 'terminal');
  assert.match(lines.join(''), /running in a terminal/);
});

test('SIGTERM timeout is reported and process is not killed', async () => {
  const home = await mkHome();
  const port = await freePort();
  const child = await startFake({ home, version: '1.0.0', port, ignoreSigterm: true });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: path.join(home, 'install'),
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
    sleep: async () => {},
  });
  assert.ok(child.kill(0));
  assert.equal(servers[0]?.status, 'sigterm-timeout');
  assert.match(lines.join(''), /after SIGTERM/);
});

test('background fake server restarts on new version', async () => {
  const home = await mkHome();
  const port = await freePort();
  const fakePath = path.join(home, 'fake-server.mjs');
  await fs.writeFile(fakePath, FAKE_SERVER);
  const record = boardFile({ HOME: home }, home);
  const runner = `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(fakePath)}], { detached: true, stdio: 'ignore', env: { ...process.env, TEST_PORT: '${port}', TEST_VERSION: '2.0.0', TEST_RECORD_FILE: ${JSON.stringify(record)}, HOME: ${JSON.stringify(home)} } });
child.unref();
`;
  const install = await installLayout(home, { runnerBody: runner });
  await startFake({ home, version: '1.0.0', port });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  assert.equal(servers[0]?.status, 'restarted');
  assert.match(lines.join(''), /board restarted: 1\.0\.0 to 2\.0\.0/);
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json());
  assert.equal(health.version, '2.0.0');
  trackFakeServer(health.pid);
});

test('remote server record works the same', async () => {
  const home = await mkHome();
  const port = await freePort();
  const fakePath = path.join(home, 'fake-server.mjs');
  await fs.writeFile(fakePath, FAKE_SERVER);
  const recordFile = remoteServerFile({ HOME: home }, home);
  const runner = `import { spawn } from 'node:child_process';
const script = ${JSON.stringify(fakePath)};
const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', env: { ...process.env, TEST_PORT: '${port}', TEST_VERSION: '2.0.0', TEST_RECORD_FILE: '${recordFile}', HOME: '${home}' } });
child.unref();
`;
  const install = await installLayout(home, { runnerBody: runner });
  await startFake({ home, version: '1.0.0', port, recordKind: 'remote' });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  await trackPidFromRegistry(recordFile);
  assert.equal(servers[0]?.kind, 'remote');
  assert.equal(servers[0]?.status, 'restarted');
  assert.match(lines.join(''), /remote server restarted/);
});

test('stopTrackedFakeServers kills children when a test body throws', async (t) => {
  const home = await mkHome();
  const port = await freePort();
  const child = await startFake({ home, version: '1.0.0', port });
  const pid = child.pid;
  let caught = null;
  try {
    throw new Error('intentional test failure');
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.message, 'intentional test failure');
  t.after(async () => {
    assert.equal(pidAlive(pid), false);
  });
});

test('failed replacement is retried once then manual command', async () => {
  const home = await mkHome();
  const port = await freePort();
  const install = await installLayout(home, { runnerBody: 'process.exit(1);\n' });
  await startFake({ home, version: '1.0.0', port });
  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
  });
  assert.equal(servers[0]?.status, 'failed');
  assert.match(lines.join(''), /run by hand/);
});

test('/api/health returns version on loopback', async () => {
  const server = createWatchServer({
    root: REPO,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    assetDir: path.join(REPO, 'tools', 'watch-assets'),
    deltaFile: path.join(REPO, 'tools', 'watch-delta.mjs'),
    commandList: [],
    contextCommands: async () => [],
  });
  const { port } = await server.listen();
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.pid, 'number');
  await server.close();
});

test('banner text mentions restart needed when versions differ', async () => {
  const src = await readFile(path.join(REPO, 'tools', 'watch-assets', 'board.js'), 'utf8');
  assert.match(src, /restart needed: installed/);
});

test('up to date plus an old running server still restarts it', async () => {
  const home = await mkHome();
  const port = await freePort();
  const fakePath = path.join(home, 'fake-server.mjs');
  await fs.writeFile(fakePath, FAKE_SERVER);
  const record = boardFile({ HOME: home }, home);
  const runnerSimple = `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(fakePath)}], { detached: true, stdio: 'ignore', env: { ...process.env, TEST_PORT: '${port}', TEST_VERSION: '2.0.0', TEST_RECORD_FILE: ${JSON.stringify(record)}, HOME: ${JSON.stringify(home)} } });
child.unref();
`;
  const install = await installLayout(home, { runnerBody: runnerSimple });
  await startFake({ home, version: '1.0.0', port });
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
  });
  await trackPidFromRegistry(record);
  assert.equal(servers[0]?.status, 'restarted');
});
