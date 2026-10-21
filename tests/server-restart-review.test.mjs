// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFile, registryModeFields, serverMode } from '../tools/watch-cli.mjs';
import {
  argvWithoutOpen,
  commandLineMatchesRecord,
  manualCommand,
  registryEnv,
  restartRegisteredServers,
  resolveRunnerForRestart,
  verifyRegistryPid,
  writeRegistryRecord,
} from '../tools/server-restart.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-review-'));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

test('(1a) command-line mismatch is not signalled and record is kept', async () => {
  const home = await mkHome();
  const port = await freePort();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  const file = boardFile({ HOME: home }, home);
  await writeRegistryRecord(file, {
    pid: holder.pid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });
  const lines = [];
  let signalled = false;
  const realKill = process.kill.bind(process);
  process.kill = (pid, sig) => {
    if (sig === 'SIGTERM' && pid === holder.pid) signalled = true;
    return realKill(pid, sig);
  };
  try {
    const { servers } = await restartRegisteredServers({
      installRoot: install,
      targetVersion: '2.0.0',
      env: registryEnv({ HOME: home, PATH: process.env.PATH }, home),
      home,
      write: t => lines.push(t),
      execFileImpl: async (_cmd, args) => {
        if (args.some(arg => String(arg).includes('command'))) return { stdout: 'node /other/script.mjs\n' };
        return { stdout: '1\n' };
      },
      strictPidCheck: true,
      sleep: async () => {},
    });
    assert.equal(signalled, false);
    assert.equal(servers[0]?.status, 'identity-unverified');
    assert.match(lines.join(''), /record kept/i);
    const kept = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(kept.pid, holder.pid);
  } finally {
    process.kill = realKill;
    holder.kill('SIGKILL');
  }
});

test('(1b) process start newer than record is not signalled and record is removed', async () => {
  const home = await mkHome();
  const port = await freePort();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  const file = boardFile({ HOME: home }, home);
  const recordStartedAt = new Date('2020-01-01T00:00:00.000Z').toISOString();
  await writeRegistryRecord(file, {
    pid: holder.pid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: recordStartedAt,
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });
  const lines = [];
  let signalled = false;
  const realKill = process.kill.bind(process);
  process.kill = (pid, sig) => {
    if (sig === 'SIGTERM' && pid === holder.pid) signalled = true;
    return realKill(pid, sig);
  };
  try {
    const { servers } = await restartRegisteredServers({
      installRoot: install,
      targetVersion: '2.0.0',
      env: registryEnv({ HOME: home, PATH: process.env.PATH }, home),
      home,
      write: t => lines.push(t),
      execFileImpl: async (_cmd, args) => {
        if (args.some(arg => String(arg).includes('command'))) {
          return { stdout: `${process.execPath} ${runner} watch --all\n` };
        }
        return { stdout: '1\n' };
      },
      strictPidCheck: true,
      sleep: async () => {},
      pidAliveImpl: () => true,
    });
    assert.equal(signalled, false);
    assert.equal(servers[0]?.status, 'stale-record');
    assert.match(lines.join(''), /stale server record/i);
    await assert.rejects(() => fs.readFile(file), { code: 'ENOENT' });
  } finally {
    process.kill = realKill;
    holder.kill('SIGKILL');
  }
});

test('(2) restart validates cwd and streams report lines before finishing', async () => {
  const home = await mkHome();
  const port = await freePort();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  const file = boardFile({ HOME: home }, home);
  await writeRegistryRecord(file, {
    pid: holder.pid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: path.join(home, 'missing-cwd'),
    port,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });
  const lines = [];
  await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: registryEnv({ HOME: home, PATH: process.env.PATH }, home),
    home,
    write: t => lines.push(t),
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      return { stdout: '1\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
  });
  assert.ok(lines.length > 0);
  assert.match(lines.join(''), /cwd missing/);
  holder.kill('SIGKILL');
});

