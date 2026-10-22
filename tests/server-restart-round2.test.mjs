// SPDX-License-Identifier: Apache-2.0
// Finding 13 (/api/health): already correct in watch-server.mjs — no change required.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardFile } from '../tools/watch-cli.mjs';
import {
  commandLineMatchesRecord,
  manualCommand,
  pidProbe,
  restartRegisteredServers,
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-r2-'));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

test('(1) board restart confirms via rewritten board record port, never SIGTERM replacement', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');

  const oldPort = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakeOldPid = 880_001;
  let oldAlive = true;
  let replacementPid = 880_002;
  let replacementKilled = false;

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
  const healthRes = await fetch(`http://127.0.0.1:${newPort}/api/health`, { headers: { Host: `127.0.0.1:${newPort}` } });
  const targetVersion = (await healthRes.json()).version;

  await writeRegistryRecord(file, {
    pid: fakeOldPid,
    url: `http://127.0.0.1:${oldPort}/?t=old`,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port: oldPort,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });

  const lines = [];
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion,
    env: { HOME: home, PATH: process.env.PATH },
    home,
    write: t => lines.push(t),
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
      if (pid === fakeOldPid && sig === 'SIGTERM') oldAlive = false;
      if (pid === replacementPid && sig === 'SIGTERM') replacementKilled = true;
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
        return { ok: true, json: async () => ({ ok: true, version: targetVersion, pid: replacementPid }) };
      }
      return { ok: false, json: async () => null };
    },
  });

  assert.equal(replacementKilled, false);
  assert.equal(servers[0]?.status, 'restarted');
  assert.equal(servers[0]?.port, newPort);
  await newServer.close();
});

test('(3) identity check requires exact runner argv tokens and fails closed on unknown start time', async () => {
  const runner = path.join('/opt/install/current/tools/swarm.mjs');
  const record = { kind: 'board', pid: 1, startedAt: new Date().toISOString(), argv: ['watch', '--all'] };
  assert.equal(
    commandLineMatchesRecord(`${process.execPath} ${runner} watch --all-extra`, record, runner),
    false,
  );
  const loose = await verifyRegistryPid(record, runner, {
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      return { stdout: 'not-a-number\n' };
    },
  });
  assert.equal(loose.ok, false);
  assert.equal(loose.removeRecord, false);
  assert.match(loose.reason, /start time/i);
});

test('(4) ps read failure keeps server record', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const port = await freePort();
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
  await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    execFileImpl: async () => { throw new Error('ps failed'); },
    strictPidCheck: true,
    sleep: async () => {},
  });
  const still = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(still.pid, holder.pid);
  holder.kill('SIGKILL');
});

