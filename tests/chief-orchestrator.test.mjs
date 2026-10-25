// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  acquireChiefLock,
  chiefLockPath,
  chiefMachineDir,
  chiefOrchestratorEnabled,
  runChiefOnce,
  runChiefWave,
} from '../tools/chief-orchestrator.mjs';
import { planCrossProjectWave } from '../tools/chief-slots.mjs';

const exec = promisify(execFile);
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/chief-orchestrator.mjs');

const tmpHome = async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chief-home-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.config', 'project-swarm');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), `${JSON.stringify({ chief_orchestrator: true, machineConcurrency: 4 }, null, 2)}\n`);
  return { home, configDir };
};

test('chief_orchestrator defaults off unless explicitly enabled', () => {
  assert.equal(chiefOrchestratorEnabled({}), false);
  assert.equal(chiefOrchestratorEnabled({ chief_orchestrator: false }), false);
  assert.equal(chiefOrchestratorEnabled({ chief_orchestrator: true }), true);
});

test('with chief_orchestrator on, a second chief start exits non-zero and the first keeps running', async t => {
  const { home, configDir } = await tmpHome(t);
  const env = { ...process.env, HOME: home, SWARM_CONFIG: path.join(configDir, 'config.json') };
  const hold = spawn(process.execPath, [script, 'run', '--hold-ms', '20000'], { env, stdio: 'pipe' });
  t.after(() => { hold.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('first chief did not start')), 5000);
    const onData = chunk => {
      if (String(chunk).includes('chief-running') || hold.pid) {
        clearTimeout(timer);
        hold.stdout?.off('data', onData);
        resolve();
      }
    };
    hold.stderr.on('data', onData);
    hold.stdout.on('data', onData);
    setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, 500);
  });
  const lock = chiefLockPath(configDir);
  const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
  assert.equal(owner.pid, hold.pid);
  await assert.rejects(exec(process.execPath, [script, 'run', '--once'], { env }), error => /chief-running/.test(`${error.stderr}${error.stdout}`));
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, hold.pid, 'the live chief still owns the lock');
  hold.kill();
  await new Promise(resolve => hold.once('exit', resolve));
});

test('acquireChiefLock refuses a live owner and clears a dead one', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chief-lock-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const release = await acquireChiefLock(dir, { pid: 101, isAlive: () => true });
  await assert.rejects(acquireChiefLock(dir, { pid: 202, isAlive: () => true }), /chief-running: pid 101/);
  await release();
  await fs.writeFile(chiefLockPath(dir), JSON.stringify({ pid: 999999 }));
  await acquireChiefLock(dir, { pid: 303, isAlive: () => false });
});

test('with two projects each having ready tickets and machine cap 4, the chief starts both in one wave', async () => {
  const plan = planCrossProjectWave(
    [{ project: 'alpha', ready: 6 }, { project: 'beta', ready: 6 }],
    4,
  );
  assert.deepEqual(plan.sort((a, b) => a.project.localeCompare(b.project)), [
    { project: 'alpha', starts: 2 },
    { project: 'beta', starts: 2 },
  ]);
  const started = { alpha: 0, beta: 0 };
  const result = await runChiefWave(
    [
      { project: 'alpha', ready: 6, start: n => { started.alpha += n; } },
      { project: 'beta', ready: 6, start: n => { started.beta += n; } },
    ],
    { machineCap: 4 },
  );
  assert.deepEqual(result.started.sort((a, b) => a.project.localeCompare(b.project)), plan);
  assert.deepEqual(started, { alpha: 2, beta: 2 });
  assert.equal(started.alpha + started.beta, 4, 'does not exhaust the cap on one project first');
});

test('runChiefOnce uses machineConcurrency from config when chief_orchestrator is on', async t => {
  const { home, configDir } = await tmpHome(t);
  const env = { ...process.env, HOME: home, SWARM_CONFIG: path.join(configDir, 'config.json') };
  const counts = { a: 0, b: 0 };
  const wave = await runChiefOnce({
    env,
    projects: [
      { project: 'a', ready: 5, start: n => { counts.a += n; } },
      { project: 'b', ready: 5, start: n => { counts.b += n; } },
    ],
  });
  assert.ok(counts.a > 0 && counts.b > 0);
  assert.equal(counts.a + counts.b, 4);
  assert.equal(wave.started.reduce((sum, row) => sum + row.starts, 0), 4);
  assert.equal(chiefMachineDir({ env }), configDir);
});
