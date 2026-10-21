// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, forgetProjects, projectId, projectsFile } from '../tools/projects.mjs';

const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function mkEnv(t) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'registry-review-'));
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, '.project-swarm', 'projects.json');
  const e = { HOME: home, SWARM_PROJECTS_FILE: file };
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home, file, env: e };
}

function entry(root, name) {
  const at = new Date().toISOString();
  return { id: projectId(root), root, name, addedAt: at, lastSeen: at };
}

test('(1) stat errors other than ENOENT keep registry rows as unreachable', async t => {
  const { base, file, env } = await mkEnv(t);
  const missing = path.join(base, 'gone-dir');
  const row = entry(missing, 'gone');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [row] }));
  const unreachable = [];
  const left = await listProjects({ file, forOwner: true, pruneGone: true, unreachable });
  assert.equal(left.length, 0);
  assert.equal(unreachable.length, 0);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.projects.length, 0);
});

test('(8) damaged registry is not overwritten on prune', async t => {
  const { file, env, home } = await mkEnv(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{not json');
  const res = await forgetProjects({ missing: true, yes: true, file, env, home });
  assert.equal((await fs.readFile(file, 'utf8')).trim(), '{not json');
  assert.match(res.stdout, /damaged/);
});

test('(9) forget install root without installRoot arg refuses single target', async t => {
  const { base, file, env, home } = await mkEnv(t);
  const root = installRoot;
  const row = entry(root, 'install');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [row, entry(path.join(base, 'other'), 'o')] }));
  const res = await forgetProjects({ paths: [root], file, env: { ...env, SWARM_INSTALL_DIR: installRoot }, home });
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /install root/);
});

test('(9) bulk forget skips install root and continues', async t => {
  const { base, file, env, home } = await mkEnv(t);
  const other = path.join(base, 'drop-me');
  await fs.mkdir(other, { recursive: true });
  const rows = [entry(installRoot, 'install'), entry(other, 'other')];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: rows }));
  const res = await forgetProjects({ paths: [installRoot, other], file, env: { ...env, SWARM_INSTALL_DIR: installRoot }, home });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /skipped install root/);
  assert.match(res.stdout, /forgot:/);
  const left = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.equal(left.length, 1);
  assert.equal(left[0].id, rows[0].id);
});

test('(9) dry-run on damaged registry reports damage', async t => {
  const { file, env, home } = await mkEnv(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '<<<');
  const res = await forgetProjects({ paths: ['anything'], dryRun: true, file, env, home });
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /damaged/);
});

test('(7) forOwner false does not prune scratch rows from registry file', async t => {
  const { base, file, env } = await mkEnv(t);
  const scratchBase = path.join(base, 'scratch-base');
  const gone = path.join(scratchBase, 'removed');
  const row = entry(gone, 'gone');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [row] }));
  process.env.SWARM_SCRATCH_BASE = scratchBase;
  await listProjects({ file, forOwner: false, pruneGone: false });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.projects.length, 1);
});
