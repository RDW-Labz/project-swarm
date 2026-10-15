// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateManifest, parseGoFlags } from '../tools/swarm.mjs';
import { commitOutputs } from '../tools/go.mjs';
import { createGoBranch, goGoal, isGoalArgument, manifestForGoal, resumeCommand, topLevelFolders, worktreeDirty } from '../tools/goal.mjs';

const exec = promisify(execFile);

test('a sentence is a goal and a manifest path or run id is not', () => {
  assert.equal(isGoalArgument('Add a health check'), true);
  assert.equal(isGoalArgument('run-0001'), false);
  assert.equal(isGoalArgument('examples/smoke.json'), false);
  assert.equal(isGoalArgument('smoke.json'), false);
});

test('planning splits a goal across real folders and never invents src tests or docs', () => {
  const manifest = manifestForGoal('Add a health check', { folders: ['app', 'lib'], checks: [{ name: 'test', argv: ['npm', 'test'] }] });
  validateManifest(manifest);
  assert.equal(manifest.report, 'short');
  assert.equal(manifest.concurrency, 8);
  assert.deepEqual(manifest.budget, { maxUsd: 5, maxTokens: 2_000_000 });
  assert.deepEqual(manifest.jobs.map(job => job.area.scope), [['app/'], ['lib/']]);
  assert.equal(manifest.jobs[0].area.maxJobs, 25);
  assert.equal(manifest.jobs[0].area.concurrency, 8);
  assert.equal(JSON.stringify(manifest).includes('src/'), false);
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const capped = manifestForGoal('Add a health check', { folders: many });
  assert.equal(capped.jobs.length, 10);
  const owned = capped.jobs.flatMap(job => job.area.scope);
  assert.equal(new Set(owned).size, many.length);
  const grouped = manifestForGoal('Add a health check', { folders: ['app', 'lib', 'tools', 'docs'], leads: 2, maxJobs: 4, concurrency: 3 });
  assert.equal(grouped.jobs.length, 2);
  assert.equal(grouped.concurrency, 3);
  assert.equal(grouped.jobs[0].area.maxJobs, 4);
  assert.deepEqual(grouped.jobs.flatMap(job => job.area.scope).sort(), ['app/', 'docs/', 'lib/', 'tools/']);
  assert.throws(() => manifestForGoal('Add a health check', { folders: ['app'], leads: 2 }), { code: 'goal-leads' });
  assert.throws(() => manifestForGoal('Add a health check', { folders: [] }), { code: 'goal-no-folders' });
});

test('go flags set leads, job cap, concurrency, and the run budget', () => {
  assert.deepEqual(parseGoFlags(['--leads', '4', '--max-jobs', '10', '--concurrency', '8', '--max-usd', '2.5', '--max-tokens', '1000']), {
    commitMessage: undefined, repo: undefined, payloadPath: undefined, requireSections: [], mergeMethod: undefined, timeoutMs: undefined, mutants: false,
    leads: 4, maxJobs: 10, concurrency: 8, maxUsd: 2.5, maxTokens: 1000,
  });
  assert.equal(parseGoFlags(['--leads', 'auto']).leads, 'auto');
  assert.throws(() => parseGoFlags(['--leads', '11']), /--leads/);
  assert.throws(() => parseGoFlags(['--max-tokens', '1.5']), /--max-tokens/);
});

function deps(extra = {}) {
  return {
    dirty: async () => false,
    folders: async () => ['app', 'lib'],
    plan: (goal, options) => manifestForGoal(goal, options),
    runId: () => 'run-1',
    branch: async () => ({ branch: 'swarm/go-run-1' }),
    run: async () => ({ id: 'run-1' }),
    wait: async () => ({ status: 'complete', costUsd: 0.1, warnings: [] }),
    integrate: async () => ({ status: 'integrated', checkFailed: [], files: ['app/note.txt'] }),
    commit: async () => ({ status: 'committed' }),
    rollup: async () => ({ id: 'run-1', status: 'complete' }),
    ...extra,
  };
}

