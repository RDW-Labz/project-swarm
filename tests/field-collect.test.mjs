// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  pushFieldExports,
  pullFieldExports,
  DEFAULT_FIELD_REMOTE,
  defaultGit,
} from '../tools/field-collect.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return defaultGit(cwd, args);
}

async function tmpDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedBareRemote(bareDir) {
  await fs.mkdir(bareDir, { recursive: true });
  await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: bareDir });
  const seed = path.join(path.dirname(bareDir), `${path.basename(bareDir)}-seed`);
  await fs.mkdir(seed, { recursive: true });
  await git(seed, ['init', '-b', 'main']);
  await git(seed, ['config', 'user.name', 'Seed']);
  await git(seed, ['config', 'user.email', 'seed@example.invalid']);
  await fs.writeFile(path.join(seed, 'README.md'), 'field exports\n');
  await git(seed, ['add', 'README.md']);
  await git(seed, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  await git(seed, ['remote', 'add', 'origin', bareDir]);
  await git(seed, ['push', '-u', 'origin', 'main']);
  await fs.rm(seed, { recursive: true, force: true });
}

async function openWorkDir(remote, workDir, user = { name: 'Field Tester', email: 'field@test.example' }) {
  await fs.mkdir(path.dirname(workDir), { recursive: true });
  try {
    await fs.access(path.join(workDir, '.git'));
  } catch {
    await git(path.dirname(workDir), ['clone', remote, path.basename(workDir)]);
  }
  await git(workDir, ['config', 'user.name', user.name]);
  await git(workDir, ['config', 'user.email', user.email]);
}

function exportObject({ machine, project, extra = {} }) {
  return {
    version: 1,
    machine,
    project,
    generatedAt: '2026-01-01T00:00:00.000Z',
    tickets: [],
    jobs: [],
    ...extra,
  };
}

async function writeExport(dir, name, body) {
  const file = path.join(dir, `${name}.json`);
  await fs.writeFile(file, `${JSON.stringify(body)}\n`);
  return file;
}

test('DEFAULT_FIELD_REMOTE is the swarm-field repo', () => {
  assert.equal(DEFAULT_FIELD_REMOTE, 'RDW-Labz/swarm-field');
});

