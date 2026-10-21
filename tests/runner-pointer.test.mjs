// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bumpPointers } from '../tools/swarm.mjs';
import { writePointer, installProject, ensureSwarmIgnore } from '../tools/install.mjs';
import { checkSetup } from '../tools/init-profile.mjs';
import { projectStatus } from '../tools/status.mjs';
import {
  readRunnerPointer,
  migrateRunnerPointer,
  RUNNER_POINTER_LOCAL,
  bootstrapProjectPointer,
} from '../tools/runner-pointer.mjs';

const execFileAsync = promisify(execFile);
const profile = { budget: { maxUsd: 5 }, sensitive: true, protectedPaths: [], baseCheck: { status: 'none' } };

async function tmp(t, prefix = 'swarm-rptr-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return fs.realpath(d);
}

async function minimalInstall(t, version = '2.0.0') {
  const install = await tmp(t, 'swarm-rptr-install-');
  await fs.mkdir(path.join(install, 'tools'), { recursive: true });
  await fs.writeFile(path.join(install, 'tools/swarm.mjs'), '// stub\n');
  await fs.mkdir(path.join(install, 'examples'), { recursive: true });
  await fs.mkdir(path.join(install, 'templates/coordination'), { recursive: true });
  await fs.writeFile(path.join(install, 'package.json'), JSON.stringify({ name: 'project-swarm', version }));
  return install;
}

async function gitInitProject(t, branch = 'feature/swarm') {
  const root = await tmp(t);
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: root });
  await execFileAsync('git', ['checkout', '-b', branch], { cwd: root });
  return root;
}

test('bumpPointers leaves tracked .project-swarm.json bytes and git status unchanged', async t => {
  const install = await minimalInstall(t, '1.141.0');
  const project = await gitInitProject(t);
  const tracked = JSON.stringify({ install, version: '1.137.0', profile }, null, 2) + '\n';
  await fs.writeFile(path.join(project, '.project-swarm.json'), tracked);
  await fs.writeFile(path.join(project, '.gitignore'), '.swarm/\n');
  await execFileAsync('git', ['add', '.project-swarm.json', '.gitignore'], { cwd: project });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: project });
  const before = await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8');
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([project]));
  await bumpPointers(install);
  assert.equal(await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8'), before);
  const { stdout } = await execFileAsync('git', ['-C', project, 'status', '--porcelain', '--', '.project-swarm.json'], { encoding: 'utf8' });
  assert.equal(stdout.trim(), '');
  const local = JSON.parse(await fs.readFile(path.join(project, RUNNER_POINTER_LOCAL), 'utf8'));
  assert.equal(local.version, '1.141.0');
});

test('readRunnerPointer merges local over tracked and handles missing pieces', async t => {
  const root = await tmp(t);
  const install = '/tmp/install';
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ install, version: '1.0.0', profile }));
  assert.equal((await readRunnerPointer(root)).version, '1.0.0');
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  await fs.writeFile(path.join(root, RUNNER_POINTER_LOCAL), JSON.stringify({ version: '2.0.0' }));
  assert.equal((await readRunnerPointer(root)).version, '2.0.0');
  assert.equal((await readRunnerPointer(root)).install, install);
  await fs.writeFile(path.join(root, RUNNER_POINTER_LOCAL), '{');
  await assert.rejects(() => readRunnerPointer(root), /not valid JSON/);
});

