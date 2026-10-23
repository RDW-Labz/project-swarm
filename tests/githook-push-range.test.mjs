// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPrePush } from '../tools/githook-check.mjs';

const ZERO_SHA = `${'0'.repeat(40)}`;
const agentEnv = { CLAUDECODE: '1' };

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-githook-push-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const git = (root, ...args) =>
  spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=ab', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });

function assertGitOk(r, label) {
  assert.equal(r.status, 0, `${label}: ${r.stderr || r.stdout}`);
}

async function initMainWithRemote(t) {
  const bare = await tmp(t);
  assertGitOk(git(bare, 'init', '-b', 'main', '--bare'), 'bare init');

  const root = await tmp(t);
  assertGitOk(git(root, 'init', '-b', 'main'), 'work init');
  await fs.mkdir(path.join(root, 'coordination/manifests'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'init\n');
  git(root, 'add', 'README.md');
  assertGitOk(git(root, 'commit', '-m', 'init'), 'init commit');
  assertGitOk(git(root, 'remote', 'add', 'origin', bare), 'remote add');
  assertGitOk(git(root, 'push', '-u', 'origin', 'main'), 'push main');
  assertGitOk(git(root, 'fetch', 'origin'), 'fetch');
  return { root, bare, branch: 'swarm/boi' };
}

function pushRef(root, branch) {
  const localSha = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteProbe = git(root, 'rev-parse', remoteRef);
  const remoteSha = remoteProbe.status === 0 ? remoteProbe.stdout.trim() : ZERO_SHA;
  return {
    localRef: `refs/heads/${branch}`,
    localSha,
    remoteRef: `refs/heads/${branch}`,
    remoteSha,
  };
}

function runPrePush(root, ref) {
  return checkPrePush({
    root,
    env: agentEnv,
    refs: [ref],
    approvals: [],
  });
}

async function seedLongLivedBranch(root, branch) {
  assertGitOk(git(root, 'checkout', '-b', branch), 'checkout branch');
  for (let i = 0; i < 10; i += 1) {
    const rel = `src/legacy-${i}.ts`;
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), `legacy ${i}\n`);
    git(root, 'add', rel);
    assertGitOk(git(root, 'commit', '-m', `legacy ${i}`), `legacy commit ${i}`);
  }
  assertGitOk(git(root, 'push', '-u', 'origin', branch), 'push legacy branch');
  assertGitOk(git(root, 'fetch', 'origin'), 'fetch after legacy push');
}

test('push range: already-pushed legacy non-routing files are not re-checked', async t => {
  const { root, branch } = await initMainWithRemote(t);
  await seedLongLivedBranch(root, branch);

  await fs.writeFile(path.join(root, 'coordination/manifests/push-range.json'), '{}\n');
  git(root, 'add', 'coordination/manifests/push-range.json');
  assertGitOk(git(root, 'commit', '-m', 'routing update'), 'routing commit');

  const ref = pushRef(root, branch);
  const result = runPrePush(root, ref);
  assert.equal(result.ok, true, result.message ?? '');
});

test('push range: new non-routing commit is refused and only that file is named', async t => {
  const { root, branch } = await initMainWithRemote(t);
  await seedLongLivedBranch(root, branch);

  const badRel = 'src/fresh-handbuild.ts';
  await fs.writeFile(path.join(root, badRel), 'hand\n');
  git(root, 'add', badRel);
  assertGitOk(git(root, 'commit', '-m', 'bad hand build'), 'bad commit');

  const ref = pushRef(root, branch);
  const result = runPrePush(root, ref);
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(badRel.replace(/\./g, '\\.')));
  for (let i = 0; i < 10; i += 1) {
    assert.doesNotMatch(result.message, new RegExp(`legacy-${i}`));
  }
});

test('push range: first push of a new branch checks only its own commits', async t => {
  const { root } = await initMainWithRemote(t);

  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/on-main-stale.ts'), 'stale on main\n');
  git(root, 'add', 'src/on-main-stale.ts');
  assertGitOk(git(root, 'commit', '-m', 'main-only hand file'), 'main stale commit');
  assertGitOk(git(root, 'push', 'origin', 'main'), 'push main stale');

  const branch = 'feature/new-remote';
  assertGitOk(git(root, 'checkout', '-b', branch), 'new branch');
  await fs.writeFile(path.join(root, 'coordination/handoff.md'), '# ok\n');
  git(root, 'add', 'coordination/handoff.md');
  assertGitOk(git(root, 'commit', '-m', 'routing only on branch'), 'branch routing commit');

  const localSha = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const ref = {
    localRef: `refs/heads/${branch}`,
    localSha,
    remoteRef: `refs/heads/${branch}`,
    remoteSha: ZERO_SHA,
  };
  const result = runPrePush(root, ref);
  assert.equal(result.ok, true, result.message ?? '');
});
