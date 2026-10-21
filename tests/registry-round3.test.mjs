// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerProject, forgetProjects, projectId } from '../tools/projects.mjs';
import { isScratchRoot, isTestTempRoot, resolveScratchBase, scratchRootList } from '../tools/scratch-roots.mjs';
import { installGitHooks, removeGitHooks } from '../tools/git-hooks.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { readState } from '../tools/handbuild.mjs';

const REQ = ['request', '--kind', 'tiny', '--reason', 'the swarm cannot make this one-line fix', '--files', 'src/a.ts', '--minutes', '15'];

async function mkEnv(t) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'registry-r3-'));
  const home = path.join(base, 'home');
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, '.project-swarm', 'projects.json');
  const env = { HOME: home, SWARM_PROJECTS_FILE: file, SWARM_TEST_TMP: process.env.SWARM_TEST_TMP };
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, home, file, env };
}

test('(2) custom SWARM_SCRATCH_BASE keeps registered scratch worktrees inside', async t => {
  const { home, base, env } = await mkEnv(t);
  const scratchBase = path.join(base, 'my-scratch');
  const wt = path.join(scratchBase, 'worktrees', 'wt-1');
  await fs.mkdir(path.join(wt, '.git'), { recursive: true });
  const warnings = [];
  const resolved = resolveScratchBase({
    env: { ...env, SWARM_SCRATCH_BASE: scratchBase },
    home,
    registeredRoots: [wt],
    warn: m => warnings.push(m),
  });
  assert.equal(resolved, fssync.realpathSync.native(scratchBase));
  assert.equal(warnings.length, 0);
});

test('(2) custom SWARM_SCRATCH_BASE still rejects real registered child projects', async t => {
  const { home, base, env } = await mkEnv(t);
  const codeBase = path.join(home, 'code');
  const realProject = path.join(codeBase, 'prod');
  await fs.mkdir(path.join(realProject, '.git'), { recursive: true });
  const warnings = [];
  const resolved = resolveScratchBase({
    env: { ...env, SWARM_SCRATCH_BASE: codeBase },
    home,
    registeredRoots: [realProject],
    warn: m => warnings.push(m),
  });
  assert.equal(resolved, path.join(home, '.project-swarm-scratch'));
  assert.equal(warnings.length, 1);
});

test('(3) broad hide exempts path segment matching home folder name under home', async t => {
  const { home, env } = await mkEnv(t);
  const homeName = path.basename(home);
  const deep = path.join(home, homeName, 'proj');
  await fs.mkdir(deep, { recursive: true });
  assert.equal(isTestTempRoot(deep, { env, home }), false);
});

test('(4) untrusted TMPDIR is not added to strict scratch bases', async t => {
  const { home, env } = await mkEnv(t);
  const fakeTmp = path.join(home, 'not-really-tmp');
  await fs.mkdir(fakeTmp, { recursive: true });
  const prior = process.env.TMPDIR;
  process.env.TMPDIR = fakeTmp;
  t.after(() => {
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
  });
  const bases = scratchRootList({ env, home });
  const resolvedTmp = fssync.realpathSync.native(os.tmpdir());
  assert.ok(!bases.includes(resolvedTmp));
});

test('(5) stale lock steal allows registry write then releases owned lock', async t => {
  const { file, home, env } = await mkEnv(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, 'owner'), '424242\n');
  const past = Date.now() - 31_000;
  await fs.utimes(lock, past / 1000, past / 1000);
  const root = path.join(home, 'proj');
  await fs.mkdir(root, { recursive: true });
  const r = await registerProject(root, { file, env, home });
  assert.ok(r?.project);
  await fs.access(file);
  let lockGone = false;
  try {
    await fs.access(lock);
  } catch {
    lockGone = true;
  }
  assert.ok(lockGone);
});

test('(6) install hooks when .git/hooks is missing', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-mkdir-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const gitDir = path.join(dir, '.git');
  await fs.mkdir(gitDir, { recursive: true });
  const check = path.join(dir, 'check.mjs');
  await fs.writeFile(check, 'process.exit(0)\n');
  const res = installGitHooks(dir, {
    fs: fssync,
    exec: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${path.join(gitDir, 'hooks')}\n`;
      throw new Error('unexpected git');
    },
    checkScript: check,
  });
  assert.equal(res.status, 'installed');
  assert.ok(fssync.existsSync(path.join(gitDir, 'hooks', 'commit-msg')));
});

test('(9) removeGitHooks tolerates missing hooks directory', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-rm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  removeGitHooks(dir, {
    fs: fssync,
    exec: () => path.join(dir, 'nope', 'hooks'),
  });
});

test('(11) handbuild scratch deny uses reason text and non-zero exit', async t => {
  const { base, home, env } = await mkEnv(t);
  const scratchBase = path.join(base, 'scratch-base');
  const root = path.join(scratchBase, 'wt');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x\n');
  const res = await runHandbuildCommand(root, REQ, { env: { ...env, SWARM_SCRATCH_BASE: scratchBase }, now: () => Date.now() });
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /auto-denied/);
  assert.doesNotMatch(res.stdout, /remove \.swarm-scratch to allow/);
});

function entry(root, name) {
  const at = new Date().toISOString();
  return { id: projectId(root), root, name, addedAt: at, lastSeen: at };
}

test('(14) forget --missing skips install-like root when install dir unknown', async t => {
  const { base, file, env, home } = await mkEnv(t);
  const installLike = path.join(base, 'fake-install');
  const gone = path.join(base, 'gone-proj');
  await fs.mkdir(path.join(installLike, 'tools'), { recursive: true });
  await fs.writeFile(path.join(installLike, 'tools', 'swarm.mjs'), '// stub\n');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    projects: [entry(installLike, 'install'), entry(gone, 'gone')],
  }));
  const res = await forgetProjects({ missing: true, yes: true, file, env, home });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /forgot:.*gone-proj/);
  assert.doesNotMatch(res.stdout, /forgot:.*fake-install/);
  const left = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.equal(left.length, 1);
  assert.equal(left[0].root, installLike);
});
