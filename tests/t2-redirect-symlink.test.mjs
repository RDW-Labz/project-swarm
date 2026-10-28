import './_isolate-config.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { orchestratorModeCommandAllowed } from '../tools/shell-writes.mjs';

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t2-redirect-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['.git', '.swarm/runs', 'coordination/manifests', 'docs/plans']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  return { root, cwd: root };
}

test('redirects refuse dangling and existing leaf symlinks', async t => {
  const ctx = await project(t);
  await fs.symlink('../../coordination/manifests/wave.json', path.join(ctx.root, 'docs/plans/dangling.md'));
  await fs.writeFile(path.join(ctx.root, 'docs/plans/real.md'), 'existing');
  await fs.symlink('real.md', path.join(ctx.root, 'docs/plans/link.md'));
  for (const leaf of ['dangling.md', 'link.md']) {
    for (const command of [`echo x > docs/plans/${leaf}`, `printf x >> docs/plans/${leaf}`]) {
      assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
    }
  }
});

test('redirects refuse parent traversal after directory symlinks', async t => {
  const ctx = await project(t);
  await fs.symlink('../../.swarm', path.join(ctx.root, 'docs/plans/L'));
  const command = 'echo x > docs/plans/L/../y';
  assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
});

test('cd refuses options and parent traversal after directory symlinks', async t => {
  const ctx = await project(t);
  await fs.symlink('../../.swarm/runs', path.join(ctx.root, 'docs/plans/L'));
  for (const command of [
    'cd -P docs/plans/L/.. && echo x > project/y.json',
    'cd docs/plans/L/.. && echo x > project/y.json',
    'cd docs/plans/L/../../.. && echo x > docs/plans/a.md',
    ...['-P', '-L', '-e', '-@', '--', '-'].map(option => `cd ${option} docs`),
    'cd docs -L && echo x > plans/a.md',
  ]) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
  }
});

test('cd tracks the physical path through directory symlinks', async t => {
  const ctx = await project(t);
  await fs.symlink('../coordination', path.join(ctx.root, 'docs/C'));
  assert.equal(orchestratorModeCommandAllowed('cd docs/C && echo x > manifests/a.json', ctx), false);
  await fs.symlink('docs', path.join(ctx.root, 'D'));
  assert.equal(orchestratorModeCommandAllowed('cd D && echo x > plans/a.md', ctx), true);
});

test('redirects refuse existing hard-linked regular-file leaves', async t => {
  const ctx = await project(t);
  await fs.writeFile(path.join(ctx.root, 'coordination/manifests/a.json'), 'existing');
  await fs.link(path.join(ctx.root, 'coordination/manifests/a.json'), path.join(ctx.root, 'docs/plans/linked.md'));
  for (const command of [
    'echo x > docs/plans/linked.md',
    'printf x >> docs/plans/linked.md',
    'cd docs && echo x > plans/linked.md',
  ]) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
  }
  await fs.writeFile(path.join(ctx.root, 'docs/plans/plain.md'), 'existing');
  assert.equal(orchestratorModeCommandAllowed('echo x > docs/plans/plain.md', ctx), true);
});

test('redirects resolve targets against the tracked cwd in compound commands', async t => {
  const ctx = await project(t);
  for (const command of [
    'cd coordination && echo x > manifests/a.json',
    'cd docs && echo x > docs/plans/a.md',
    'pushd docs && echo x > plans/a.md',
  ]) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
  }
});

test('redirects preserve allowed plan writes after cd', async t => {
  const ctx = await project(t);
  const fromRoot = orchestratorModeCommandAllowed('echo x > docs/plans/a.md', ctx);
  assert.equal(fromRoot, true);
  assert.equal(orchestratorModeCommandAllowed('cd docs && echo x > plans/a.md', ctx), fromRoot);
});

test('cd preserves descriptor duplication and null redirect verdicts', async t => {
  const ctx = await project(t);
  for (const command of ['node -e 1 2>&1', 'true > /dev/null']) {
    assert.equal(
      orchestratorModeCommandAllowed(`cd docs && ${command}`, ctx),
      orchestratorModeCommandAllowed(command, ctx),
      command,
    );
  }
});

test('redirects still allow new plain files and real parent traversal', async t => {
  const ctx = await project(t);
  for (const command of [
    'echo x > docs/plans/new.md',
    'printf x > docs/plans/new.md',
    'echo x > docs/plans/../plans/new.md',
  ]) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), true, command);
  }
});
