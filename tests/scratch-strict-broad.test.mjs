// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { isScratchRoot, isTestTempRoot, resolveScratchBase } from '../tools/scratch-roots.mjs';
import { listProjects, projectsFile, projectId } from '../tools/projects.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { readState } from '../tools/handbuild.mjs';

const REQ = ['request', '--kind', 'tiny', '--reason', 'the swarm cannot make this one-line fix', '--files', 'src/a.ts', '--minutes', '15'];

async function mkEnv(t) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'strict-broad-'));
  const home = path.join(base, 'home');
  const scratchBase = path.join(base, 'scratch-base');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(scratchBase, { recursive: true });
  const env = { HOME: home, SWARM_PROJECTS_FILE: path.join(home, '.project-swarm', 'projects.json'), SWARM_TEST_TMP: process.env.SWARM_TEST_TMP };
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home, scratchBase, env, opts: { env, home } };
}

test('(2) strict vs broad classifiers', async t => {
  const { scratchBase, home, env, opts } = await mkEnv(t);
  const broadOnly = path.join(home, 'part', 'temp', 'real-app');
  const underScratch = path.join(scratchBase, 'wt', 'job');
  await fs.mkdir(broadOnly, { recursive: true });
  await fs.mkdir(underScratch, { recursive: true });
  assert.equal(isScratchRoot(broadOnly, { env, home, strict: true }), false);
  assert.equal(isTestTempRoot(broadOnly, { env, home }), true);
  assert.equal(isScratchRoot(underScratch, { ...opts, env: { ...env, SWARM_SCRATCH_BASE: scratchBase }, strict: true }), true);
  assert.equal(isTestTempRoot(underScratch, { ...opts, env: { ...env, SWARM_SCRATCH_BASE: scratchBase } }), true);
});

test('(6) SWARM_SCRATCH_BASE validation', async t => {
  const { home, scratchBase } = await mkEnv(t);
  const warnings = [];
  const realProject = path.join(home, 'apps', 'prod');
  await fs.mkdir(realProject, { recursive: true });
  assert.equal(resolveScratchBase({ env: { SWARM_SCRATCH_BASE: '' }, home, warn: m => warnings.push(m) }), path.join(home, '.project-swarm-scratch'));
  assert.equal(resolveScratchBase({ env: { SWARM_SCRATCH_BASE: home }, home, warn: m => warnings.push(m) }), path.join(home, '.project-swarm-scratch'));
  assert.equal(resolveScratchBase({ env: { SWARM_SCRATCH_BASE: realProject }, home, registeredRoots: [realProject], warn: m => warnings.push(m) }), path.join(home, '.project-swarm-scratch'));
  assert.equal(
    fssync.realpathSync.native(resolveScratchBase({ env: { SWARM_SCRATCH_BASE: scratchBase }, home, warn: m => warnings.push(m) })),
    fssync.realpathSync.native(scratchBase),
  );
  assert.ok(warnings.length >= 2);
});

test('(2)(11) board listing hides broad; owner inbox keeps test-segment real projects', async t => {
  const { home, env } = await mkEnv(t);
  const broadOnly = path.join(home, 'temp', 'real-app');
  const normal = path.join(home, 'apps', 'ok');
  await fs.mkdir(broadOnly, { recursive: true });
  await fs.mkdir(normal, { recursive: true });
  const at = new Date().toISOString();
  const rows = [broadOnly, normal].map((root, i) => {
    const real = fssync.realpathSync.native(root);
    return { id: projectId(real), root: real, name: `p${i}`, addedAt: at, lastSeen: at };
  });
  await fs.mkdir(path.dirname(env.SWARM_PROJECTS_FILE), { recursive: true });
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: rows }));
  const board = await listProjects({ file: projectsFile(env), forOwner: false });
  assert.deepEqual(board.map(p => p.id), [rows[1].id]);
  const owner = await listProjects({ file: projectsFile(env), forOwner: true, pruneGone: false });
  assert.equal(owner.some(p => p.id === rows[0].id), true);
});

test('(11) auto-deny message names id and escape hatch', async t => {
  const { scratchBase, env } = await mkEnv(t);
  const root = path.join(scratchBase, 'deny-msg');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x\n');
  const at = new Date().toISOString();
  await fs.mkdir(path.dirname(env.SWARM_PROJECTS_FILE), { recursive: true });
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({
    version: 1,
    projects: [{ id: projectId(root), root, name: 'deny-msg', addedAt: at, lastSeen: at }],
  }));
  const prior = process.env.SWARM_PROJECTS_FILE;
  process.env.SWARM_PROJECTS_FILE = env.SWARM_PROJECTS_FILE;
  process.env.SWARM_SCRATCH_BASE = scratchBase;
  t.after(() => { process.env.SWARM_PROJECTS_FILE = prior; });
  const res = await runHandbuildCommand(root, REQ, { now: () => Date.now() });
  assert.match(res.stdout, /auto-denied: hb-/);
  assert.match(res.stdout, /scratch project/);
  assert.match(res.stdout, /Move the project out of the scratch base/);
  const hb = Object.values(readState(root).requests)[0];
  assert.equal(hb.status, 'denied');
});
