// SPDX-License-Identifier: Apache-2.0
// Swarm batch T job t2: field lesson 255(1) (see .swarm-manifests/contract-t.md).
// The claude and codex shell sandbox profiles deny file-read* and process-exec under
// /private/tmp, /tmp and $TMPDIR except the job's own scratch dir (claude) or worktree/commonDir
// (codex) and whatever swarm-owned temp path each adapter itself needs — named in the profile
// functions' own comments (tools/claude-shell.mjs, tools/codex-adapter.mjs). No real network,
// keychain or home config (see _isolate-config.mjs, imported first by the test runner).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellProfile, startConnectProxy } from '../tools/claude-shell.mjs';
import { codexProfile, defaultTmpRoots } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// --- profile text: both adapters deny read/exec under the tmp roots except what's re-granted ---

test('claude shell profile denies file-read*/process-exec under the tmp roots, except the job scratch dir', () => {
  const profile = shellProfile({
    home: '/Users/example', worktree: '/Users/example/repo/run/worktrees/j', commonDir: '/Users/example/repo/.git',
    shellDir: '/Users/example/repo/run/j/shell', scratchDir: '/fake/tmp/swarm-run-j-scratch', proxyPort: 41000,
    tmpRoots: ['/fake/tmp'],
  });
  const denyIndex = profile.indexOf('(deny file-read* process-exec (subpath "/fake/tmp"))');
  assert.ok(denyIndex > 0, 'a single deny rule names the fake tmp root');
  const readsAllowIndex = profile.indexOf('(allow file-read*', denyIndex + 1);
  const execAllowIndex = profile.indexOf('(allow process-exec');
  assert.ok(readsAllowIndex > denyIndex, 'the deny is written before the general reads allow (later rule wins)');
  assert.ok(execAllowIndex > denyIndex, 'the deny is written before the process-exec allow (later rule wins)');
  // The job's own scratch dir is re-granted for both verbs (it sits under the denied tmp root).
  assert.ok(profile.slice(readsAllowIndex).includes('(subpath "/fake/tmp/swarm-run-j-scratch")'));
  assert.ok(profile.slice(execAllowIndex).includes('(subpath "/fake/tmp/swarm-run-j-scratch")'));
  // A sibling directory under the same tmp root (another job's or checkout's own scratch data)
  // is never named anywhere in the profile, so it stays covered only by the broad deny.
  assert.equal(profile.includes('sibling'), false);
});

test('claude shell profile defaults its tmp roots to /private/tmp, /tmp and the real $TMPDIR', () => {
  const profile = shellProfile({ home: '/Users/example', worktree: '/w', commonDir: '/c', shellDir: '/s', proxyPort: 1 });
  const denyLine = profile.split('\n').find(line => line.startsWith('(deny file-read* process-exec'));
  assert.ok(denyLine.includes('(subpath "/private/tmp")'), denyLine);
  assert.ok(denyLine.includes('(subpath "/tmp")'), denyLine);
  for (const root of defaultTmpRoots()) assert.ok(denyLine.includes(`(subpath "${root}")`), `${root} missing from: ${denyLine}`);
});

test('codex profile denies file-read*/process-exec under the tmp roots, except the job worktree/commonDir', () => {
  const profile = codexProfile({
    home: '/Users/example', worktree: '/fake/tmp/checkout/run/job', commonDir: '/fake/tmp/checkout/.git',
    metadataDir: '/fake/tmp/checkout/.git/worktrees/job', tmpRoots: ['/fake/tmp'],
  });
  const denyIndex = profile.indexOf('(deny file-read* process-exec (subpath "/fake/tmp"))');
  assert.ok(denyIndex > 0, 'a single deny rule names the fake tmp root');
  const readsAllowIndex = profile.indexOf('(allow file-read*', denyIndex + 1);
  const execAllowIndex = profile.indexOf('(allow process-exec');
  assert.ok(readsAllowIndex > denyIndex, 'the deny is written before the general reads allow (later rule wins)');
  assert.ok(execAllowIndex > denyIndex, 'the deny is written before the process-exec allow (later rule wins)');
  // worktree and commonDir (metadataDir is always a subpath of commonDir) are re-granted for
  // both verbs, since codex has no per-job scratch dir of its own.
  for (const dir of ['/fake/tmp/checkout/run/job', '/fake/tmp/checkout/.git']) {
    assert.ok(profile.slice(readsAllowIndex).includes(`(subpath "${dir}")`), dir);
    assert.ok(profile.slice(execAllowIndex).includes(`(subpath "${dir}")`), dir);
  }
  // A sibling checkout under the same tmp root is never named anywhere in the profile.
  assert.equal(profile.includes('other-checkout'), false);
});

