// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  commitIntegratedRun,
  branchAllowedForIntegrateCommit,
  readIntegrateCommitBranches,
} from '../tools/go.mjs';

const exec = promisify(execFile);
const gitEnv = root => ({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', TMPDIR: root });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function git(root, ...args) {
  return exec('git', ['-C', root, ...args], { env: { ...process.env, ...gitEnv(root) } });
}

async function fixture(t, { branch = 'swarm/test', projectSwarm = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-commit-branches-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.writeFile(path.join(root, 'out/change.txt'), 'base\n');
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Swarm Test');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  if (branch) {
    if (branch === 'main') {
      await git(root, 'branch', '-M', 'main');
    } else {
      await git(root, 'checkout', '-q', '-b', branch);
    }
  }
  if (projectSwarm !== null) {
    await fs.writeFile(path.join(root, '.project-swarm.json'), `${JSON.stringify(projectSwarm)}\n`);
  }
  await fs.writeFile(path.join(root, 'out/change.txt'), 'integrated\n');
  return root;
}

function integrationState(root, relPath = 'out/change.txt', content = 'integrated\n') {
  const bytes = Buffer.from(content, 'utf8');
  return {
    integratedFiles: [relPath],
    integratedHashes: { [relPath]: digest(bytes) },
  };
}

async function headSha(root) {
  const { stdout } = await git(root, 'rev-parse', 'HEAD');
  return stdout.trim();
}

async function runCommit(root, { branch, projectSwarm, state, runId = 'run-test' } = {}) {
  const stateObj = state ?? integrationState(root);
  return commitIntegratedRun(root, {
    runId,
    state: stateObj,
    manifest: { version: 1, jobs: [] },
    env: gitEnv(root),
  });
}

test('branchAllowedForIntegrateCommit: exact, trailing star, and lone star', () => {
  assert.equal(branchAllowedForIntegrateCommit('build/s18-confirmation', ['build/s18-confirmation']), true);
  assert.equal(branchAllowedForIntegrateCommit('build/s18', ['build/s18-confirmation']), false);
  assert.equal(branchAllowedForIntegrateCommit('build/x', ['build/*']), true);
  assert.equal(branchAllowedForIntegrateCommit('build', ['build/*']), false);
  assert.equal(branchAllowedForIntegrateCommit('anything', ['*']), true);
});

test('commit on exact commitBranches name build/s18-confirmation', async t => {
  const root = await fixture(t, {
    branch: 'build/s18-confirmation',
    projectSwarm: { integrate: { commitBranches: ['build/s18-confirmation'] } },
  });
  const before = await headSha(root);
  const out = await runCommit(root);
  assert.equal(out.commit?.status, 'committed');
  assert.notEqual(await headSha(root), before);
});

test('commit on pattern build/* for build/x', async t => {
  const root = await fixture(t, {
    branch: 'build/x',
    projectSwarm: { integrate: { commitBranches: ['build/*'] } },
  });
  const out = await runCommit(root);
  assert.equal(out.commit?.status, 'committed');
});

test('unnamed non-swarm branch skips with configured reason and HEAD unchanged', async t => {
  const root = await fixture(t, { branch: 'feature/unlisted' });
  const before = await headSha(root);
  const out = await runCommit(root);
  assert.equal(out.commit?.status, 'skipped');
  assert.match(out.commit?.reason, /not a swarm\/\* branch or a branch named in \.project-swarm\.json integrate\.commitBranches/);
  assert.equal(await headSha(root), before);
});

test('main is never committed when listed in commitBranches or lone star', async t => {
  for (const projectSwarm of [{ integrate: { commitBranches: ['main'] } }, { integrate: { commitBranches: ['*'] } }]) {
    const root = await fixture(t, { branch: 'main', projectSwarm });
    const before = await headSha(root);
    const out = await runCommit(root);
    assert.equal(out.commit?.status, 'skipped');
    assert.match(out.commit?.reason, /the main branch; integrate never commits there/);
    assert.equal(await headSha(root), before);
  }
});

test('default branch from origin/HEAD is never committed when named in commitBranches', async t => {
  const root = await fixture(t, { branch: 'develop' });
  await git(root, 'branch', '-M', 'develop');
  await git(root, 'remote', 'add', 'origin', root);
  await git(root, 'fetch', 'origin');
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
  const before = await headSha(root);
  await fs.writeFile(
    path.join(root, '.project-swarm.json'),
    `${JSON.stringify({ integrate: { commitBranches: ['develop'] } })}\n`,
  );
  const out = await runCommit(root);
  assert.equal(out.commit?.status, 'skipped');
  assert.match(out.commit?.reason, /the main branch; integrate never commits there/);
  assert.equal(await headSha(root), before);
});

test('swarm/* commits with no project config', async t => {
  const root = await fixture(t, { branch: 'swarm/no-config' });
  const out = await runCommit(root);
  assert.equal(out.commit?.status, 'committed');
});

test('invalid JSON and bad commitBranches skip naming integrate.commitBranches', async t => {
  const root = await fixture(t, { branch: 'swarm/bad-config' });
  await fs.writeFile(path.join(root, '.project-swarm.json'), '{ not json\n');
  let out = await runCommit(root);
  assert.equal(out.commit?.status, 'skipped');
  assert.match(out.commit?.reason, /\.project-swarm\.json integrate\.commitBranches/);

  await fs.writeFile(
    path.join(root, '.project-swarm.json'),
    `${JSON.stringify({ integrate: { commitBranches: 'not-array' } })}\n`,
  );
  out = await runCommit(root);
  assert.equal(out.commit?.status, 'skipped');
  assert.match(out.commit?.reason, /integrate\.commitBranches must be an array of non-empty strings/);
});

test('readIntegrateCommitBranches returns patterns from valid file', async t => {
  const root = await fixture(t, {
    projectSwarm: { integrate: { commitBranches: ['build/*'] } },
  });
  const { patterns, error } = await readIntegrateCommitBranches(root);
  assert.equal(error, null);
  assert.deepEqual(patterns, ['build/*']);
});
