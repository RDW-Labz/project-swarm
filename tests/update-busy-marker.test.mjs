// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeBusyMarker } from '../tools/busy-marker.mjs';
import { runningSwarmCommands } from '../tools/live-processes.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarmPath = path.join(packageRoot, 'tools/swarm.mjs');
const execFileAsync = promisify(execFile);

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-update-busy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}

function swarmEnv(busyDir, home, extra = {}) {
  return { ...process.env, HOME: home, SWARM_BUSY_DIR: busyDir, ...extra };
}

async function isolatedSwarmFixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-busy-e2e-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const busyDir = path.join(dir, 'busy');
  await fs.mkdir(busyDir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ machineConcurrency: 4, lanes: { anthropic: { model: 'm' } } }));
  const env = {
    ...process.env,
    HOME: dir,
    SWARM_BUSY_DIR: busyDir,
    SWARM_CONFIG: configFile,
    SWARM_BOARD_FILE: path.join(dir, 'board.json'),
    SWARM_PROJECTS_FILE: path.join(dir, 'projects.json'),
    SWARM_HISTORY_FILE: path.join(dir, 'h.ndjson'),
    SWARM_LANES_DIR: path.join(dir, 'lanes'),
    SWARM_SPEND_DIR: path.join(dir, 'spend'),
    SWARM_PHONE_DIR: path.join(dir, 'phone'),
  };
  return { dir, busyDir, env };
}

function spawnClosePromise(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

function spawnExitedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', () => resolve(child.pid));
  });
}

async function findBusyMarker(busyDir, predicate) {
  let entries;
  try {
    entries = await fs.readdir(busyDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const full = path.join(busyDir, entry);
    let record;
    try {
      record = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch {
      continue;
    }
    if (predicate(entry, record)) return { entry, record, full };
  }
  return null;
}

function waitForBusyMarker(busyDir, predicate) {
  return new Promise((resolve, reject) => {
    let watcher;
    const finish = (hit, error) => {
      try {
        watcher?.close();
      } catch {
        /* closed */
      }
      if (error) reject(error);
      else resolve(hit);
    };
    const probe = () =>
      findBusyMarker(busyDir, predicate).then(hit => {
        if (hit) finish(hit);
      });
    try {
      watcher = fsSync.watch(busyDir, () => {
        probe().catch(err => finish(null, err));
      });
    } catch (error) {
      reject(error);
      return;
    }
    probe().catch(err => finish(null, err));
  });
}

async function runUpdate(busyDir, home, args = []) {
  try {
    return await execFileAsync(process.execPath, [swarmPath, 'update', ...args], {
      cwd: packageRoot,
      env: swarmEnv(busyDir, home),
      encoding: 'utf8',
    });
  } catch (error) {
    error.stdout ??= '';
    error.stderr ??= '';
    throw error;
  }
}

test('update refuses when a live busy marker from another pid is present', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const root = await tempDir(t);
  const command = 'node tools/swarm.mjs go --scope x';
  const remove = await writeBusyMarker({ command, root, dir: busyDir });
  t.after(() => remove());
  await assert.rejects(runUpdate(busyDir, home), error => {
    assert.match(error.stderr, /update-refused/);
    assert.match(error.stderr, new RegExp(`process\\s+${process.pid}`));
    assert.match(error.stderr, /swarm go/);
    assert.match(error.stderr, new RegExp(`\\(${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    return true;
  });
});

test('update is not refused for a busy marker with a dead pid', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const root = await tempDir(t);
  const deadPid = await spawnExitedPid();
  await writeBusyMarker({ command: 'node tools/swarm.mjs run x', root, pid: deadPid, dir: busyDir });
  try {
    const { stderr } = await runUpdate(busyDir, home);
    assert.doesNotMatch(stderr, /update-refused/);
  } catch (error) {
    assert.doesNotMatch(error.stderr ?? '', /update-refused/);
  }
});

test('update --force is not refused over a live busy marker', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const root = await tempDir(t);
  const remove = await writeBusyMarker({ command: 'node tools/swarm.mjs ship', root, dir: busyDir });
  try {
    const { stderr } = await runUpdate(busyDir, home, ['--force']);
    assert.doesNotMatch(stderr, /update-refused/);
  } catch (error) {
    assert.doesNotMatch(error.stderr ?? '', /update-refused/);
  } finally {
    await remove();
  }
});

test('with-concurrency writes a busy marker for the swarm pid while the wrapped command runs and removes it on exit', async t => {
  const f = await isolatedSwarmFixture(t);
  const holdScript = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
  const child = spawn(
    process.execPath,
    [swarmPath, 'with-concurrency', '1', '--', 'node', '-e', holdScript],
    { cwd: packageRoot, env: f.env, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  const closed = spawnClosePromise(child);
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  });

  const marker = await waitForBusyMarker(f.busyDir, () => true);
  assert.equal(marker.entry, `${child.pid}.json`);
  assert.equal(marker.record.pid, child.pid);
  assert.equal(marker.record.command, 'swarm with-concurrency');

  child.stdin.end();
  await closed;
  await assert.rejects(fs.access(path.join(f.busyDir, `${child.pid}.json`)));
});

test('a swarm autopilot process line is not reported by runningSwarmCommands', () => {
  const ps = () => '  201 node /h/.project-swarm/current/tools/swarm.mjs autopilot --interval 600 --root /p';
  assert.deepEqual(runningSwarmCommands({ ps, selfPid: 1 }), []);
});

test('update refuses while an autopilot step busy marker is present and allows update after it is removed', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const root = await tempDir(t);
  const remove = await writeBusyMarker({ command: 'swarm autopilot', root, dir: busyDir });
  await assert.rejects(runUpdate(busyDir, home), error => {
    assert.match(error.stderr, /update-refused/);
    assert.match(error.stderr, /swarm autopilot/);
    return true;
  });
  await remove();
  try {
    const { stderr } = await runUpdate(busyDir, home);
    assert.doesNotMatch(stderr, /update-refused/);
  } catch (error) {
    assert.doesNotMatch(error.stderr ?? '', /update-refused/);
  }
});

test('run that fails immediately does not leave a busy marker behind', async t => {
  const f = await isolatedSwarmFixture(t);
  const missing = path.join(f.dir, 'no-such-manifest.json');
  const child = spawn(
    process.execPath,
    [swarmPath, '--root', f.dir, 'run', missing],
    { cwd: packageRoot, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const closed = spawnClosePromise(child);
  const result = await closed;
  assert.notEqual(result.code, 0);
  const leftover = await findBusyMarker(f.busyDir, () => true);
  assert.equal(leftover, null);
});
