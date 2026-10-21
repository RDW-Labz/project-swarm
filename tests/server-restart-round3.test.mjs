// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  commandLineMatchesRecord,
  parsePsEtime,
  readProcessIdentity,
  removeRegistryRecordIfUnchanged,
  restartRegisteredServers,
  stealProcessLockIfStale,
  verifyRegistryPid,
  writeRegistryRecord,
} from '../tools/server-restart.mjs';
import { boardFile, startBoardServer } from '../tools/watch-cli.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function mkHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-r3-'));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

test('(1) real ps reads this process and identity check passes for matching command', async () => {
  let psWorks = true;
  try {
    await execFileAsync('ps', ['-o', 'command=', '-p', String(process.pid)]);
  } catch {
    psWorks = false;
  }
  if (!psWorks) return;

  const home = await mkHome();
  const runner = path.join(home, 'swarm.mjs');
  await fs.writeFile(runner, 'setInterval(() => {}, 1e6);\n');
  const child = spawn(process.execPath, [runner, 'watch', '--all'], {
    cwd: home,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  const identity = await readProcessIdentity(child.pid, { execFileImpl: execFileAsync });
  assert.ok(identity?.command);
  assert.ok(typeof identity.startedAt === 'number' || identity.startedAt === null);

  const recordStartedAt = new Date((identity.startedAt ?? Date.now()) - 1000).toISOString();
  const verified = await verifyRegistryPid({
    kind: 'board',
    pid: child.pid,
    startedAt: recordStartedAt,
    argv: ['watch', '--all'],
  }, runner, { execFileImpl: execFileAsync });
  assert.equal(verified.ok, true);
  child.kill('SIGKILL');
});

test('(1a) real ps: record startedAt after process start still verifies when command matches', async () => {
  let psWorks = true;
  try {
    await execFileAsync('ps', ['-o', 'command=', '-p', String(process.pid)]);
  } catch {
    psWorks = false;
  }
  if (!psWorks) return;

  const home = await mkHome();
  const runner = path.join(home, 'swarm.mjs');
  await fs.writeFile(runner, 'setInterval(() => {}, 1e6);\n');
  const child = spawn(process.execPath, [runner, 'watch', '--all'], {
    cwd: home,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });

  const identity = await readProcessIdentity(child.pid, { execFileImpl: execFileAsync });
  assert.ok(identity?.startedAt !== null);

  const verified = await verifyRegistryPid({
    kind: 'board',
    pid: child.pid,
    startedAt: new Date(identity.startedAt + 3600_000).toISOString(),
    argv: ['watch', '--all'],
  }, runner, { execFileImpl: execFileAsync });
  assert.equal(verified.ok, true);
  child.kill('SIGKILL');
});

test('(1b) parsePsEtime handles day and clock forms', () => {
  assert.equal(parsePsEtime('01:23'), 83);
  assert.equal(parsePsEtime('1:02:03'), 3723);
  assert.equal(parsePsEtime('2-03:04:05'), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
});

test('(2) stale restart lock with dead pid is stolen', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const lockPath = path.join(install, '.server-restart.lock');
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(lockPath, `999999\n${new Date().toISOString()}\n`, { mode: 0o600 });
  assert.equal(await stealProcessLockIfStale(lockPath, { isAlive: () => false }), true);
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
});

test('(3) command mismatch keeps record as identity-unverified', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const file = boardFile({ HOME: home }, home);
  const fakePid = 881_001;
  await writeRegistryRecord(file, {
    pid: fakePid,
    url: 'http://127.0.0.1:9/?t=x',
    startedAt: new Date().toISOString(),
    version: '1.0.0',
    argv: ['watch', '--all'],
    cwd: home,
    port: 9,
    env: {},
    mode: 'background',
    explicitBackground: true,
  });
  const { servers } = await restartRegisteredServers({
    installRoot: install,
    targetVersion: '2.0.0',
    env: { HOME: home, PATH: process.env.PATH },
    home,
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('command'))) {
        return { stdout: `${process.execPath} ${runner} watch --other\n` };
      }
      return { stdout: '10:00\n' };
    },
    strictPidCheck: true,
    sleep: async () => {},
    pidAliveImpl: pid => pid === fakePid,
  });
  assert.equal(servers[0]?.status, 'identity-unverified');
  await fs.access(file);
});

test('(9) dead pid removal skips when record changed concurrently', async () => {
  const home = await mkHome();
  const file = boardFile({ HOME: home }, home);
  await writeRegistryRecord(file, {
    pid: 1,
    url: 'http://127.0.0.1:9/?t=old',
    startedAt: '2020-01-01T00:00:00.000Z',
    version: '1.0.0',
    argv: ['watch'],
    cwd: home,
    port: 9,
    env: {},
    mode: 'background',
  });
  const removed = await removeRegistryRecordIfUnchanged(file, {
    pid: 1,
    startedAt: '2020-01-01T00:00:00.000Z',
    url: 'http://127.0.0.1:9/?t=old',
    version: '1.0.0',
  });
  assert.equal(removed, true);
  await writeRegistryRecord(file, {
    pid: 2,
    url: 'http://127.0.0.1:9/?t=new',
    startedAt: new Date().toISOString(),
    version: '2.0.0',
    argv: ['watch'],
    cwd: home,
    port: 9,
    env: {},
    mode: 'background',
  });
  const skipped = await removeRegistryRecordIfUnchanged(file, {
    pid: 1,
    startedAt: '2020-01-01T00:00:00.000Z',
    url: 'http://127.0.0.1:9/?t=old',
    version: '1.0.0',
  });
  assert.equal(skipped, false);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(data.pid, 2);
});

test('(10) failed board record write is reported', async () => {
  const home = await mkHome();
  const boardPath = path.join(home, '.project-swarm', 'board.json');
  await fs.mkdir(path.dirname(boardPath), { recursive: true });
  await fs.mkdir(boardPath);
  const messages = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => {
    messages.push(String(chunk));
    return true;
  };
  let board;
  try {
    board = await startBoardServer({
      env: { HOME: home, PATH: process.env.PATH, SWARM_BOARD_FILE: boardPath },
      root: home,
    });
  } finally {
    process.stderr.write = realWrite;
    await board?.server?.close?.().catch(() => {});
    await board?.api?.close?.().catch(() => {});
  }
  assert.ok(messages.some(line => /board server record write failed/i.test(line)));
});

test('(3b) realpath symlink runner matches command line token', async () => {
  const home = await mkHome();
  const dir = path.join(home, 'versions', '1.0.0', 'tools');
  await fs.mkdir(dir, { recursive: true });
  const realRunner = path.join(dir, 'swarm.mjs');
  await fs.writeFile(realRunner, 'export {}\n');
  const linkRunner = path.join(home, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(linkRunner), { recursive: true });
  await fs.symlink(realRunner, linkRunner);
  const cmd = `${process.execPath} ${linkRunner} watch --all`;
  assert.equal(
    commandLineMatchesRecord(cmd, { kind: 'board', argv: ['watch', '--all'] }, realRunner),
    true,
  );
});
