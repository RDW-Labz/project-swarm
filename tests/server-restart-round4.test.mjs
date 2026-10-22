// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  commandLineMatchesRecord,
  formatProcessLockPayload,
  isProcessLockStale,
  parseProcessLockPayload,
  startProcessLockRefresh,
  stealProcessLockIfStale,
  tokenizePsArgs,
  verifyRegistryPid,
  withProcessLock,
  writeRegistryRecord,
} from '../tools/server-restart.mjs';
const execFileAsync = promisify(execFile);

async function mkHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'restart-r4-'));
  await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true, mode: 0o700 });
  return home;
}

test('(1) live lock holder older than 60s keeps lock; second acquirer waits', async () => {
  const home = await mkHome();
  const lockPath = path.join(home, '.server-restart.lock');
  await fs.mkdir(home, { recursive: true });
  const ownerStartedAt = new Date(Date.now() - 120_000).toISOString();
  await fs.writeFile(
    lockPath,
    formatProcessLockPayload(process.pid, ownerStartedAt, new Date(Date.now() - 90_000).toISOString()),
    { mode: 0o600 },
  );
  const execFileImpl = async (_cmd, args) => {
    if (args.some(arg => String(arg).includes('args'))) return { stdout: `${process.execPath} swarm\n` };
    if (args.some(arg => String(arg).includes('etime'))) return { stdout: '02:00\n' };
    return { stdout: '' };
  };
  assert.equal(
    await isProcessLockStale(lockPath, { isAlive: () => true, maxAgeMs: 60_000, execFileImpl }),
    false,
  );
  assert.equal(
    await stealProcessLockIfStale(lockPath, { isAlive: () => true, maxAgeMs: 60_000, execFileImpl }),
    false,
  );
});

test('(2) dead-owner lock is stolen', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const lockPath = path.join(install, '.server-restart.lock');
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(lockPath, formatProcessLockPayload(424242, new Date().toISOString()), { mode: 0o600 });
  assert.equal(await stealProcessLockIfStale(lockPath, { isAlive: () => false }), true);
  await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
});

test('(3) steal does not remove a recreated lock with a different owner', async () => {
  const home = await mkHome();
  const lockPath = path.join(home, '.server-restart.lock');
  await fs.mkdir(home, { recursive: true });
  const staleOwner = formatProcessLockPayload(1, new Date(Date.now() - 120_000).toISOString());
  await fs.writeFile(lockPath, staleOwner, { mode: 0o600 });
  const recreated = formatProcessLockPayload(2, new Date().toISOString());
  assert.equal(await stealProcessLockIfStale(lockPath, {
    isAlive: () => false,
    maxAgeMs: 60_000,
    renameImpl: async (from, to) => {
      await fs.rename(from, to);
      if (from === lockPath) await fs.writeFile(lockPath, recreated, { mode: 0o600 });
    },
  }), false);
  const left = await fs.readFile(lockPath, 'utf8');
  assert.equal(parseProcessLockPayload(left).pid, 2);
});

test('(4) refresh timer updates timestamp and clears on release', async () => {
  const home = await mkHome();
  const lockPath = path.join(home, 'lock');
  await fs.mkdir(home, { recursive: true });
  const ownerStartedAt = Date.now() - 30_000;
  const ownerIdentity = { pid: process.pid, ownerStartedAt };
  await fs.writeFile(lockPath, formatProcessLockPayload(process.pid, ownerStartedAt, new Date().toISOString()), { mode: 0o600 });
  let refreshCount = 0;
  const clear = startProcessLockRefresh(lockPath, ownerIdentity, {
    intervalMs: 30,
    refresh: async () => {
      refreshCount += 1;
      await fs.writeFile(
        lockPath,
        formatProcessLockPayload(process.pid, ownerStartedAt, new Date().toISOString()),
        { mode: 0o600 },
      );
    },
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(refreshCount >= 1);
  clear();
  const before = refreshCount;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(refreshCount, before);
});

test('(5) versions-folder runner path matches and restart proceeds to identity check', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const versionedRunner = path.join(install, 'versions', '1.0.0', 'tools', 'swarm.mjs');
  const currentRunner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(versionedRunner), { recursive: true });
  await fs.mkdir(path.dirname(currentRunner), { recursive: true });
  await fs.writeFile(versionedRunner, 'export {}\n');
  await fs.writeFile(currentRunner, 'export {}\n');
  const file = path.join(home, '.project-swarm', 'board.json');
  const fakePid = 881_004;
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
    runner: versionedRunner,
    runnerRealpath: versionedRunner,
  });
  const cmd = `${process.execPath} ${versionedRunner} watch --all`;
  assert.equal(
    commandLineMatchesRecord(cmd, { kind: 'board', argv: ['watch', '--all'] }, { installRoot: install, fallbackRunner: currentRunner }),
    true,
  );
  const verified = await verifyRegistryPid({
    kind: 'board',
    pid: fakePid,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    argv: ['watch', '--all'],
    runner: versionedRunner,
    runnerRealpath: versionedRunner,
  }, currentRunner, {
    installRoot: install,
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('args'))) {
        return { stdout: cmd };
      }
      return { stdout: '00:10\n' };
    },
  });
  assert.equal(verified.ok, true);
});

test('(6) mismatching process stays identity-unverified', async () => {
  const home = await mkHome();
  const install = path.join(home, 'install');
  const runner = path.join(install, 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, 'export {}\n');
  const file = path.join(home, '.project-swarm', 'board.json');
  const fakePid = 881_005;
  await writeRegistryRecord(file, {
    pid: fakePid,
    runner,
    runnerRealpath: runner,
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
  const verified = await verifyRegistryPid({
    kind: 'board',
    pid: fakePid,
    startedAt: new Date().toISOString(),
    argv: ['watch', '--all'],
    runner,
    runnerRealpath: runner,
  }, runner, {
    installRoot: install,
    execFileImpl: async (_cmd, args) => {
      if (args.some(arg => String(arg).includes('args'))) {
        return { stdout: `${process.execPath} ${runner} watch --other\n` };
      }
      return { stdout: '10:00\n' };
    },
  });
  assert.equal(verified.ok, false);
});

test('(7) path with spaces in install root matches via ps args tokenization', async () => {
  const home = await mkHome();
  const spaced = path.join(home, 'my install', 'current', 'tools', 'swarm.mjs');
  await fs.mkdir(path.dirname(spaced), { recursive: true });
  await fs.writeFile(spaced, 'export {}\n');
  const cmd = `${process.execPath} ${spaced} watch --all`;
  const tokens = tokenizePsArgs(cmd);
  assert.ok(tokens.includes(spaced));
  assert.equal(
    commandLineMatchesRecord(cmd, { kind: 'board', argv: ['watch', '--all'], runner: spaced, runnerRealpath: spaced }, { installRoot: path.join(home, 'my install') }),
    true,
  );
});

test('(8) withProcessLock second caller waits while holder keeps lock', async () => {
  const home = await mkHome();
  const lockPath = path.join(home, 'held.lock');
  await fs.mkdir(home, { recursive: true });
  const holder = withProcessLock(lockPath, async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
  }, { timeoutMs: 5000, execFileImpl: execFileAsync });
  await new Promise(resolve => setTimeout(resolve, 20));
  let acquired = false;
  const waiter = withProcessLock(lockPath, async () => { acquired = true; }, {
    timeoutMs: 80,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    execFileImpl: execFileAsync,
  }).catch(() => {});
  await Promise.all([holder, waiter]);
  assert.equal(acquired, false);
});