test('codex profile keeps its existing /private/tmp and /private/var/folders write grants unchanged', () => {
  // Field lesson 255 is about file-read* and process-exec only; the pre-existing broad write
  // grant codex itself needs for its own temp/session files is untouched (contract: keep every
  // existing allow for the workspace, toolchains and system dirs).
  const profile = codexProfile({ home: '/Users/example', worktree: '/Users/example/repo/run/job', commonDir: '/Users/example/repo/.git', metadataDir: '/Users/example/repo/.git/worktrees/job' });
  const writeRule = profile.split('\n').find(line => line.startsWith('(allow file-write*'));
  for (const file of ['/private/tmp', '/private/var/folders']) assert.ok(writeRule.includes(`"${file}"`), file);
});

// --- one real denied read of a sibling temp dir under sandbox-exec, else skipped with a reason --

async function sandboxExecUsable() {
  if (process.platform !== 'darwin') return 'macOS only';
  try { await fs.access(SANDBOX_EXEC); } catch { return `${SANDBOX_EXEC} is missing`; }
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t2-probe-'));
  try {
    const profile = path.join(probeDir, 'probe.sb');
    await fs.writeFile(profile, '(version 1)\n(allow default)\n');
    await execFileAsync(SANDBOX_EXEC, ['-f', profile, '/bin/echo', 'ok'], { timeout: 5000 });
    return null;
  } catch (error) {
    // A nested sandbox (this test worker itself running under sandbox-exec) cannot call
    // sandbox_apply a second time; named here instead of a spurious failure.
    return `sandbox-exec is not usable here: ${String(error.message ?? error).split('\n')[0]}`;
  } finally { await fs.rm(probeDir, { recursive: true, force: true }); }
}

test('a real sandboxed shell can read its own scratch dir but not a sibling temp dir', async t => {
  const reason = await sandboxExecUsable();
  if (reason) { t.skip(reason); return; }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t2-tmpdeny-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const worktree = path.join(base, 'worktree'), shellDir = path.join(base, 'shell'), scratchDir = path.join(base, 'scratch'), sibling = path.join(base, 'sibling-job-scratch');
  for (const dir of [worktree, shellDir, scratchDir, sibling]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(scratchDir, 'own.txt'), 'OWN-SCRATCH-OK\n');
  await fs.writeFile(path.join(sibling, 'secret.txt'), 'PLANTED-OTHER-CHECKOUT\n');
  const proxy = await startConnectProxy();
  t.after(() => proxy.close());
  const profilePath = path.join(base, 'sandbox.sb');
  await fs.writeFile(profilePath, shellProfile({ worktree, commonDir: path.join(worktree, '.git'), shellDir, scratchDir, proxyPort: proxy.port }));
  const probe = [
    `cat '${path.join(scratchDir, 'own.txt')}' 2>/dev/null | grep -q OWN-SCRATCH-OK && echo scratch=allowed || echo scratch=blocked`,
    `cat '${path.join(sibling, 'secret.txt')}' 2>/dev/null | grep -q PLANTED-OTHER-CHECKOUT && echo sibling=allowed || echo sibling=blocked`,
  ].join('; ');
  const { stdout } = await execFileAsync(SANDBOX_EXEC, ['-f', profilePath, '/bin/sh', '-c', probe], { cwd: worktree, env: { PATH: process.env.PATH } });
  const result = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
  assert.deepEqual(result, { scratch: 'allowed', sibling: 'blocked' });
});
