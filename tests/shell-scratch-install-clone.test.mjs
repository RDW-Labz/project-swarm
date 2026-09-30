// SPDX-License-Identifier: Apache-2.0
// Lesson #263r moved a shell job's scratch dir (TMPDIR/HOME) under the swarm install root
// (`~/.project-swarm/tmp/<run>/<job>`), keeping the upward `.git` scan as a defensive check. The
// documented install is itself a `git clone` into `~/.project-swarm`, so on a standard install
// that scan always finds the install's own `.git` and every claude shell job was refused with
// `scratch-inside-repo`. The goal of #145/#263r is unchanged: the scratch dir must sit outside
// every git repo. When the install root is a checkout, the scratch dir falls back to a fresh
// 0700 dir under the (realpath'd, already repo-scanned) OS tmp dir, and nothing is left behind in
// the install clone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createShellScratchDir } from '../tools/claude-shell.mjs';
import { git } from '../tools/codex-adapter.mjs';

async function cloneLikeInstallRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-install-clone-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  return root;
}

async function assertNoRepoAncestor(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    await assert.rejects(fs.access(path.join(current, '.git')), `no .git at ${current}`);
    if (current === path.parse(current).root) break;
  }
}

test('an install root that is a git clone still gets a scratch dir, outside every repo, under the OS tmp dir', async t => {
  const installRoot = await cloneLikeInstallRoot(t);
  const scratch = await createShellScratchDir({ runId: 'r1', jobId: 'j1' }, { env: { SWARM_INSTALL_ROOT: installRoot } });
  t.after(() => fs.rm(scratch.scratchDir, { recursive: true, force: true }));
  assert.equal(scratch.scratchDir.startsWith(`${installRoot}${path.sep}`), false, scratch.scratchDir);
  assert.equal(scratch.scratchDir.startsWith(`${await fs.realpath(os.tmpdir())}${path.sep}`), true, scratch.scratchDir);
  assert.equal((await fs.stat(scratch.scratchDir)).mode & 0o777, 0o700);
  assert.ok((await fs.stat(scratch.tmp)).isDirectory());
  assert.ok((await fs.stat(scratch.home)).isDirectory());
  await assertNoRepoAncestor(scratch.scratchDir);
  // Nothing is created inside the install clone (1.37.0 left an empty tmp/<run>/<job> behind).
  await assert.rejects(fs.access(path.join(installRoot, 'tmp')));
});

test('an install root that is not a checkout keeps the #263r layout: <install>/tmp/<run>/<job>', async t => {
  const installRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-install-plain-')));
  t.after(() => fs.rm(installRoot, { recursive: true, force: true }));
  const scratch = await createShellScratchDir({ runId: 'r2', jobId: 'j2' }, { env: { SWARM_INSTALL_ROOT: installRoot } });
  assert.equal(scratch.scratchDir, path.join(installRoot, 'tmp', 'r2', 'j2'));
});
