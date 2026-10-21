// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installGitHooks } from '../tools/git-hooks.mjs';
import {
  checkCommitMsg,
  isManifestCommitSubject,
} from '../tools/githook-check.mjs';

test('(1) hook runs backed-up hook before infra skip', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-prev-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const gitDir = path.join(dir, '.git');
  const hooks = path.join(gitDir, 'hooks');
  await fs.mkdir(hooks, { recursive: true });
  const init = spawnSync('git', ['-C', dir, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0);
  const prev = path.join(hooks, 'commit-msg.before-swarm');
  await fs.writeFile(prev, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const check = path.join(dir, 'missing-check.mjs');
  const hookPath = path.join(hooks, 'commit-msg');
  installGitHooks(dir, {
    fs: fssync,
    exec: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${hooks}\n`;
      throw new Error('unexpected git');
    },
    checkScript: check,
    nodePath: '/nonexistent/node-for-swarm-hook',
  });
  const body = await fs.readFile(hookPath, 'utf8');
  const infra = body.indexOf('node or script missing');
  const prevRun = body.indexOf('"$PREV"');
  assert.ok(prevRun >= 0 && infra > prevRun, 'PREV must run before infra skip');
  const run = spawnSync('sh', [hookPath, path.join(dir, 'msg')], {
    encoding: 'utf8',
    cwd: dir,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME },
  });
  assert.equal(run.status, 7);
});

test('(7) Manifest validation colon subject is not a manifest commit', () => {
  assert.equal(isManifestCommitSubject('Manifest validation: bump version'), false);
  assert.ok(isManifestCommitSubject('manifest x'));
});

test('(8) pre-commit hook maps node crash to skip not block', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-pc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = path.join(dir, 'hooks');
  await fs.mkdir(hooks, { recursive: true });
  const badCheck = path.join(dir, 'bad.mjs');
  await fs.writeFile(badCheck, 'syntax {{{\n');
  installGitHooks(dir, {
    fs: fssync,
    exec: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${hooks}\n`;
      throw new Error('unexpected git');
    },
    checkScript: badCheck,
    nodePath: process.execPath,
  });
  const body = await fs.readFile(path.join(hooks, 'pre-commit'), 'utf8');
  assert.match(body, /hand-build check skipped \(infrastructure\)/);
  const afterCheck = body.split('"$NODE" "$CHECK" pre-commit')[1] ?? '';
  assert.doesNotMatch(afterCheck, /exit \$\?/);
});

test('(10) commit-msg check uses full index for amend-sized trees', () => {
  const bad = checkCommitMsg({
    subject: 'Manifest: ship',
    stagedPaths: ['coordination/manifests/a.json', 'src/leak.ts'],
  });
  assert.equal(bad.ok, false);
});
