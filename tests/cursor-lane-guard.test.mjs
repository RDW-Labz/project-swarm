// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const guardPath = fileURLToPath(new URL('../tools/cursor_lane_guard.py', import.meta.url));
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const options = { skip: python.error?.code === 'ENOENT' ? 'python3 is not on PATH' : false };

function expectStatus(result, status) {
  assert.ifError(result.error);
  assert.equal(result.status, status, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'cursor-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'worker');
  fs.mkdirSync(repo);
  const env = {
    ...process.env,
    REPO: repo,
    SWARM: `${process.execPath} ${path.join(dir, 'board.mjs')}`,
    SWARM_LIVE_DIR: path.join(dir, 'live'),
    SWARM_CONFIG: path.join(dir, 'config.json'),
    GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const boardPath = path.join(dir, 'board.json');
  const board = runs => fs.writeFileSync(boardPath, JSON.stringify({ runs }));
  board([]);
  fs.writeFileSync(path.join(dir, 'board.mjs'), `
import fs from 'node:fs';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['--root', process.env.REPO, 'board']);
console.log(fs.readFileSync(new URL('./board.json', import.meta.url), 'utf8'));
`);
  const git = (...args) => expectStatus(spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }), 0).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'owned.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'base\n');
  git('add', 'owned.txt', 'other.txt');
  git('commit', '-m', 'Initial fixture');
  git('worktree', 'add', '-b', 'cursor-task', worktree);
  const run = (...args) => spawnSync('python3', [guardPath, ...args], { cwd: repo, env, encoding: 'utf8' });
  const claims = () => JSON.parse(fs.readFileSync(path.join(repo, 'coordination/cursor-claims.json'), 'utf8'));
  return { dir, repo, worktree, env, board, git, run, claims };
}

test('Cursor claim records files and base; another Cursor job cannot claim the same file', options, t => {
  const f = fixture(t);
  expectStatus(f.run('claim', 'first', 'owned.txt'), 0);
  assert.deepEqual(f.claims(), { first: { files: ['owned.txt'], base: f.git('rev-parse', 'HEAD') } });
  assert.match(expectStatus(f.run('claim', 'second', 'owned.txt'), 1), /already claimed by cursor job first/);
  assert.deepEqual(Object.keys(f.claims()), ['first']);
});

test('Cursor claim refuses live swarm outputs for this repo, but ignores other repos', options, t => {
  const f = fixture(t);
  f.board([{ root: path.join(f.dir, 'unrelated'), runId: 'elsewhere', jobs: [{ id: 'job', outputs: ['owned.txt'] }] }]);
  expectStatus(f.run('claim', 'cursor-task', 'owned.txt'), 0);
  f.board([{ root: f.repo, runId: 'live-run', jobs: [{ id: 'writer', status: 'running', outputs: ['other.txt'] }] }]);
  assert.match(expectStatus(f.run('claim', 'second', 'other.txt'), 1), /output of live swarm job live-run\/writer/);
  assert.deepEqual(Object.keys(f.claims()), ['cursor-task']);
});

test('Cursor check passes committed and uncommitted changes limited to claimed files', options, t => {
  const f = fixture(t);
  expectStatus(f.run('claim', 'cursor-task', 'owned.txt', 'new.txt'), 0);
  fs.writeFileSync(path.join(f.worktree, 'owned.txt'), 'worker\n');
  f.git('-C', f.worktree, 'commit', '-am', 'Worker change');
  fs.writeFileSync(path.join(f.worktree, 'owned.txt'), 'more worker changes\n');
  fs.writeFileSync(path.join(f.worktree, 'new.txt'), 'claimed untracked file\n');
  expectStatus(f.run('check', 'cursor-task', f.worktree), 0);
});

for (const filename of ['other.txt', 'untracked.txt']) {
  test(`Cursor check refuses an unclaimed change to ${filename}`, options, t => {
    const f = fixture(t);
    expectStatus(f.run('claim', 'cursor-task', 'owned.txt'), 0);
    fs.writeFileSync(path.join(f.worktree, filename), 'unclaimed change\n');
    const output = expectStatus(f.run('check', 'cursor-task', f.worktree), 1);
    assert.ok(output.includes(`worktree changed unclaimed files: ${filename}`), output);
  });
}

test('Cursor check refuses a claimed file changed on the base branch since the claim', options, t => {
  const f = fixture(t);
  expectStatus(f.run('claim', 'cursor-task', 'owned.txt'), 0);
  fs.writeFileSync(path.join(f.repo, 'owned.txt'), 'base branch moved\n');
  f.git('commit', '-am', 'Base change');
  assert.match(expectStatus(f.run('check', 'cursor-task', f.worktree), 1), /main changed claimed files since the claim: owned\.txt/);
});

test('Cursor manifest check refuses held outputs and release removes the claim', options, t => {
  const f = fixture(t);
  expectStatus(f.run('claim', 'cursor-task', 'owned.txt'), 0);
  const manifest = path.join(f.dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ jobs: [{ id: 'writer', outputs: ['owned.txt'] }] }));
  assert.match(expectStatus(f.run('check-manifest', manifest), 1), /owned\.txt \(cursor job cursor-task\)/);
  assert.deepEqual(JSON.parse(expectStatus(f.run('list'), 0)), f.claims());
  expectStatus(f.run('release', 'cursor-task'), 0);
  assert.deepEqual(f.claims(), {});
  expectStatus(f.run('check-manifest', manifest), 0);
});

test('Cursor guard uses the sibling swarm runner without a project pin or SWARM override', options, t => {
  const f = fixture(t);
  delete f.env.SWARM;
  expectStatus(f.run('claim', 'cursor-task', 'owned.txt'), 0);
  assert.deepEqual(f.claims()['cursor-task'].files, ['owned.txt']);
});

test('Cursor guard honors a project pin and lets SWARM override a missing pinned install', options, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.project-swarm.json'), JSON.stringify({ install: path.join(f.dir, 'install'), version: '0.0.0' }));
  const override = f.env.SWARM;
  delete f.env.SWARM;
  const missing = f.run('claim', 'cursor-task', 'owned.txt');
  expectStatus(missing, 1);
  assert.match(missing.stderr, /pinned swarm 0\.0\.0 not installed/);
  f.env.SWARM = override;
  expectStatus(f.run('claim', 'cursor-task', 'owned.txt'), 0);
});

test('Cursor guard returns usage exit code 2 for missing or invalid arguments', options, t => {
  const f = fixture(t);
  expectStatus(f.run(), 2);
  expectStatus(f.run('claim', 'cursor-task'), 2);
  expectStatus(f.run('unknown'), 2);
});
