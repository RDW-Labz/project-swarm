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

test('redirects refuse earlier cwd changes in compound commands', async t => {
  const ctx = await project(t);
  for (const command of [
    'cd docs && echo x > plans/a.md',
    'cd docs && echo x > docs/plans/a.md',
    'pushd docs && echo x > plans/a.md',
  ]) {
    assert.equal(orchestratorModeCommandAllowed(command, ctx), false, command);
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
