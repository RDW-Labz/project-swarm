// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installGitHooks, removeGitHooks, HOOK_MARKER } from '../tools/git-hooks.mjs';
import { OFF_FILE } from '../tools/handbuild.mjs';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const CHECK = path.join(PACKAGE, 'tools/githook-check.mjs');
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-gh-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const git = (root, ...args) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=ab', ...args], { cwd: root, encoding: 'utf8' });

async function repo(t) {
  const root = await tmp(t);
  git(root, 'init', '-b', 'main');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination/manifests'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), 'init\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'init');
  return root;
}

function hookPath(root, name) {
  const rel = git(root, 'rev-parse', '--git-path', `hooks/${name}`).stdout.trim();
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function scrubAgentSessionEnv(env) {
  const out = { ...env };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  delete out.SWARM_AGENT_SESSION;
  return out;
}

const gitEnv = extra => ({ ...scrubAgentSessionEnv(process.env), ...extra });

function commit(root, env = {}) {
  return spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=ab', 'commit', '-m', 'm'], { cwd: root, encoding: 'utf8', env: gitEnv(env) });
}

function push(root, remote, branch, env = {}) {
  return spawnSync('git', ['push', remote, branch], { cwd: root, encoding: 'utf8', env: gitEnv(env) });
}

async function integratedRun(root, rel, content) {
  const run = 'RUN-TEST';
  const dir = path.join(root, '.swarm/runs', run);
  await fs.mkdir(dir, { recursive: true });
  const hex = crypto.createHash('sha256').update(content).digest('hex');
  await fs.writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      id: run,
      integratedAt: new Date(T0).toISOString(),
      integratedHashes: { [rel]: hex },
      integratedFiles: [rel],
    }),
  );
}

test('agent session: commits and pushes are enforced; owner terminal and guard-off pass', async t => {
  const root = await repo(t);
  installGitHooks(root, { checkScript: CHECK });
  git(root, 'config', 'core.hooksPath', path.dirname(hookPath(root, 'pre-commit')));

  const bare = await tmp(t);
  git(bare, 'init', '-b', 'main', '--bare');
  git(root, 'remote', 'add', 'origin', bare);
  await fs.writeFile(path.join(root, 'README.md'), 'base\n');
  git(root, 'add', 'README.md');
  commit(root);
  git(root, 'push', '-u', 'origin', 'main');

  const noAgent = scrubAgentSessionEnv(process.env);
  const agent = { ...noAgent, CLAUDECODE: '1' };

  await fs.writeFile(path.join(root, 'src/hand.ts'), 'x\n');
  git(root, 'add', 'src/hand.ts');
  assert.notEqual(commit(root, agent).status, 0, 'commit on main in agent session');
  assert.match(commit(root, agent).stderr, /src\/hand\.ts/);

  git(root, 'checkout', '-b', 'feat');
  await fs.writeFile(path.join(root, 'src/hand.ts'), 'y\n');
  git(root, 'add', 'src/hand.ts');
  const badFeat = commit(root, agent);
  assert.notEqual(badFeat.status, 0);
  assert.match(badFeat.stderr, /src\/hand\.ts/);
  git(root, 'reset', 'HEAD', 'src/hand.ts');
  git(root, 'restore', '--staged', 'src/hand.ts');
  await fs.rm(path.join(root, 'src/hand.ts'), { force: true });

  await fs.writeFile(path.join(root, 'coordination/manifests/t.json'), '{}\n');
  git(root, 'add', 'coordination/manifests/t.json');
  assert.equal(commit(root, agent).status, 0, 'routing path commit');

  const rel = 'src/produced.ts';
  const body = 'integrated\n';
  await integratedRun(root, rel, body);
  await fs.writeFile(path.join(root, rel), body);
  git(root, 'add', rel);
  assert.equal(commit(root, agent).status, 0, 'hash-matching commit');

  await fs.writeFile(path.join(root, rel), 'changed\n');
  git(root, 'add', rel);
  assert.notEqual(commit(root, agent).status, 0, 'byte change fails');

  git(root, 'checkout', 'main');
  await fs.writeFile(path.join(root, 'src/on-main.ts'), 'z\n');
  git(root, 'add', 'src/on-main.ts');
  assert.equal(commit(root, noAgent).status, 0);
  const localSha = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const remoteSha = git(root, 'rev-parse', 'origin/main').stdout.trim();
  const hookProbe = spawnSync('sh', [hookPath(root, 'pre-push'), 'origin', bare], {
    cwd: root,
    env: agent,
    input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
    encoding: 'utf8',
  });
  assert.notEqual(hookProbe.status, 0, `pre-push hook: ${hookProbe.stderr}`);
  const pushed = push(root, 'origin', 'main', agent);
  assert.notEqual(pushed.status, 0, `push main in agent session: ${pushed.stderr}`);
  git(root, 'reset', '--hard', 'origin/main');

  git(root, 'checkout', 'feat');
  git(root, 'fetch', 'origin', 'main');
  const featPush = push(root, 'origin', 'feat', agent);
  assert.equal(featPush.status, 0, `feature push with allowed commits: ${featPush.stderr}`);

  for (const label of ['no CLAUDECODE', 'empty env']) {
    git(root, 'checkout', 'main');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/free.ts'), `ok-${label}\n`);
    git(root, 'add', 'src/free.ts');
    const env = label === 'empty env' ? {} : noAgent;
    const clean = scrubAgentSessionEnv({ ...process.env, ...env });
    assert.equal(commit(root, clean).status, 0, label);
  }

  await fs.mkdir(path.dirname(path.join(root, OFF_FILE)), { recursive: true });
  await fs.writeFile(path.join(root, OFF_FILE), '');
  git(root, 'checkout', '-b', 'off-branch');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/off.ts'), 'off\n');
  git(root, 'add', 'src/off.ts');
  assert.equal(commit(root, agent).status, 0, 'guard off file');
});

test('install is idempotent, keeps a pre-existing hook, uninstall restores it', async t => {
  const root = await repo(t);
  const preCommit = hookPath(root, 'pre-commit');
  await fs.mkdir(path.dirname(preCommit), { recursive: true });
  await fs.writeFile(preCommit, '#!/bin/sh\necho legacy-pre > legacy.log\n', { mode: 0o755 });

  installGitHooks(root, { checkScript: CHECK });
  git(root, 'config', 'core.hooksPath', path.dirname(hookPath(root, 'pre-commit')));
  installGitHooks(root, { checkScript: CHECK });
  const script = await fs.readFile(preCommit, 'utf8');
  assert.ok(script.includes(HOOK_MARKER));
  assert.ok(fsSync.existsSync(`${preCommit}.before-swarm`));

  git(root, 'checkout', '-b', 'feat');
  await fs.writeFile(path.join(root, 'coordination/handoff.md'), '# hi\n');
  git(root, 'add', 'coordination/handoff.md');
  const r = commit(root, { ...scrubAgentSessionEnv(process.env), CLAUDECODE: '1' });
  assert.equal(r.status, 0);

  removeGitHooks(root);
  const restored = await fs.readFile(preCommit, 'utf8');
  assert.match(restored, /legacy-pre/);
  assert.ok(!fsSync.existsSync(`${preCommit}.before-swarm`));
});
