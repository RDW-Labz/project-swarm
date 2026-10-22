// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { installGitHooks, HOOK_MARKER } from '../tools/git-hooks.mjs';
import {
  checkCommitMsg,
  isManifestCommitSubject,
  pathsFromCachedNameStatus,
  shouldSkipCommitMsgCheck,
} from '../tools/githook-check.mjs';

test('(5) manifest subject prefix only', () => {
  assert.ok(isManifestCommitSubject('Manifest: ok'));
  assert.ok(isManifestCommitSubject('Manifests: ok'));
  assert.ok(isManifestCommitSubject('Manifest for 1.0'));
  assert.ok(isManifestCommitSubject('manifest x'));
  assert.equal(isManifestCommitSubject('Manifest parser: fix'), false);
});

test('(5) name-status -z parsing', () => {
  const z = 'M\0coordination/manifests/a.json\0A\0coordination/manifests/b.json\0';
  assert.deepEqual(pathsFromCachedNameStatus(z), ['coordination/manifests/a.json', 'coordination/manifests/b.json']);
});

test('(5) case-sensitive manifest paths', () => {
  const bad = checkCommitMsg({
    subject: 'Manifest: x',
    stagedPaths: ['coordination/Manifests/x.json'],
  });
  assert.equal(bad.ok, false);
});

test('(4) hook install uses single-quoted paths', async t => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'hook-quote-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hooks = path.join(dir, 'hooks');
  await fs.mkdir(hooks, { recursive: true });
  const tricky = path.join(dir, "node'$check.mjs");
  await fs.writeFile(tricky, 'export {}\n');
  installGitHooks(dir, {
    fs: fssync,
    exec: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-path') return `${hooks}\n`;
      throw new Error('unexpected git');
    },
    checkScript: tricky,
    nodePath: '/usr/bin/node',
  });
  const script = await fs.readFile(path.join(hooks, 'commit-msg'), 'utf8');
  assert.ok(script.includes(HOOK_MARKER));
  assert.ok(script.includes("CHECK='") && script.includes("$check.mjs'"));
  assert.doesNotMatch(script, /CHECK="/);
});

test('(3)(10) shouldSkipCommitMsgCheck merge and fixup', () => {
  assert.equal(shouldSkipCommitMsgCheck({ env: { GIT_COMMIT_MSG: 'fixup! earlier' } }), true);
});
