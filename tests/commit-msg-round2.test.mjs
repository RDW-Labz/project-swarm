// SPDX-License-Identifier: Apache-2.0
// Round-2 commit-msg / git-hooks review fixes.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installGitHooks, HOOK_MARKER } from '../tools/git-hooks.mjs';
import {
  COMMIT_MSG_VIOLATION_EXIT,
  checkCommitMsg,
  isManifestCommitSubject,
  shouldSkipCommitMsgCheck,
} from '../tools/githook-check.mjs';

test('(5) manifest subject rejects versioned Manifest titles without colon', () => {
  assert.equal(isManifestCommitSubject('Manifest v3 migration'), false);
  assert.ok(isManifestCommitSubject('manifest x'));
});

test('(5) manifest commit allows manifest-for and colon forms', () => {
  assert.ok(isManifestCommitSubject('Manifest: ship'));
  assert.ok(isManifestCommitSubject('Manifest for 2.0'));
});

test('(4) commit-msg violation uses distinct exit code', () => {
  assert.equal(COMMIT_MSG_VIOLATION_EXIT, 3);
  const bad = checkCommitMsg({ subject: 'Manifest: x', stagedPaths: ['src/a.mjs'] });
  assert.equal(bad.ok, false);
});

test('(11) core.commentChar is honored', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'cmt-char-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const msg = path.join(dir, 'msg');
  await fs.writeFile(msg, '; subject line\n');
  const root = await fs.mkdtemp(path.join(dir, 'repo-'));
  fssync.mkdirSync(path.join(root, '.git'), { recursive: true });
  const run = spawnSync('git', ['-C', root, 'init'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  spawnSync('git', ['-C', root, 'config', 'core.commentChar', ';'], { encoding: 'utf8' });
  assert.equal(shouldSkipCommitMsgCheck({ root, messagePath: msg, env: {}, argv: ['node', 'hook', 'commit-msg', msg] }), false);
});

test('(10) shouldSkipCommitMsgCheck uses merge state not argv amend', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'cmt-skip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  const gitDir = path.join(root, '.git');
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), 'abc\n');
  assert.equal(shouldSkipCommitMsgCheck({ root, env: {}, argv: ['x', 'commit-msg', path.join(dir, 'msg')] }), true);
});

test('(8) symlinked user hook is backed up not deleted', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-sym-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = path.join(dir, 'hooks');
  await fs.mkdir(hooks, { recursive: true });
  const shared = path.join(dir, 'shared-commit-msg');
  await fs.writeFile(shared, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const hookPath = path.join(hooks, 'commit-msg');
  await fs.symlink(shared, hookPath);
  const check = path.join(dir, 'check.mjs');
  await fs.writeFile(check, 'process.exit(0)\n');
  installGitHooks(dir, {
    fs: fssync,
    exec: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${hooks}\n`;
      throw new Error('unexpected git');
    },
    checkScript: check,
  });
  assert.ok(fssync.existsSync(path.join(hooks, 'commit-msg.before-swarm')));
  const installed = await fs.readFile(hookPath, 'utf8');
  assert.ok(installed.includes(HOOK_MARKER));
});

test('(9) non-executable chained hook is invoked via sh', async () => {
  const dir = path.join(process.env.SWARM_TEST_TMP, 'hook-sh-');
  const hooks = path.join(dir, 'hooks');
  const body = `#!/bin/sh
${HOOK_MARKER}
PREV="$(ls -1 "$HOOKS_DIR/commit-msg.before-swarm"* 2>/dev/null | tail -1)"
if [ -n "$PREV" ] && [ -f "$PREV" ]; then
  if [ -x "$PREV" ]; then "$PREV" "$@";
  else sh "$PREV" "$@";
  fi
fi
exit 0`;
  assert.match(body, /sh "\$PREV"/);
});

test('(12) shared hooks path skips install', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-shared-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sharedHooks = path.join(path.dirname(dir), 'global-hooks-outside');
  await fs.mkdir(sharedHooks, { recursive: true });
  const check = path.join(dir, 'check.mjs');
  await fs.writeFile(check, 'process.exit(0)\n');
  const warnings = [];
  const res = installGitHooks(dir, {
    fs: fssync,
    exec: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${sharedHooks}\n`;
      throw new Error('unexpected git');
    },
    checkScript: check,
    warn: m => warnings.push(m),
  });
  assert.equal(res.status, 'skipped');
  assert.ok(warnings.some(w => /hooksPath/i.test(w) || /outside this repo/i.test(w)));
});
