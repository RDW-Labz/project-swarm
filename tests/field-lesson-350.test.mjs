// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { shipBranch } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lesson-350-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout;
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await write('old wheel.bin', Buffer.from([0, 255, 1, 2]));
  await write('delete.txt', 'remove');
  await write('modify.txt', 'before');
  await write('docs/_swarm/brief.md', 'before');
  await git('add', '.');
  await git('commit', '-qm', 'base');
  const cli = (...args) => exec(process.execPath, [runner, '--root', root, ...args], { cwd: root });
  const localExec = async (command, args, options) => {
    assert.equal(command, 'git', 'no remote calls before branch guard');
    try { return { code: 0, ...await exec(command, args, options) }; }
    catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  };
  return { root, git, write, cli, localExec };
}

test('L350 ship refuses a branch with zero commits over base before checks', async t => {
  const f = await fixture(t);
  await f.git('switch', '-qc', 'release');
  await f.write('payload.json', JSON.stringify({ title: 'Release', head: 'release', base: 'main', body: '## Checks\nPending.' }));
  let checks = 0;
  const result = await shipBranch(f.root, { branch: 'release', payloadPath: path.join(f.root, 'payload.json'), repo: 'example/repo', checks: [{ name: 'must not run', argv: ['missing-command'] }] }, {
    exec: f.localExec, spawnImpl: () => { checks++; throw Error('checks ran'); },
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'branch-not-ahead');
  assert.equal(checks, 0);
});

test('L350 clean-branch stages adds, modifications, binary renames and deletes with exclusions', async t => {
  const f = await fixture(t);
  await f.git('switch', '-qc', 'wip');
  await f.git('mv', 'old wheel.bin', 'new wheel.bin');
  await f.git('rm', 'delete.txt');
  await f.write('modify.txt', 'after');
  await f.write('new\nfile.txt', 'added');
  await f.write('docs/_swarm/brief.md', 'excluded');
  await f.git('add', '.');
  await f.git('commit', '-qm', 'work');
  await f.git('switch', '-qc', 'release', 'main');
  const before = await f.git('rev-parse', 'HEAD');
  const { stdout } = await f.cli('clean-branch', '--from', 'wip', '--exclude', 'docs/_swarm');
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'staged');
  assert.equal(await f.git('rev-parse', 'HEAD'), before, 'helper never commits');
  assert.equal(await fs.readFile(path.join(f.root, 'modify.txt'), 'utf8'), 'after');
  assert.equal(await fs.readFile(path.join(f.root, 'new\nfile.txt'), 'utf8'), 'added');
  assert.deepEqual(await fs.readFile(path.join(f.root, 'new wheel.bin')), Buffer.from([0, 255, 1, 2]));
  await assert.rejects(fs.access(path.join(f.root, 'old wheel.bin')));
  await assert.rejects(fs.access(path.join(f.root, 'delete.txt')));
  assert.equal(await fs.readFile(path.join(f.root, 'docs/_swarm/brief.md'), 'utf8'), 'before');
  const staged = await f.git('diff', '--cached', '--name-status', '-M');
  assert.match(staged, /R100\told wheel.bin\tnew wheel.bin/);
  assert.match(staged, /D\tdelete.txt/);
  assert.ok(!staged.includes('docs/_swarm'));
  assert.equal(await f.git('diff', '--name-only'), '');
});

test('L350 clean-branch refuses dirty destinations without touching their edits', async t => {
  const f = await fixture(t);
  await f.write('modify.txt', 'local work');
  await assert.rejects(f.cli('clean-branch', '--from', 'main'), /clean-branch-dirty/);
  assert.equal(await fs.readFile(path.join(f.root, 'modify.txt'), 'utf8'), 'local work');
});
