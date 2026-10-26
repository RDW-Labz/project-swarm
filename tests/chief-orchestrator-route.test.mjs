// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOrchestratorCommand } from '../tools/orchestrator-commands.mjs';
import { registerLiveRun, unregisterLiveRun } from '../tools/board.mjs';
import { projectId } from '../tools/projects.mjs';

const MACHINE_CAP = 8;

async function tempHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orch-route-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configDir = path.join(home, '.config', 'project-swarm');
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  await fs.writeFile(configPath, `${JSON.stringify({ machineConcurrency: MACHINE_CAP }, null, 2)}\n`);
  const liveDir = path.join(home, 'live');
  await fs.mkdir(liveDir, { recursive: true });
  const projectsFile = path.join(home, 'projects.json');
  return { home, configPath, liveDir, projectsFile };
}

function registryRow(root, name) {
  const at = new Date().toISOString();
  return { id: projectId(root), root, name, addedAt: at, lastSeen: at };
}

async function writeRunState(root, runId, state) {
  const dir = path.join(root, '.swarm', 'runs', runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
}

async function testEnv(t, { projects = [] } = {}) {
  const { home, configPath, liveDir, projectsFile } = await tempHome(t);
  await fs.writeFile(projectsFile, JSON.stringify({ version: 1, projects }, null, 2));
  return {
    ...process.env,
    HOME: home,
    SWARM_CONFIG: configPath,
    SWARM_PROJECTS_FILE: projectsFile,
    SWARM_LIVE_DIR: liveDir,
  };
}

test('orchestrator status lists registered projects with running slot counts and shares', async t => {
  const busyRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orch-busy-')));
  const idleRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orch-idle-')));
  t.after(() => fs.rm(busyRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(idleRoot, { recursive: true, force: true }));

  const env = await testEnv(t, {
    projects: [
      registryRow(busyRoot, 'busy-app'),
      registryRow(idleRoot, 'idle-app'),
    ],
  });

  const runId = 'run-busy';
  await writeRunState(busyRoot, runId, {
    status: 'running',
    jobs: [
      { id: 'j1', status: 'running', outputs: ['a.txt'] },
      { id: 'j2', status: 'running', outputs: ['b.txt'] },
      { id: 'j3', status: 'complete', outputs: ['c.txt'] },
    ],
  });
  await registerLiveRun({
    runId,
    root: busyRoot,
    outputs: ['a.txt', 'b.txt'],
    pid: process.pid,
    dir: env.SWARM_LIVE_DIR,
  });
  t.after(() => unregisterLiveRun(runId, { dir: env.SWARM_LIVE_DIR }));

  const res = await runOrchestratorCommand(busyRoot, ['status'], { env });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /chief: 2 active project\(s\), cap 8 slots/);
  assert.match(res.stdout, new RegExp(`busy-app\\s+\\(${busyRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s+2/8\\s+25\\.0%`));
  assert.match(res.stdout, new RegExp(`idle-app\\s+\\(${idleRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s+0/8\\s+0\\.0%`));
});

test('orchestrator unknown subcommand prints usage and exits 1', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orch-usage-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = await testEnv(t, { projects: [registryRow(root, 'solo')] });
  const res = await runOrchestratorCommand(root, ['nope'], { env });
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /Usage: swarm orchestrator status/);
});

test('registered project with no live runs appears with zero slots', async t => {
  const aloneRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orch-zero-')));
  t.after(() => fs.rm(aloneRoot, { recursive: true, force: true }));
  const env = await testEnv(t, { projects: [registryRow(aloneRoot, 'lonely')] });
  const res = await runOrchestratorCommand(aloneRoot, ['status'], { env });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /chief: 1 active project\(s\), cap 8 slots/);
  assert.match(res.stdout, new RegExp(`lonely\\s+\\(${aloneRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s+0/8\\s+0\\.0%`));
});
