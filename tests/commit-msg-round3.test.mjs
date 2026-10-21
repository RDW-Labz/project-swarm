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

function hookRunEnv(extra = {}) {
  const nodeDir = path.dirname(process.execPath);
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.HOME,
    SWARM_CONFIG: process.env.SWARM_CONFIG,
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
    PATH: `/usr/bin:/bin:/usr/sbin:/sbin${path.delimiter}${nodeDir}`,
    ...extra,
  };
}

test('(8) pre-commit hook maps node crash to skip not block', async t => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-pc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-b', 'main'], {
    cwd: root,
    encoding: 'utf8',
    env: hookRunEnv(),
  });
  assert.equal(init.status, 0);

  const badCheck = path.join(root, 'bad.mjs');
  await fs.writeFile(
    badCheck,
    `import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'syntax {{{'], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write('swarm git hook: hand-build check skipped (infrastructure)\\n');
  process.exit(0);
}
process.exit(r.status ?? 0);
`,
  );
  installGitHooks(root, { checkScript: badCheck, nodePath: process.execPath });

  const hookRel = spawnSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], {
    cwd: root,
    encoding: 'utf8',
    env: hookRunEnv(),
  }).stdout.trim();
  const hookPath = path.isAbsolute(hookRel) ? hookRel : path.join(root, hookRel);

  const crashed = spawnSync('/bin/sh', [hookPath], {
    cwd: root,
    encoding: 'utf8',
    env: hookRunEnv(),
  });
  assert.equal(crashed.status, 0);
  assert.match(crashed.stderr, /hand-build check skipped \(infrastructure\)/);
  assert.equal(crashed.stderr.trim().split('\n').filter(l => /check skipped/.test(l)).length, 1);

  const violCheck = path.join(root, 'viol.mjs');
  await fs.writeFile(violCheck, 'process.stderr.write("Hand-build guard: denied\\n");\nprocess.exit(1);\n');
  installGitHooks(root, { checkScript: violCheck, nodePath: process.execPath });
  const violation = spawnSync('/bin/sh', [hookPath], {
    cwd: root,
    encoding: 'utf8',
    env: hookRunEnv(),
  });
  assert.equal(violation.status, 1);
});

test('(10) commit-msg check uses full index for amend-sized trees', () => {
  const bad = checkCommitMsg({
    subject: 'Manifest: ship',
    stagedPaths: ['coordination/manifests/a.json', 'src/leak.ts'],
  });
  assert.equal(bad.ok, false);
});
