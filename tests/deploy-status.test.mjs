// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { githubRepo, fetchDeployStatus, createDeployTracker } from '../tools/deploy-status.mjs';

const temp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-status-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function configRepo(t, url) {
  const root = await temp(t);
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.writeFile(path.join(root, '.git/config'), `[remote "origin"]\n\turl = ${url}\n`);
  return root;
}

test('githubRepo reads GitHub https, ssh and scp remotes, including a linked worktree git file', async t => {
  assert.equal(await githubRepo(await configRepo(t, 'https://github.com/acme/web.git')), 'acme/web');
  assert.equal(await githubRepo(await configRepo(t, 'ssh://git@github.com/acme/web')), 'acme/web');
  assert.equal(await githubRepo(await configRepo(t, 'git@github.com:acme/web.git')), 'acme/web');

  const root = await temp(t);
  const common = path.join(root, 'common.git');
  const gitDir = path.join(root, 'private', 'worktrees', 'one');
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  await fs.writeFile(path.join(gitDir, 'commondir'), '../../../common.git\n');
  await fs.mkdir(common, { recursive: true });
  await fs.writeFile(path.join(common, 'config'), '[remote "origin"]\n\turl = git@github.com:acme/worktree.git\n');
  assert.equal(await githubRepo(root), 'acme/worktree');
});

test('githubRepo returns null for no origin, non-GitHub and invalid owner remotes', async t => {
  const noOrigin = await temp(t);
  await fs.mkdir(path.join(noOrigin, '.git'), { recursive: true });
  await fs.writeFile(path.join(noOrigin, '.git/config'), '[remote "upstream"]\n\turl = https://github.com/acme/web.git\n');
  assert.equal(await githubRepo(noOrigin), null);
  assert.equal(await githubRepo(await configRepo(t, 'https://gitlab.com/acme/web.git')), null);
  assert.equal(await githubRepo(await configRepo(t, 'https://github.com/acme!/web.git')), null);
});

test('fetchDeployStatus reads the newest deployment statuses without forwarding tokens or using a shell', async () => {
  const calls = [];
  const deployments = [
    { id: 3, sha: 'sha-new', created_at: '2026-10-20T12:00:00Z' },
    { id: 2, sha: 'sha-old', created_at: '2026-10-19T12:00:00Z' },
    { id: 1, sha: 'sha-older', created_at: '2026-10-18T12:00:00Z' },
  ];
  const statuses = {
    3: [{ state: 'failure', environment: 'preview', created_at: '2026-10-20T12:01:00Z', target_url: 'http://insecure.example' }],
    2: [{ state: 'success', environment: 'production', created_at: '2026-10-19T12:01:00Z', environment_url: 'https://deploy.example/production' }],
    1: [{ state: 'success', environment: 'old', created_at: '2026-10-18T12:01:00Z', target_url: 'https://deploy.example/old' }],
  };
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const id = args[1]?.match(/deployments\/(\d+)\/statuses/)?.[1];
    return { code: 0, stdout: JSON.stringify(id ? statuses[id] : deployments), stderr: '' };
  };
  const result = await fetchDeployStatus({ repo: 'acme/web', ref: 'feature branch', run, env: { GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret2', PATH: '/bin' } });
  assert.equal(result.latest.state, 'failure');
  assert.equal(result.latest.id, 3);
  assert.equal(result.latest.url, null);
  assert.equal(result.lastSuccess.environment, 'production');
  assert.equal(result.lastSuccess.sha, 'sha-old');
  assert.equal(result.lastSuccess.url, 'https://deploy.example/production');
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.cmd === 'gh' && Array.isArray(call.args) && call.opts.shell === false));
  assert.ok(calls.every(call => !('GITHUB_TOKEN' in call.opts.env) && !('GH_TOKEN' in call.opts.env) && call.opts.env.GH_PROMPT_DISABLED === '1'));
  assert.match(calls[0].args[3], /ref=feature%20branch&per_page=10$/);
});

test('fetchDeployStatus returns a short error on gh failure or bad JSON', async () => {
  const failed = await fetchDeployStatus({ repo: 'acme/web', run: async () => ({ code: 1, stdout: 'secret output', stderr: 'noisy error' }) });
  assert.equal(failed.latest, null);
  assert.equal(failed.lastSuccess, null);
  assert.match(failed.error, /failed/);
  assert.doesNotMatch(failed.error, /secret output/);
  const bad = await fetchDeployStatus({ repo: 'acme/web', run: async () => ({ code: 0, stdout: '{bad', stderr: '' }) });
  assert.match(bad.error, /bad JSON/);
});

test('createDeployTracker returns cached values, coalesces refreshes, and honors ttl', async t => {
  const root = await temp(t);
  let now = 0;
  let calls = 0;
  const tracker = createDeployTracker({
    ttlMs: 100,
    now: () => now,
    repoOf: async () => 'acme/web',
    run: async (cmd, args) => {
      calls += 1;
      return { code: 0, stdout: JSON.stringify(args[1]?.includes('deployments/') ? [{ state: 'success', environment: 'production', created_at: new Date(now).toISOString() }] : [{ id: calls, sha: 'sha', created_at: new Date(now).toISOString() }]), stderr: '' };
    },
  });
  assert.equal(tracker.get(root), null);
  await tracker.refresh(root);
  assert.equal(tracker.get(root).lastSuccess.environment, 'production');
  assert.equal(calls, 2);

  now = 50;
  tracker.get(root);
  assert.equal(calls, 2);
  now = 100;
  tracker.get(root);
  assert.equal(calls, 2, 'the ttl boundary is still fresh');
  now = 101;
  tracker.get(root);
  assert.equal(calls, 2, 'the refresh is started in the background');
  await tracker.refresh(root);
  assert.equal(calls, 4);

  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const slow = createDeployTracker({ repoOf: async () => 'acme/web', run: async () => { calls += 1; await pending; return { code: 0, stdout: '[]', stderr: '' }; } });
  assert.equal(slow.get(root), null);
  assert.equal(slow.get(root), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 5);
  release();
  await slow.refresh(root);
});
