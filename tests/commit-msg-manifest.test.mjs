// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installGitHooks, removeGitHooks, HOOK_MARKER } from '../tools/git-hooks.mjs';
import { checkCommitMsg, isManifestCommitSubject, pathsFromCachedNameStatus } from '../tools/githook-check.mjs';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const CHECK = path.join(PACKAGE, 'tools/githook-check.mjs');

const GIT_BASE = [
  '-c', 'user.email=a@b.c',
  '-c', 'user.name=ab',
  '-c', 'commit.gpgsign=false',
];

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cmm-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

function scrubAgentSessionEnv(env) {
  const out = { ...env };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  delete out.SWARM_AGENT_SESSION;
  return out;
}

const gitEnv = extra => ({ ...scrubAgentSessionEnv(process.env), ...extra });

function git(root, ...args) {
  return spawnSync('git', [...GIT_BASE, ...args], { cwd: root, encoding: 'utf8', env: gitEnv() });
}

function gitCommit(root, message, extraEnv = {}) {
  return spawnSync('git', [...GIT_BASE, 'commit', '-m', message], { cwd: root, encoding: 'utf8', env: gitEnv(extraEnv) });
}

function hookPath(root, name) {
  const rel = git(root, 'rev-parse', '--git-path', `hooks/${name}`).stdout.trim();
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

async function repo(t) {
  const root = await tmp(t);
  git(root, 'init', '-b', 'main');
  await fs.mkdir(path.join(root, 'coordination/manifests'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'init\n');
  git(root, 'add', 'README.md');
  gitCommit(root, 'init');
  installGitHooks(root, { checkScript: CHECK });
  return root;
}

test('subject and name-status helpers', () => {
  assert.ok(isManifestCommitSubject('Manifest: forget usage text'));
  assert.ok(isManifestCommitSubject('Manifest for the 1.162.0 bump'));
  assert.ok(isManifestCommitSubject('manifest x'));
  assert.ok(!isManifestCommitSubject('Add manifest tooling'));
  const paths = pathsFromCachedNameStatus('M\tcoordination/manifests/a.json\nR100\ttools/x.mjs\tcoordination/manifests/b.json');
  assert.deepEqual(paths, ['coordination/manifests/a.json', 'tools/x.mjs', 'coordination/manifests/b.json']);
});

test('manifest commits allow only coordination/manifests paths', async t => {
  const root = await repo(t);
  await fs.writeFile(path.join(root, 'coordination/manifests/one.json'), '{}\n');
  git(root, 'add', 'coordination/manifests/one.json');
  assert.equal(gitCommit(root, 'Manifest: one').status, 0);

  await fs.writeFile(path.join(root, 'tools/extra.mjs'), 'export {}\n');
  await fs.writeFile(path.join(root, 'coordination/manifests/two.json'), '{}\n');
  git(root, 'add', 'tools/extra.mjs', 'coordination/manifests/two.json');
  const bad = gitCommit(root, 'Manifest: two');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /tools\/extra\.mjs/);
  assert.match(bad.stderr, /manifest commit refused/);
  assert.match(bad.stderr, /git restore --staged/);

  git(root, 'restore', '--staged', 'tools/extra.mjs');
  assert.equal(gitCommit(root, 'Manifest: two').status, 0);

  await fs.writeFile(path.join(root, 'coordination/manifests/bump.json'), '{}\n');
  git(root, 'add', 'coordination/manifests/bump.json');
  assert.equal(gitCommit(root, 'Manifest for the 1.162.0 bump').status, 0);
  await fs.writeFile(path.join(root, 'coordination/manifests/three.json'), '{}\n');
  git(root, 'add', 'coordination/manifests/three.json');
  assert.equal(gitCommit(root, 'manifest lowercase').status, 0);

  await fs.rm(path.join(root, 'coordination/manifests/one.json'));
  git(root, 'add', 'coordination/manifests/one.json');
  assert.equal(gitCommit(root, 'Manifest: delete ok').status, 0);

  git(root, 'mv', 'coordination/manifests/three.json', 'coordination/manifests/renamed.json');
  assert.equal(gitCommit(root, 'Manifest: rename inside').status, 0);

  await fs.writeFile(path.join(root, 'tools/move-in.mjs'), 'x\n');
  git(root, 'add', 'tools/move-in.mjs');
  assert.equal(gitCommit(root, 'track tool file').status, 0);
  git(root, 'mv', 'tools/move-in.mjs', 'coordination/manifests/from-tools.json');
  const renameBad = gitCommit(root, 'Manifest: rename from tools');
  assert.notEqual(renameBad.status, 0);
  assert.match(renameBad.stderr, /tools\/move-in\.mjs/);

  await fs.writeFile(path.join(root, 'tools/mixed.mjs'), 'z\n');
  await fs.writeFile(path.join(root, 'coordination/manifests/mix.json'), '{}\n');
  git(root, 'add', 'tools/mixed.mjs', 'coordination/manifests/mix.json');
  assert.equal(gitCommit(root, 'Feature: mixed paths ok').status, 0);
});

test('failed git add leaves stray staged files; manifest commit refused then fixed', async t => {
  const root = await repo(t);
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools/projects.mjs'), 'p\n');
  await fs.writeFile(path.join(root, 'tools/swarm.mjs'), 's\n');
  await fs.writeFile(path.join(root, 'coordination/manifests/usage.json'), '{}\n');

  const addMixed = git(root, 'add', 'tools/projects.mjs', 'tools/swarm.mjs', '.swarm', 'coordination/manifests/usage.json');
  assert.notEqual(addMixed.status, 0);
  assert.match(addMixed.stderr || addMixed.stdout, /ignored/i);

  git(root, 'add', 'coordination/manifests');
  const swept = gitCommit(root, 'Manifest: forget usage text');
  assert.notEqual(swept.status, 0);
  assert.match(swept.stderr, /tools\/projects\.mjs/);
  assert.match(swept.stderr, /tools\/swarm\.mjs/);

  git(root, 'restore', '--staged', 'tools/projects.mjs', 'tools/swarm.mjs');
  assert.equal(gitCommit(root, 'Manifest: forget usage text').status, 0);
});

test('amend keeps manifest rule', async t => {
  const root = await repo(t);
  await fs.writeFile(path.join(root, 'coordination/manifests/a.json'), '{}\n');
  await fs.writeFile(path.join(root, 'tools/stray.mjs'), 's\n');
  git(root, 'add', 'coordination/manifests/a.json', 'tools/stray.mjs');
  const amendBad = spawnSync('git', [...GIT_BASE, 'commit', '--amend', '-m', 'Manifest: amend'], {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv(),
  });
  assert.notEqual(amendBad.status, 0);
  assert.match(amendBad.stderr, /tools\/stray\.mjs/);
  git(root, 'restore', '--staged', 'tools/stray.mjs');
  assert.equal(
    spawnSync('git', [...GIT_BASE, 'commit', '--amend', '-m', 'Manifest: amend'], { cwd: root, encoding: 'utf8', env: gitEnv() }).status,
    0,
  );
});

test('install idempotent, chains user commit-msg, uninstall removes hook', async t => {
  const root = await repo(t);
  const commitMsg = hookPath(root, 'commit-msg');
  const markerLog = path.join(root, 'legacy-commit-msg.ran');
  const legacyBody = `#!/bin/sh\necho ran > ${JSON.stringify(markerLog)}\n`;
  await fs.writeFile(commitMsg, legacyBody, { mode: 0o755 });

  installGitHooks(root, { checkScript: CHECK });
  installGitHooks(root, { checkScript: CHECK });
  const script = await fs.readFile(commitMsg, 'utf8');
  assert.ok(script.includes(HOOK_MARKER));
  assert.equal(script.match(new RegExp(HOOK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1);
  assert.ok(fsSync.existsSync(`${commitMsg}.before-swarm`));

  await fs.writeFile(path.join(root, 'coordination/manifests/chain.json'), '{}\n');
  git(root, 'add', 'coordination/manifests/chain.json');
  assert.equal(gitCommit(root, 'Manifest: chain').status, 0);
  assert.ok(fsSync.existsSync(markerLog), 'legacy commit-msg ran');

  await fs.writeFile(`${commitMsg}.before-swarm`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const failLegacy = gitCommit(root, 'Manifest: legacy fail');
  assert.notEqual(failLegacy.status, 0);

  await fs.writeFile(`${commitMsg}.before-swarm`, legacyBody, { mode: 0o755 });
  removeGitHooks(root);
  const restored = await fs.readFile(commitMsg, 'utf8');
  assert.match(restored, /echo ran/);
  assert.ok(!fsSync.existsSync(`${commitMsg}.before-swarm`));
});

test('checkCommitMsg unit paths', () => {
  assert.equal(checkCommitMsg({ subject: 'other', stagedPaths: ['tools/a.mjs'] }).ok, true);
  const r = checkCommitMsg({ subject: 'Manifest: x', stagedPaths: ['coordination/manifests/a.json', 'tools/b.mjs'] });
  assert.equal(r.ok, false);
  assert.match(r.message, /tools\/b\.mjs/);
});
