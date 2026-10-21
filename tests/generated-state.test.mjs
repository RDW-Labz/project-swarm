// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GENERATED_STATE,
  isGeneratedStateFile,
  filterGeneratedStatus,
  dirtyFiles,
} from '../tools/generated-state.mjs';
import { integrateCheckoutDirtyFromPorcelain, integrationBlocker } from '../tools/autopilot.mjs';
import { worktreeDirty, worktreeDirtyPaths, goGoal } from '../tools/goal.mjs';
import { cleanBranch } from '../tools/swarm/core-12.mjs';

const execFileAsync = promisify(execFile);
const tmpBase = () => process.env.SWARM_TEST_TMP || os.tmpdir();

async function gitEnv(root) {
  const home = await fs.mkdtemp(path.join(tmpBase(), 'gs-home-'));
  const gitconfig = path.join(home, '.gitconfig');
  return {
    env: {
      HOME: home,
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_SYSTEM: '/dev/null',
      SWARM_CONFIG: process.env.SWARM_CONFIG,
      SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
    },
    home,
  };
}

async function initRepo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpBase(), 'gs-repo-')));
  const { env, home } = await gitEnv(root);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  await execFileAsync('git', ['init', '-q'], { cwd: root, env });
  await execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-qm', 'init'], { cwd: root, env });
  const runGit = (args) => execFileAsync('git', args, { cwd: root, env, maxBuffer: 8 * 1024 * 1024 });
  return { root, env, runGit };
}

test('isGeneratedStateFile truth table', () => {
  for (const entry of GENERATED_STATE) {
    if (entry.endsWith('/')) {
      assert.equal(isGeneratedStateFile(`${entry}x`), true, entry);
      assert.equal(isGeneratedStateFile(entry.slice(0, -1)), true, entry);
    } else {
      assert.equal(isGeneratedStateFile(entry), true, entry);
    }
  }
  assert.equal(isGeneratedStateFile('docs/scope/roadmap.md'), false);
  assert.equal(isGeneratedStateFile('docs/plans/ideas.md'), false);
  assert.equal(isGeneratedStateFile('coordination/manifests/x.json'), false);
  assert.equal(isGeneratedStateFile('../secret'), false);
  assert.equal(isGeneratedStateFile('/abs/path'), false);
  assert.equal(isGeneratedStateFile('coordination/HANDOFF.MD'), false);
});

test('dirtyFiles ignores generated paths only', async t => {
  const { root, runGit } = await initRepo(t);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/scope/context'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/state'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/HANDOFF.md'), 'h\n');
  await fs.writeFile(path.join(root, 'coordination/TASK.md'), 't\n');
  await fs.writeFile(path.join(root, 'docs/state/usage-ledger.md'), 'u\n');
  await fs.writeFile(path.join(root, 'docs/scope/build-plan.md'), 'b\n');
  await fs.writeFile(path.join(root, 'docs/scope/context/a.md'), 'a\n');
  await fs.writeFile(path.join(root, '.swarm/project/journal.ndjson'), '\n');
  await runGit(['add', '-A']);
  const exec = async (cmd, args) => {
    const { stdout } = await execFileAsync(cmd, args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    return { stdout };
  };
  assert.deepEqual(await dirtyFiles(root, { exec }), []);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/real.txt'), 'x\n');
  const dirty = await dirtyFiles(root, { exec });
  assert.deepEqual(dirty.map(d => d.path), ['src/real.txt']);
});

test('filterGeneratedStatus and autopilot checkout', () => {
  assert.equal(integrateCheckoutDirtyFromPorcelain(' M coordination/HANDOFF.md\n M docs/state/usage-ledger.md\n'), false);
  assert.equal(integrateCheckoutDirtyFromPorcelain(' M src/real.txt\n'), true);
  assert.equal(integrationBlocker({ branch: 'swarm/x', dirty: false }), null);
  assert.equal(integrationBlocker({ branch: 'swarm/x', dirty: true }), 'the checkout has uncommitted changes (or could not be checked)');
});

test('goal worktreeDirty ignores generated state', async t => {
  const { root, runGit } = await initRepo(t);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/HANDOFF.md'), 'h\n');
  await runGit(['add', 'coordination/HANDOFF.md']);
  assert.equal(await worktreeDirty(root), false);
  await fs.writeFile(path.join(root, 'only-real.txt'), 'x\n');
  assert.equal(await worktreeDirty(root), true);
  const paths = await worktreeDirtyPaths(root);
  assert.ok(paths.some(p => p.path === 'only-real.txt'));
});

test('goal-dirty lists non-generated files', async t => {
  const { root } = await initRepo(t);
  await fs.writeFile(path.join(root, 'dirty.txt'), 'x\n');
  const result = await goGoal(root, 'ship it', {}, {
    dirty: async () => false,
    folders: async () => ['src'],
    plan: async () => { throw new Error('skip'); },
    runId: () => 'x',
    branch: async () => {},
    run: async () => ({}),
    wait: async () => ({}),
    integrate: async () => ({}),
    commit: async () => ({}),
    rollup: async () => ({}),
  });
  assert.match(result.reason, /goal-dirty/);
  assert.match(result.reason, /dirty\.txt/);
});

test('clean-branch-dirty ignores generated files', async t => {
  const { root, runGit } = await initRepo(t);
  await runGit(['checkout', '-b', 'feature']);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/HANDOFF.md'), 'h\n');
  await runGit(['add', 'coordination/HANDOFF.md']);
  await cleanBranch(root, { from: 'HEAD' });
  await fs.writeFile(path.join(root, 'real-edit.txt'), 'x\n');
  await assert.rejects(cleanBranch(root, { from: 'HEAD' }), /real-edit\.txt/);
});