test('migration copies release fields, strips clean tracked file, defers when dirty or protected', async t => {
  const install = '/opt/swarm';
  const clean = await gitInitProject(t, 'feature/x');
  await fs.writeFile(path.join(clean, '.project-swarm.json'), JSON.stringify({ install, version: '1.1.0', profile }));
  await fs.writeFile(path.join(clean, '.gitignore'), '.swarm/\n');
  await execFileAsync('git', ['add', '-A'], { cwd: clean });
  await execFileAsync('git', ['commit', '-m', 'c'], { cwd: clean });
  let r = await migrateRunnerPointer(clean);
  assert.equal(r.status, 'migrated');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(clean, RUNNER_POINTER_LOCAL), 'utf8')), { version: '1.1.0', install });
  assert.equal(JSON.parse(await fs.readFile(path.join(clean, '.project-swarm.json'), 'utf8')).version, undefined);
  r = await migrateRunnerPointer(clean);
  assert.equal(r.status, 'noop');

  const dirty = await gitInitProject(t, 'feature/y');
  await fs.writeFile(path.join(dirty, '.project-swarm.json'), JSON.stringify({ install, version: '1.2.0', profile }));
  await execFileAsync('git', ['add', '.project-swarm.json'], { cwd: dirty });
  await execFileAsync('git', ['commit', '-m', 'd'], { cwd: dirty });
  await fs.appendFile(path.join(dirty, '.project-swarm.json'), ' ');
  r = await migrateRunnerPointer(dirty);
  assert.equal(r.status, 'deferred');
  assert.equal(r.reason, 'dirty-tracked');
  assert.equal(JSON.parse(await fs.readFile(path.join(dirty, '.project-swarm.json'), 'utf8')).version, '1.2.0');

  const main = await gitInitProject(t, 'main');
  await fs.writeFile(path.join(main, '.project-swarm.json'), JSON.stringify({ install, version: '1.3.0', profile }));
  await execFileAsync('git', ['add', '.project-swarm.json'], { cwd: main });
  await execFileAsync('git', ['commit', '-m', 'm'], { cwd: main });
  r = await migrateRunnerPointer(main);
  assert.equal(r.status, 'deferred');
  assert.equal(r.reason, 'protected-branch');
});

test('init link writes .swarm/ ignore and splits version into local pointer', async t => {
  const install = await minimalInstall(t, '3.0.0');
  const project = await tmp(t);
  await fs.mkdir(path.join(install, 'templates/agent-pointers'), { recursive: true });
  await fs.mkdir(path.join(install, 'templates/coordination/skills'), { recursive: true });
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'cursor-rule.mdc']) {
    await fs.writeFile(path.join(install, 'templates/agent-pointers', f), '<!-- project-swarm:start -->\n{{SWARM_INSTALL}}\n<!-- project-swarm:end -->\n');
  }
  for (const f of ['ORCHESTRATOR.md', 'HANDOFF.md', 'TASK.md', 'swarm-lessons.md', 'CONTRACT.md']) {
    await fs.writeFile(path.join(install, 'templates/coordination', f), `# ${f}\n`);
  }
  await installProject(project, { source: install, agentFiles: false });
  const lines = (await fs.readFile(path.join(project, '.gitignore'), 'utf8')).split('\n').map(l => l.trim());
  assert.ok(lines.includes('.swarm/'));
  const tracked = JSON.parse(await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8'));
  assert.ok(tracked.install);
  const local = JSON.parse(await fs.readFile(path.join(project, RUNNER_POINTER_LOCAL), 'utf8'));
  assert.equal(local.version, '3.0.0');
  assert.equal((await readRunnerPointer(project)).version, '3.0.0');
  await installProject(project, { source: install, agentFiles: false });
  assert.ok(lines.includes('.swarm/'));
});

test('un-migrated project readers still resolve the linked version', async t => {
  const install = await minimalInstall(t, '9.9.0');
  const root = await tmp(t);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ install, version: '1.5.0', profile }));
  const merged = await readRunnerPointer(root);
  const setup = await checkSetup(root, { installVersion: '1.5.0', exists: async () => true, readJson: async () => merged, head: async () => 'abc' });
  assert.ok(setup.items.some(i => i.id === 'version' && i.level === 'ok'));
  const status = await projectStatus(root, { doctorAll: async () => ({ providers: [] }), spendToday: async () => ({ usd: 0, byLane: {} }) });
  assert.equal(status.initialized, true);
});

test('ensureSwarmIgnore is idempotent', async t => {
  const root = await tmp(t);
  assert.equal(await ensureSwarmIgnore(root), true);
  assert.equal(await ensureSwarmIgnore(root), false);
});

test('writePointer and bootstrap never modify tracked bytes on version-only bump', async t => {
  const install = await minimalInstall(t, '4.0.0');
  const project = await tmp(t);
  const bytes = JSON.stringify({ install, version: '3.0.0', profile }, null, 2) + '\n';
  await fs.writeFile(path.join(project, '.project-swarm.json'), bytes);
  await writePointer(project, { install, version: '4.0.0' });
  assert.equal(await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8'), bytes);
  await bootstrapProjectPointer(project, { install, version: '5.0.0' });
  assert.equal((await readRunnerPointer(project)).version, '5.0.0');
});