test('go on a goal plans, runs under the default budget, commits on its branch, then rolls up', async () => {
  const order = [];
  let seen = null;
  const result = await goGoal('/tmp/repo', 'Add a health check', {}, deps({
    dirty: async () => { order.push('dirty'); return false; },
    folders: async () => { order.push('folders'); return ['app', 'lib']; },
    plan: (goal, options) => { order.push('plan'); return manifestForGoal(goal, options); },
    branch: async (_root, branch) => { order.push(`branch:${branch}`); return { branch }; },
    run: async (_root, manifest, options) => { order.push('run'); seen = { manifest, options }; return { id: 'run-1' }; },
    wait: async () => { order.push('wait'); return { status: 'complete', costUsd: 0.1, warnings: [] }; },
    integrate: async (_root, id) => { order.push(`integrate:${id}`); return { status: 'integrated', checkFailed: [], files: ['app/note.txt'] }; },
    commit: async (_root, files, message) => { order.push(`commit:${files[0]}:${message}`); return { status: 'committed' }; },
    rollup: async () => { order.push('rollup'); return { id: 'run-1', status: 'complete' }; },
  }));
  assert.deepEqual(order, ['dirty', 'folders', 'plan', 'branch:swarm/go-run-1', 'run', 'wait', 'integrate:run-1', 'commit:app/note.txt:swarm go: Add a health check', 'rollup']);
  assert.equal(seen.options.maxUsd, 5);
  assert.equal(seen.options.maxTokens, 2_000_000);
  assert.deepEqual(seen.manifest.jobs.map(job => job.area.scope), [['app/'], ['lib/']]);
  assert.equal(result.status, 'complete');
  assert.equal(result.branch, 'swarm/go-run-1');
  assert.equal(result.rollup.id, 'run-1');
});

test('a smaller budget flag replaces the default', async () => {
  let seen = null;
  await goGoal('/tmp/repo', 'Add a health check', { maxUsd: 1, maxTokens: 1000 }, deps({
    run: async (_root, _manifest, options) => { seen = options; return { id: 'run-1' }; },
  }));
  assert.deepEqual(seen, { id: 'run-1', maxUsd: 1, maxTokens: 1000 });
});

test('a cap pause tells you how to resume and does not integrate', async () => {
  let integrated = false;
  const pause = { message: 'spend-cap: run spent $5 >= maxUsd $5; resume with --raise maxUsd=<N> --reason TEXT' };
  const result = await goGoal('/tmp/repo', 'Add a health check', {}, deps({
    wait: async () => ({ status: 'paused', costUsd: 5, warnings: [], pause }),
    integrate: async () => { integrated = true; return { status: 'integrated', files: [] }; },
  }));
  assert.equal(integrated, false);
  assert.equal(result.status, 'paused');
  assert.equal(result.resume, resumeCommand('run-1', pause));
  assert.equal(result.resume, 'swarm resume run-1 --raise maxUsd=<N> --reason TEXT');
  assert.equal(result.branch, 'swarm/go-run-1');
});

test('a dirty tree is refused before a branch is created', async () => {
  let branched = false;
  const result = await goGoal('/tmp/repo', 'Add a health check', {}, deps({
    dirty: async () => true,
    branch: async () => { branched = true; },
  }));
  assert.equal(branched, false);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /goal-dirty/);
});

test('a goal does not open a pull request', async () => {
  const result = await goGoal('/tmp/repo', 'Add a health check', { payloadPath: 'pr.json' }, deps());
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /--pr/);
});

async function gitRepo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-go-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await exec('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  await exec('git', ['-C', root, 'config', 'user.name', 'Test']);
  await fs.mkdir(path.join(root, 'app'));
  await fs.mkdir(path.join(root, 'lib'));
  await fs.writeFile(path.join(root, 'app/keep.txt'), 'keep\n');
  await exec('git', ['-C', root, 'add', 'app/keep.txt']);
  await exec('git', ['-C', root, 'commit', '-qm', 'base']);
  return root;
}

