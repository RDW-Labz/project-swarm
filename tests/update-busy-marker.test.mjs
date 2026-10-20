// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeBusyMarker } from '../tools/busy-marker.mjs';

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
    assert.match(error.stderr, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(error.stderr, new RegExp(`\\(${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    return true;
  });
});

test('update is not refused for a busy marker with a dead pid', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const root = await tempDir(t);
  await writeBusyMarker({ command: 'node tools/swarm.mjs run x', root, pid: 424242, dir: busyDir });
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

test('a BUSY_MARKER_VERBS command writes a marker while running and removes it on exit', async t => {
  const busyDir = await tempDir(t);
  const home = await tempDir(t);
  const child = spawn(process.execPath, [swarmPath, 'ship', '--help'], {
    cwd: packageRoot,
    env: swarmEnv(busyDir, home),
    stdio: 'ignore',
  });
  const markerPath = path.join(busyDir, `${child.pid}.json`);
  let sawMarker = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await fs.access(markerPath);
      sawMarker = true;
      break;
    } catch { /* not yet */ }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0);
  assert.equal(sawMarker, true, 'expected a busy marker while ship --help was running');
  await assert.rejects(fs.access(markerPath));
});
