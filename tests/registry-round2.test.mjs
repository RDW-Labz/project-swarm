// SPDX-License-Identifier: Apache-2.0
// Round-2 registry/scratch/hook review fixes (see tools/projects.mjs, tools/scratch-roots.mjs, tools/board-inbox.mjs).
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { listProjects, forgetProjects, projectId, projectsFile } from '../tools/projects.mjs';
import { isScratchRoot, isTestTempRoot, resolveScratchBase } from '../tools/scratch-roots.mjs';
import { boardInbox } from '../tools/board-inbox.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { readState } from '../tools/handbuild.mjs';

const REQ = ['request', '--kind', 'tiny', '--reason', 'the swarm cannot make this one-line fix', '--files', 'src/a.ts', '--minutes', '15'];

async function mkEnv(t) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'registry-r2-'));
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, '.project-swarm', 'projects.json');
  const env = { HOME: home, SWARM_PROJECTS_FILE: file, SWARM_TEST_TMP: process.env.SWARM_TEST_TMP };
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home, file, env };
}

function entry(root, name) {
  const at = new Date().toISOString();
  return { id: projectId(root), root, name, addedAt: at, lastSeen: at };
}

test('(1) empty mount parent keeps registry row as unreachable', async t => {
  const { base, file, env } = await mkEnv(t);
  const mount = path.join(base, 'mnt', 'share');
  const proj = path.join(mount, 'proj');
  await fs.mkdir(mount, { recursive: true });
  const row = entry(proj, 'off-volume');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [row] }));
  const unreachable = [];
  await listProjects({ file, forOwner: true, pruneGone: true, unreachable });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.projects.length, 1);
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0].id, row.id);
});

test('(2) forget --scratch does not use broad test-segment rule', async t => {
  const { home, file, env } = await mkEnv(t);
  const broadOnly = path.join(home, 'work', 'tests', 'app');
  await fs.mkdir(broadOnly, { recursive: true });
  const at = new Date().toISOString();
  const real = fssync.realpathSync.native(broadOnly);
  const row = { id: projectId(real), root: real, name: 'app', addedAt: at, lastSeen: at };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [row] }));
  assert.equal(isTestTempRoot(real, { env, home }), true);
  assert.equal(isScratchRoot(real, { env, home, strict: true }), false);
  const res = await forgetProjects({ scratch: true, yes: true, file, env, home });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /nothing to forget/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).projects.length, 1);
});

test('(3) SWARM_SCRATCH_BASE warns once and rejects real project trees', async t => {
  const { home, base } = await mkEnv(t);
  const codeBase = path.join(home, 'code');
  const realProject = path.join(codeBase, 'prod');
  await fs.mkdir(realProject, { recursive: true });
  await fs.mkdir(path.join(realProject, '.git'), { recursive: true });
  const warnings = [];
  const warn = m => warnings.push(m);
  const first = resolveScratchBase({ env: { SWARM_SCRATCH_BASE: codeBase }, home, registeredRoots: [realProject], warn });
  const second = resolveScratchBase({ env: { SWARM_SCRATCH_BASE: codeBase }, home, registeredRoots: [realProject], warn });
  assert.equal(first, path.join(home, '.project-swarm-scratch'));
  assert.equal(second, path.join(home, '.project-swarm-scratch'));
  assert.equal(warnings.length, 1);
});

test('(7) broad board hide exempts test segment under install root prefix', async t => {
  const { base, home, env } = await mkEnv(t);
  const installRoot = path.join(base, 'swarm-install');
  const underInstall = path.join(installRoot, 'tests', 'app');
  await fs.mkdir(underInstall, { recursive: true });
  assert.equal(isTestTempRoot(underInstall, { env, home, installRoot }), false);
});

test('(13) handbuild auto-deny for unregistered scratch path', async t => {
  const { base, home, env } = await mkEnv(t);
  const scratchBase = path.join(base, 'scratch-base');
  const root = path.join(scratchBase, 'never-registered');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x\n');
  const prior = process.env.SWARM_SCRATCH_BASE;
  process.env.SWARM_SCRATCH_BASE = scratchBase;
  t.after(() => { if (prior === undefined) delete process.env.SWARM_SCRATCH_BASE; else process.env.SWARM_SCRATCH_BASE = prior; });
  const res = await runHandbuildCommand(root, REQ, { now: () => Date.now() });
  assert.match(res.stdout, /auto-denied/);
  assert.equal(Object.values(readState(root).requests)[0].status, 'denied');
});

test('(6) phone counts skip scratch issues', async t => {
  const { home, env } = await mkEnv(t);
  const scratchRoot = path.join(home, '.project-swarm-scratch', 'wt');
  const realRoot = path.join(home, 'real');
  await fs.mkdir(scratchRoot, { recursive: true });
  await fs.mkdir(realRoot, { recursive: true });
  const scratchProject = { id: projectId(scratchRoot), root: scratchRoot, name: 'scratch' };
  const realProject = { id: projectId(realRoot), root: realRoot, name: 'real' };
  const phoneDir = path.join(home, '.project-swarm', 'phone');
  await fs.mkdir(phoneDir, { recursive: true });
  await fs.writeFile(path.join(phoneDir, 'config.json'), JSON.stringify({ repo: 'o/r', owners: ['me'], enabled: true }));
  await fs.writeFile(path.join(phoneDir, 'state.json'), JSON.stringify({
    repo: 'o/r',
    issues: {
      1: { key: `${scratchRoot}|decision|d1`, root: scratchRoot, status: 'open', number: 1 },
      2: { key: `${realRoot}|decision|d2`, root: realRoot, status: 'open', number: 2 },
      3: { key: `${realRoot}|decision|d3`, root: realRoot, status: 'confirming', number: 3 },
    },
  }));
  const inbox = await boardInbox({
    projects: [scratchProject, realProject],
    env: { ...env, HOME: home },
    home,
    ownerInbox: true,
    phoneDirectory: phoneDir,
    collect: async () => [],
    ledgerOf: async () => null,
    deps: inboxDeps({ channel: 'board' }),
  });
  assert.equal(inbox.phone.open, 1);
  assert.equal(inbox.phone.confirming, 1);
});

test('(15) forget refuses install-like path when install dir unknown', async t => {
  const { base, file, env, home } = await mkEnv(t);
  const installLike = path.join(base, 'fake-install');
  await fs.mkdir(path.join(installLike, 'tools'), { recursive: true });
  await fs.writeFile(path.join(installLike, 'tools', 'swarm.mjs'), '// stub\n');
  const row = entry(installLike, 'install');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [row] }));
  const res = await forgetProjects({ paths: [installLike], file, env, home });
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /install root/);
});
