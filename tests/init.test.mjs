// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../tools/init.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-init-'));
  const registry = path.join(source, '.swarm-projects.json');
  const before = await fs.readFile(registry, 'utf8').catch(() => null);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    if (before === null) await fs.rm(registry, { force: true });
    else await fs.writeFile(registry, before);
  });
  await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'sample', scripts: { test: 'node --test', lint: 'eslint .' } })}\n`);
  await fs.writeFile(path.join(root, 'eslint.config.mjs'), 'export default [\n];\n');
  await fs.writeFile(path.join(root, 'pytest.ini'), '[pytest]\n');
  await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
  await fs.writeFile(path.join(root, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: npm test\n');
  return root;
}

test('init links a project, names the stack, copies checks, and ignores .swarm', async t => {
  const root = await project(t);
  const result = await initProject(root, { source });
  assert.equal(result.status, 'linked');
  assert.deepEqual(result.stack, [{ name: 'node', packageManager: 'npm' }]);
  const pointer = JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
  assert.equal(pointer.install, await fs.realpath(source));
  assert.deepEqual(pointer.stack, result.stack);
  assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /\.swarm\/\n/);
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /project-swarm/);
  assert.match(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'), /project-swarm/);
  const rule = await fs.readFile(path.join(root, '.cursor/rules/project-swarm.mdc'), 'utf8');
  assert.match(rule, /project-swarm/);
  const orchestrator = await fs.readFile(path.join(root, 'coordination/ORCHESTRATOR.md'), 'utf8');
  assert.ok(orchestrator.length > 0);
  const checks = JSON.parse(await fs.readFile(path.join(root, 'coordination/checks.json'), 'utf8'));
  assert.deepEqual(checks.checks.map(check => check.argv), [['npm', 'test'], ['npm', 'run', 'lint']]);
  assert.match(await fs.readFile(path.join(root, 'eslint.config.mjs'), 'utf8'), /\.swarm\/\*\*/);
  assert.match(await fs.readFile(path.join(root, 'pytest.ini'), 'utf8'), /norecursedirs = \.swarm/);
  const again = await initProject(root, { source });
  assert.equal(again.checks.written, false);
  assert.deepEqual(again.ignores, []);
});

test('init adds the build output ignore lines and keeps the blocks the owner set by hand across a re-init', async t => {
  const root = await project(t);
  await initProject(root, { source });
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  for (const line of ['.next/', 'node_modules/', '*.tsbuildinfo', 'next-env.d.ts']) assert.ok(ignore.includes(line), line);
  const pointerPath = path.join(root, '.project-swarm.json');
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  pointer.profile.verify = { command: ['npm', 'test'], agent: 'claude', model: 'sonnet-shell', setup: [], testEnv: {}, timeoutSec: 900 };
  pointer.profile.security = { acceptedAdvisories: [{ package: 'glob', reason: 'dev only chain', reviewBy: '2026-12-31' }] };
  pointer.profile.context = { db: ['docs/scope/scope-original.md'] };
  await fs.writeFile(pointerPath, JSON.stringify(pointer, null, 2));
  const beforeIgnore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  await initProject(root, { source });
  const again = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  assert.deepEqual(again.profile.verify.command, ['npm', 'test']);
  assert.equal(again.profile.security.acceptedAdvisories[0].package, 'glob');
  assert.deepEqual(again.profile.context.db, ['docs/scope/scope-original.md']);
  assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), beforeIgnore);
});
