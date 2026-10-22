// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardFile, serverRecordVersion, startBoardServer } from '../tools/watch-cli.mjs';
import { runnerVersion } from '../tools/runner-version.mjs';
import {
  restartRegisteredServers,
  writeRegistryRecord,
} from '../tools/server-restart.mjs';
import { createWatchServer } from '../tools/watch-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SWARM_RUNNER_URL = new URL('../tools/swarm.mjs', import.meta.url).href;

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'server-record-ver-'));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

test('started board record has runner version without SWARM_INSTALL_DIR', async t => {
  const home = await mkHome();
  t.after(async () => fs.rm(home, { recursive: true, force: true }));
  const boardPath = path.join(home, '.project-swarm', 'board.json');
  const env = { HOME: home, PATH: process.env.PATH, SWARM_BOARD_FILE: boardPath };
  delete env.SWARM_INSTALL_DIR;

  const expected = await runnerVersion(SWARM_RUNNER_URL);
  const board = await startBoardServer({
    env,
    root: REPO,
    registry: { explicitBackground: true },
  });
  t.after(async () => {
    await board.server.close().catch(() => {});
    await board.api.close().catch(() => {});
  });

  const record = JSON.parse(await fs.readFile(boardPath, 'utf8'));
  assert.equal(typeof record.version, 'string');
  assert.equal(record.version, expected);
  assert.equal(record.version, await serverRecordVersion(new URL('../tools/watch-cli.mjs', import.meta.url).href));
});

test('null version record with verified pid is restarted', async t => {
  const home = await mkHome();
  t.after(async () => fs.rm(home, { recursive: true, force: true }));
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');

  const oldPort = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakeOldPid = 881_001;
  let oldAlive = true;
  let replacementPid = 881_002;
  let sigtermPids = [];

  const newServer = createWatchServer({
    root: REPO,
    getRunSnapshot: async () => null,
    getPlanSnapshot: async () => ({ present: false }),
    getGallery: async () => ({ schema: 1, screens: [] }),
    assetDir: path.join(REPO, 'tools', 'watch-assets'),
    deltaFile: path.join(REPO, 'tools', 'watch-delta.mjs'),
    commandList: [],
    contextCommands: async () => [],
  });
  const { port: newPort } = await newServer.listen();
  t.after(async () => newServer.close().catch(() => {}));
  const healthRes = await fetch(`http://127.0.0.1:${newPort}/api/health`, { headers: { Host: `127.0.0.1:${newPort}` } });
  const targetVersion = (await healthRes.json()).version;

  await writeRegistryRecord(file, {
    pid: fakeOldPid,
    url: `http://127.0.0.1:${oldPort}/?t=old`,
    startedAt: new Date().toISOString(),
    version: null,
    argv: ['watch', '--all'],
    cwd: home,
    port: oldPort,
    env: {},
    mode: 'background',
    explicitBackground: true,
    runner,
    runnerRealpath: runner,
  });

  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion,
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: line => lines.push(line),
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      return { stdout: '3600\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => (pid === fakeOldPid ? oldAlive : pid === replacementPid),
    killImpl: (pid, sig) => {
      sigtermPids.push(pid);
      if (pid === fakeOldPid && sig === 'SIGTERM') oldAlive = false;
    },
    spawnImpl: () => {
      void writeRegistryRecord(file, {
        pid: replacementPid,
        url: `http://127.0.0.1:${newPort}/?t=new`,
        startedAt: new Date().toISOString(),
        version: targetVersion,
        argv: ['watch', '--all'],
        cwd: home,
        port: newPort,
        env: {},
        mode: 'background',
        explicitBackground: true,
      });
      return { on: () => {}, unref: () => {}, pid: replacementPid };
    },
    fetchImpl: async url => {
      if (String(url).includes(`:${newPort}/`)) {
        return { ok: true, json: async () => ({ version: targetVersion, pid: replacementPid }) };
      }
      return { ok: false };
    },
  });

  assert.ok(servers.some(s => s.status === 'restarted'));
  assert.ok(sigtermPids.includes(fakeOldPid));
});

test('record with pid identity mismatch is not signalled', async t => {
  const home = await mkHome();
  t.after(async () => fs.rm(home, { recursive: true, force: true }));
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');

  const port = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakePid = 882_001;
  const sigtermPids = [];

  await writeRegistryRecord(file, {
    pid: fakePid,
    url: `http://127.0.0.1:${port}/?t=old`,
    startedAt: new Date().toISOString(),
    version: null,
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: {},
    mode: 'background',
    explicitBackground: true,
    runner,
    runnerRealpath: runner,
  });

  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '9.9.9',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: () => {},
    execFileImpl: async () => ({ stdout: `${process.execPath} /other/swarm.mjs watch --all\n` }),
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => pid === fakePid,
    killImpl: (pid, sig) => {
      if (sig === 'SIGTERM') sigtermPids.push(pid);
    },
  });

  assert.ok(servers.some(s => s.status === 'identity-unverified'));
  assert.equal(sigtermPids.length, 0);
});