test('(5) EPERM pid keeps record and reports unowned', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const port = await freePort();
  const file = boardFile({ HOME: home }, home);
  const deniedPid = 770_001;
  await writeRegistryRecord(file, {
    pid: deniedPid,
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
  const realKill = process.kill.bind(process);
  process.kill = (pid, sig) => {
    if (pid === deniedPid && sig === 0) {
      const error = new Error('eperm');
      error.code = 'EPERM';
      throw error;
    }
    return realKill(pid, sig);
  };
  try {
    assert.equal(pidProbe(deniedPid), 'denied');
    const { servers } = await restartRegisteredServers({
      installRoot: install,
      targetVersion: '2.0.0',
      env: { HOME: home, PATH: process.env.PATH },
      home,
      sleep: async () => {},
    });
    assert.equal(servers[0]?.status, 'unowned-pid');
    await fs.access(file);
  } finally {
    process.kill = realKill;
  }
});

test('(9) concurrent restarts serialize on install restart lock', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const port = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakeOldPid = 550_001;
  let alive = true;
  await writeRegistryRecord(file, {
    pid: fakeOldPid,
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

  let seq = 0;
  let releaseFirstHold;
  const firstMayContinue = new Promise(resolve => { releaseFirstHold = resolve; });
  let firstHoldingLockBody = false;
  let secondRestartStarted = false;
  let lockWaitSleepCalls = 0;
  let pidLooksAlive = true;
  const criticalEvents = [];

  const psMocks = async (_cmd, args) => {
    if (args.some(arg => String(arg).includes('command'))) {
      return { stdout: `${process.execPath} ${runner} watch --all\n` };
    }
    return { stdout: '60\n' };
  };

  const run = async () => {
    const callId = ++seq;
    if (callId === 2) secondRestartStarted = true;
    let insideCritical = false;
    const enterCritical = () => {
      if (!insideCritical) {
        insideCritical = true;
        criticalEvents.push(`enter-${callId}`);
      }
    };
    const exitCritical = () => {
      if (insideCritical) {
        insideCritical = false;
        criticalEvents.push(`exit-${callId}`);
      }
    };
    try {
      return await restartRegisteredServers({
        installRoot: install,
        targetVersion: '2.0.0',
        env: { HOME: home, PATH: process.env.PATH },
        home,
        execFileImpl: async (cmd, args) => {
          enterCritical();
          if (callId === 1) {
            firstHoldingLockBody = true;
            await firstMayContinue;
            firstHoldingLockBody = false;
          }
          return psMocks(cmd, args);
        },
        strictPidCheck: true,
        pidAliveImpl: pid => pid === fakeOldPid && pidLooksAlive,
        killImpl: () => {
          pidLooksAlive = false;
          alive = false;
        },
        spawnImpl: () => ({ on: () => {}, unref: () => {}, pid: null }),
        sleep: async ms => {
          if (firstHoldingLockBody && secondRestartStarted) {
            lockWaitSleepCalls += 1;
            releaseFirstHold();
          }
          await new Promise(r => setTimeout(r, typeof ms === 'number' ? ms : 0));
        },
      });
    } finally {
      exitCritical();
      if (callId === 1) pidLooksAlive = true;
    }
  };

  const [firstResult, secondResult] = await Promise.all([run(), run()]);

  assert.ok(lockWaitSleepCalls >= 1, 'second restart must wait on the install lock (sleep while contending)');
  assert.equal(criticalEvents.length, 4, `expected four critical-section events, got ${criticalEvents.join(', ')}`);
  for (let i = 0; i < criticalEvents.length; i += 2) {
    const enter = criticalEvents[i];
    const exit = criticalEvents[i + 1];
    assert.match(enter, /^enter-\d+$/);
    assert.match(exit, /^exit-\d+$/);
    assert.equal(enter.slice('enter-'.length), exit.slice('exit-'.length));
  }
  let criticalDepth = 0;
  for (const ev of criticalEvents) {
    criticalDepth += ev.startsWith('enter-') ? 1 : -1;
    assert.ok(criticalDepth >= 0 && criticalDepth <= 1, `critical sections overlapped: ${criticalEvents.join(', ')}`);
  }
  assert.equal(criticalDepth, 0);
  assert.ok(firstResult && secondResult, 'both concurrent restart calls must resolve');
});

test('(10) forged NODE_OPTIONS is stripped from registry env on read', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const port = await freePort();
  const file = boardFile({ HOME: home }, home);
  const fakePid = 660_001;
  let alive = true;
  await writeRegistryRecord(file, {
    pid: fakePid,
    url: `http://127.0.0.1:${port}/?t=x`,
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port,
    env: { NODE_OPTIONS: '--import=evil', SWARM_BOARD_FILE: file },
    mode: 'background',
    explicitBackground: true,
  });
  let spawnEnv = null;
  await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH, SWARM_BOARD_FILE: file },
    home,
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --all\n` };
      }
      return { stdout: '1\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => pid === fakePid && alive,
    killImpl: pid => { if (pid === fakePid) alive = false; },
    spawnImpl: (_exec, _argv, opts) => {
      spawnEnv = opts.env;
      return { on: () => {}, unref: () => {}, pid: null };
    },
  });
  assert.equal(spawnEnv?.NODE_OPTIONS, undefined);
  assert.equal(spawnEnv?.SWARM_BOARD_FILE, file);
});

test('(11) manualCommand quotes the node binary path', () => {
  const cmd = manualCommand({ runner: '/tmp/swarm.mjs', argv: ['watch'], cwd: '/tmp', env: {} });
  assert.match(cmd, new RegExp(`'${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
});
