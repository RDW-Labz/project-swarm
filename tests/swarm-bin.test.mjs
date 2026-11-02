// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WRAPPER_MARKER, swarmBinPath, wrapperText, installSwarmCommand, checkSwarmCommand } from '../tools/swarm-bin.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-bin-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runner = path.join(home, "runner's file.mjs");
  await fs.writeFile(runner, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  return { home, runner };
}

const codes = result => result.warnings.map(warning => warning.split(':')[0]);

test('installs an executable wrapper idempotently and updates managed content', async t => {
  const options = await fixture(t);
  const first = await installSwarmCommand(options);
  assert.equal(first.status, 'installed');
  assert.equal(first.path, swarmBinPath(options.home));
  assert.equal(first.node, process.execPath);
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o755);
  assert.equal((await fs.readFile(first.path, 'utf8')).split('\n')[1], WRAPPER_MARKER);
  assert.equal((await installSwarmCommand(options)).status, 'unchanged');
  assert.equal((await installSwarmCommand({ ...options, runner: `${options.runner}.new` })).status, 'installed');
});

test('refuses foreign files without changing bytes', async t => {
  const options = await fixture(t);
  const file = swarmBinPath(options.home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content = Buffer.from([0, 1, 255, 10]);
  await fs.writeFile(file, content);
  assert.equal((await installSwarmCommand(options)).status, 'refused');
  assert.deepEqual(await fs.readFile(file), content);
  assert.deepEqual(codes(await checkSwarmCommand({ home: options.home, env: { PATH: path.dirname(file) } })), ['swarm-command-foreign']);
});

test('refuses foreign symlinks and linked installation directories', async t => {
  const options = await fixture(t);
  const file = swarmBinPath(options.home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.symlink(options.runner, file);
  const before = await fs.readFile(options.runner);
  assert.equal((await installSwarmCommand(options)).status, 'refused');
  assert.equal(await fs.readlink(file), options.runner);
  assert.deepEqual(await fs.readFile(options.runner), before);
  const otherHome = path.join(options.home, 'other');
  await fs.mkdir(otherHome);
  await fs.symlink(path.join(options.home, '.local'), path.join(otherHome, '.local'));
  assert.equal((await installSwarmCommand({ ...options, home: otherHome })).status, 'refused');
});

test('rejects newline and NUL paths', () => {
  for (const character of ['\n', '\0']) {
    assert.throws(() => wrapperText({ node: `/node${character}bad`, runner: '/runner' }));
    assert.throws(() => wrapperText({ node: '/node', runner: `/runner${character}bad` }));
  }
});

test('checks missing commands, stale runners, PATH, and a clean install', async t => {
  const options = await fixture(t);
  const env = { PATH: '' };
  const missing = await checkSwarmCommand({ home: options.home, env });
  assert.equal(missing.installed, false);
  assert.equal(missing.runner, null);
  assert.deepEqual(codes(missing), ['swarm-command-missing', 'swarm-not-on-path']);
  await installSwarmCommand(options);
  assert.deepEqual(codes(await checkSwarmCommand({ home: options.home, env })), ['swarm-not-on-path']);
  const bin = path.dirname(swarmBinPath(options.home));
  const clean = await checkSwarmCommand({ home: options.home, env: { PATH: `:${bin}:` } });
  assert.equal(clean.installed, true);
  assert.equal(clean.ours, true);
  assert.equal(clean.runner, options.runner);
  assert.equal(clean.runnerExists, true);
  assert.equal(clean.onPath, true);
  assert.deepEqual(clean.warnings, []);
  const alias = path.join(options.home, 'bin-alias');
  await fs.symlink(bin, alias);
  assert.equal((await checkSwarmCommand({ home: options.home, env: { PATH: alias } })).onPath, true);
  await installSwarmCommand({ ...options, runner: `${options.runner}.missing` });
  const stale = await checkSwarmCommand({ home: options.home, env: { PATH: bin } });
  assert.equal(stale.runnerExists, false);
  assert.deepEqual(codes(stale), ['swarm-command-stale-runner']);
});

test('runs swarm from a non-interactive shell using the absolute node path', async t => {
  const options = await fixture(t);
  await installSwarmCommand(options);
  const result = spawnSync('/bin/bash', ['-c', 'swarm a "b c"'], {
    env: { HOME: options.home, PATH: `${options.home}/.local/bin:/usr/bin:/bin` }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['a', 'b c']);
  const empty = spawnSync(swarmBinPath(options.home), ['empty env'], { env: { HOME: options.home, PATH: '' }, encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), ['empty env']);
});

test('quotes node paths and falls back to PATH or reports missing node', async t => {
  const options = await fixture(t);
  const node = path.join(options.home, "node's executable");
  await fs.symlink(process.execPath, node);
  await installSwarmCommand({ ...options, node });
  const run = spawnSync(swarmBinPath(options.home), ['quoted'], { env: { HOME: options.home, PATH: '' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['quoted']);
  await installSwarmCommand({ ...options, node: path.join(options.home, 'missing-node') });
  const missing = spawnSync(swarmBinPath(options.home), [], { env: { HOME: options.home, PATH: '' }, encoding: 'utf8' });
  assert.equal(missing.status, 127);
  assert.equal(missing.stderr, 'swarm: node not found; reinstall project-swarm\n');
  const fallback = spawnSync(swarmBinPath(options.home), ['fallback'], {
    env: { HOME: options.home, PATH: path.dirname(process.execPath) }, encoding: 'utf8',
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(JSON.parse(fallback.stdout), ['fallback']);
});