test('(3) failed restart is loud, status failed, and ends with manual command', async () => {
  const home = await mkHome();
  const port = await freePort();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'process.exit(0);\n');
  const file = boardFile({ HOME: home }, home);
  const fakePid = 424_242;
  let alive = true;
  await writeRegistryRecord(file, {
    pid: fakePid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: { SWARM_BOARD_FILE: file },
    mode: 'background',
    explicitBackground: true,
  });
  const lines = [];
  const manual = manualCommand({ runner, argv: ['watch', '--all'], cwd: home, env: { SWARM_BOARD_FILE: file } });
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: registryEnv({ HOME: home, PATH: process.env.PATH, SWARM_BOARD_FILE: file }, home),
    home,
    write: t => lines.push(t),
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      return { stdout: '1\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => pid === fakePid && alive,
    killImpl: (pid, signal) => {
      if (pid === fakePid && signal === 'SIGTERM') alive = false;
    },
    spawnImpl: () => ({ on: () => {}, unref: () => {}, pid: null }),
  });
  assert.equal(servers[0]?.status, 'failed');
  const joined = lines.join('');
  assert.match(joined, /old server stopped but replacement did not come up/);
  assert.ok(joined.trimEnd().endsWith(manual));
});

test('(3b) invalid port is reported failure not thrown', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const file = boardFile({ HOME: home }, home);
  await writeRegistryRecord(file, {
    pid: 999_999,
    url: 'http://127.0.0.1:9/?t=x',
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port: 70000,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: registryEnv({ HOME: home, PATH: process.env.PATH }, home),
    home,
  });
  assert.equal(servers[0]?.status, 'failed');
});

test('(4) runner resolves under current then versions', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const versioned = path.join(install, 'versions', '2.0.0', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(versioned), { recursive: true });
  await fs.writeFile(versioned, 'export {}\n');
  const resolved = await resolveRunnerForRestart(install, '2.0.0');
  assert.equal(resolved.source, 'versions');
  assert.equal(resolved.runner, versioned);
});

test('(6) manualCommand never prints environment values', () => {
  const cmd = manualCommand({
    runner: '/tmp/swarm.mjs',
    argv: ['watch'],
    cwd: '/tmp',
    env: { SWARM_SECRET: 'hidden-value', PATH: '/bin' },
  });
  assert.doesNotMatch(cmd, /hidden-value/);
  assert.match(cmd, /export SWARM_SECRET/);
});

test('(7) registryEnv keeps custom board and remote record paths', () => {
  const env = registryEnv({
    HOME: '/h',
    PATH: '/p',
    SWARM_BOARD_FILE: '/custom/board.json',
    SWARM_REMOTE_SERVER_FILE: '/custom/remote.json',
  }, '/h');
  assert.equal(env.SWARM_BOARD_FILE, '/custom/board.json');
  assert.equal(env.SWARM_REMOTE_SERVER_FILE, '/custom/remote.json');
});

test('(8) argvWithoutOpen strips --open on restart', () => {
  assert.deepEqual(argvWithoutOpen(['watch', '--all', '--open']), ['watch', '--all']);
});

test('(8b) serverMode only backgrounds with explicit flag and no tty', () => {
  assert.equal(serverMode({ stdin: { isTTY: false }, stdout: { isTTY: true }, explicitBackground: true }), 'terminal');
  assert.equal(serverMode({ stdin: { isTTY: false }, stdout: { isTTY: false }, explicitBackground: true }), 'background');
  const fields = registryModeFields('background', { stdin: { isTTY: false }, stdout: { isTTY: false }, explicitBackground: true });
  assert.equal(fields.explicitBackground, true);
});

test('(8c) /api/health is loopback-only and returns only version and pid', async () => {
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
  const ok = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Host: `127.0.0.1:${port}` } });
  const body = await ok.json();
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.pid, 'number');
  assert.deepEqual(Object.keys(body).filter(k => k !== 'ok').sort(), ['pid', 'version']);
  const badStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      headers: { Host: `example.com:${port}` },
    }, res => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
  assert.equal(badStatus, 421);
  await server.close();
  await Promise.race([server.done, new Promise(resolve => setTimeout(resolve, 2000))]);
});

test('(1b) verifyRegistryPid accepts matching command and start time', async () => {
  const runner = '/opt/project-swarm/current/tools/swarm.mjs';
  const record = {
    kind: 'board',
    pid: 42,
    startedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    argv: ['watch', '--all'],
  };
  const recordStart = Date.parse(record.startedAt);
  const result = await verifyRegistryPid(record, runner, {
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      const elapsed = Math.max(0, Math.round((Date.now() - recordStart) / 1000));
      return { stdout: `${elapsed}\n` };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(commandLineMatchesRecord(`${process.execPath} ${runner} watch --all`, record, runner), true);
});