test('push from two machines then pull returns both exports', async t => {
  const root = await tmpDir(t, 'field-collect-push-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);

  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  const alphaFile = await writeExport(exportsDir, 'alpha', exportObject({ machine: 'alpha', project: 'proj-a' }));
  const betaFile = await writeExport(exportsDir, 'beta', exportObject({ machine: 'beta', project: 'proj-b' }));

  const alphaCache = path.join(root, 'cache-alpha');
  const betaCache = path.join(root, 'cache-beta');
  await openWorkDir(bare, alphaCache, { name: 'Alpha User', email: 'alpha@example.invalid' });
  await openWorkDir(bare, betaCache, { name: 'Beta User', email: 'beta@example.invalid' });

  const first = await pushFieldExports({
    files: [{ name: 'alpha', path: alphaFile }],
    remote: bare,
    machine: 'alpha',
    workDir: alphaCache,
    git,
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(first.pushed, ['alpha']);
  assert.equal(first.skipped.length, 0);
  assert.match(first.commit, /^[0-9a-f]{40}$/);

  const second = await pushFieldExports({
    files: [{ name: 'beta', path: betaFile }],
    remote: bare,
    machine: 'beta',
    workDir: betaCache,
    git,
    now: () => 1_700_000_100_000,
  });
  assert.deepEqual(second.pushed, ['beta']);

  const pullCache = path.join(root, 'cache-pull');
  const pulled = await pullFieldExports({ remote: bare, workDir: pullCache, git });
  assert.equal(pulled.exports.length, 2);
  const projects = pulled.exports.map(item => item.project).sort();
  assert.deepEqual(projects, ['proj-a', 'proj-b']);
  assert.equal(pulled.skipped.length, 0);
});

test('invalid and oversized export files are skipped with reasons', async t => {
  const root = await tmpDir(t, 'field-collect-skip-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });

  const badFile = path.join(exportsDir, 'bad.json');
  await fs.writeFile(badFile, '{"version":2,"machine":"m","project":"p"}\n');

  const bigFile = path.join(exportsDir, 'big.json');
  const bigBody = exportObject({ machine: 'm', project: 'big' });
  const padding = 'x'.repeat(2 * 1024 * 1024);
  await fs.writeFile(bigFile, `${JSON.stringify({ ...bigBody, note: padding })}\n`);

  const goodFile = await writeExport(exportsDir, 'good', exportObject({ machine: 'm', project: 'good' }));

  const cache = path.join(root, 'cache');
  await openWorkDir(bare, cache);
  const result = await pushFieldExports({
    files: [
      { name: 'bad', path: badFile },
      { name: 'big', path: bigFile },
      { name: 'good', path: goodFile },
    ],
    remote: bare,
    machine: 'm',
    workDir: cache,
    git,
  });
  assert.deepEqual(result.pushed, ['good']);
  assert.deepEqual(
    result.skipped.map(item => ({ name: item.name, reason: item.reason })),
    [{ name: 'bad', reason: 'invalid-export' }, { name: 'big', reason: 'oversized' }],
  );
});

test('unchanged export does not create a new commit', async t => {
  const root = await tmpDir(t, 'field-collect-unchanged-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  const file = await writeExport(exportsDir, 'same', exportObject({ machine: 'm1', project: 'same' }));
  const cache = path.join(root, 'cache');
  await openWorkDir(bare, cache);

  const first = await pushFieldExports({
    files: [{ name: 'same', path: file }],
    remote: bare,
    machine: 'm1',
    workDir: cache,
    git,
  });
  const second = await pushFieldExports({
    files: [{ name: 'same', path: file }],
    remote: bare,
    machine: 'm1',
    workDir: cache,
    git,
  });
  assert.equal(second.commit, first.commit);
  const log = String(await git(cache, ['rev-list', '--count', 'HEAD'])).trim();
  assert.equal(log, '2');
});

test('non-fast-forward push is retried once after rebase', async t => {
  const root = await tmpDir(t, 'field-collect-race-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });

  const fileA = await writeExport(exportsDir, 'a', exportObject({ machine: 'race-a', project: 'race' }));
  const fileB = await writeExport(exportsDir, 'b', exportObject({ machine: 'race-b', project: 'race' }));

  const cacheA = path.join(root, 'cache-a');
  const cacheB = path.join(root, 'cache-b');
  await openWorkDir(bare, cacheA);
  await openWorkDir(bare, cacheB);

  await pushFieldExports({ files: [{ name: 'a', path: fileA }], remote: bare, machine: 'race-a', workDir: cacheA, git });

  let pushAttempts = 0;
  const racingGit = async (cwd, args) => {
    if (args[0] === 'push') {
      pushAttempts += 1;
      if (pushAttempts === 1) throw new Error('! [rejected] main -> main (non-fast-forward)');
    }
    return git(cwd, args);
  };

  const result = await pushFieldExports({
    files: [{ name: 'b', path: fileB }],
    remote: bare,
    machine: 'race-b',
    workDir: cacheB,
    git: racingGit,
  });
  assert.equal(pushAttempts, 2);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  const pulled = await pullFieldExports({ remote: bare, workDir: path.join(root, 'cache-pull'), git });
  assert.equal(pulled.exports.length, 2);
});

test('commit author is the configured git user', async t => {
  const root = await tmpDir(t, 'field-collect-author-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  const file = await writeExport(exportsDir, 'auth', exportObject({ machine: 'auth-m', project: 'auth-p' }));
  const cache = path.join(root, 'cache');
  const author = { name: 'Configured Author', email: 'configured@users.noreply.github.com' };
  await openWorkDir(bare, cache, author);

  await pushFieldExports({
    files: [{ name: 'auth', path: file }],
    remote: bare,
    machine: 'auth-m',
    workDir: cache,
    git,
    now: () => 1_800_000_000_000,
  });

  const show = String(await git(cache, ['log', '-1', '--format=%an|%ae'])).trim();
  assert.equal(show, `${author.name}|${author.email}`);
});

test('dry run lists pushes without changing the remote', async t => {
  const root = await tmpDir(t, 'field-collect-dry-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  const file = await writeExport(exportsDir, 'dry', exportObject({ machine: 'dry-m', project: 'dry-p' }));
  const cache = path.join(root, 'cache');
  await openWorkDir(bare, cache);

  const before = String(await execFileAsync('git', ['-C', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
  const result = await pushFieldExports({
    files: [{ name: 'dry', path: file }],
    remote: bare,
    machine: 'dry-m',
    workDir: cache,
    git,
    dryRun: true,
  });
  assert.deepEqual(result.pushed, ['dry']);
  assert.equal(result.commit, null);
  assert.equal(result.dryRun, true);
  const after = String(await execFileAsync('git', ['-C', bare, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
  assert.equal(after, before);
  await assert.rejects(fs.access(path.join(cache, 'machines', 'dry-m', 'dry-p.json')));
});

test('symlink export is refused', async t => {
  const root = await tmpDir(t, 'field-collect-symlink-');
  const bare = path.join(root, 'remote.git');
  await seedBareRemote(bare);
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  const real = await writeExport(exportsDir, 'real', exportObject({ machine: 'sym', project: 'real' }));
  const link = path.join(exportsDir, 'link.json');
  await fs.symlink(real, link);
  const cache = path.join(root, 'cache');
  await openWorkDir(bare, cache);
  const result = await pushFieldExports({
    files: [{ name: 'link', path: link }],
    remote: bare,
    machine: 'sym',
    workDir: cache,
    git,
  });
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.skipped, [{ name: 'link', reason: 'symlink' }]);
});