test('go refuses a dirty repo, then commits only on swarm/go-<runId> and leaves main alone', async t => {
  const root = await gitRepo(t);
  const base = (await exec('git', ['-C', root, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim();
  await fs.writeFile(path.join(root, 'app/dirty.txt'), 'dirty\n');
  const refused = await goGoal(root, 'Add a health check', {}, deps({
    dirty: () => worktreeDirty(root),
    folders: () => topLevelFolders(root),
    branch: (cwd, name) => createGoBranch(cwd, name),
  }));
  assert.match(refused.reason, /goal-dirty/);
  assert.equal((await exec('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' })).stdout.trim(), 'main');
  await fs.rm(path.join(root, 'app/dirty.txt'));
  const gitArgs = [];
  const run = (file, args, options) => { gitArgs.push(args); return exec(file, args, options); };
  const result = await goGoal(root, 'Add a health check', {}, deps({
    dirty: () => worktreeDirty(root, run),
    folders: () => topLevelFolders(root),
    branch: (cwd, name) => createGoBranch(cwd, name, run),
    integrate: async () => {
      await fs.writeFile(path.join(root, 'app/note.txt'), 'note\n');
      return { status: 'integrated', checkFailed: [], files: ['app/note.txt'] };
    },
    commit: (cwd, files, message) => commitOutputs(cwd, files, message),
  }));
  assert.equal(result.status, 'complete', result.reason);
  assert.equal(result.branch, 'swarm/go-run-1');
  assert.equal((await exec('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' })).stdout.trim(), 'swarm/go-run-1');
  assert.equal((await exec('git', ['-C', root, 'rev-parse', 'main'], { encoding: 'utf8' })).stdout.trim(), base);
  assert.notEqual((await exec('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim(), base);
  assert.equal((await exec('git', ['-C', root, 'show', 'HEAD:app/note.txt'], { encoding: 'utf8' })).stdout, 'note\n');
  assert.equal(gitArgs.some(args => args.includes('checkout') && args.includes('main')), false);
});

test('topLevelFolders skips folders with no tracked files in a git repo, and lists every folder outside git', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-folders-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'empty'));
  await fs.mkdir(path.join(root, 'untracked'));
  await fs.writeFile(path.join(root, 'src/a.txt'), 'a\n');
  await fs.writeFile(path.join(root, 'untracked/b.txt'), 'b\n');
  assert.deepEqual(await topLevelFolders(root), ['empty', 'src', 'untracked']);
  const { execFile } = await import('node:child_process');
  const run = (...args) => new Promise((resolve, reject) => execFile('git', ['-C', root, ...args], error => (error ? reject(error) : resolve())));
  await run('init', '-q');
  await run('add', 'src');
  assert.deepEqual(await topLevelFolders(root), ['src']);
});

test('lead prompts list the tracked files inside their scope, capped and cleaned', () => {
  const files = ['src/a.js', 'src/b.js', 'tests/t.js', 'src‮/evil.js', 'README.md'];
  const m = manifestForGoal('do it', { folders: ['src', 'tests'], files, leads: 2, maxJobs: 5, concurrency: 1 });
  const src = m.jobs.find(job => job.area.scope.includes('src/')).prompt;
  assert.match(src, /FILES IN YOUR SCOPE \(2 of 2/);
  assert.match(src, /- src\/a\.js\n- src\/b\.js/);
  assert.ok(!src.includes('tests/t.js') && !src.includes('README.md') && !/‮/.test(src));
  const many = manifestForGoal('x', { folders: ['src'], files: Array.from({ length: 300 }, (_, n) => `src/f${n}.js`), leads: 1, maxJobs: 5, concurrency: 1 });
  assert.match(many.jobs[0].prompt, /\(200 of 300/);
  assert.equal(manifestForGoal('x', { folders: ['src'], leads: 1 }).jobs[0].prompt.includes('FILES IN YOUR SCOPE'), false);
});
