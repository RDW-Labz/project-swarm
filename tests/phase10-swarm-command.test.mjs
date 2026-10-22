// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installUser } from '../tools/install.mjs';
import { autoInit } from '../tools/goal.mjs';
import { WRAPPER_MARKER } from '../tools/swarm-bin.mjs';

const exec = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarm = path.join(packageRoot, 'tools/swarm.mjs');

async function temp(t, prefix = 'swarm-p10-') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function project(t) {
  const root = await temp(t);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
  await exec('git', ['-C', root, 'add', 'a.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init']);
  return root;
}
const run = (args, home, extra = {}) => exec(process.execPath, [swarm, ...args], { env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG, ...extra } });
const fail = async (args, home) => run(args, home).then(() => assert.fail('expected a failure'), error => error);

async function minimalSource(t) {
  const dir = await temp(t);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  await fs.mkdir(path.join(dir, 'tools'), { recursive: true });
  await fs.writeFile(path.join(dir, 'tools/swarm.mjs'), 'export const marker=1;\n');
  await fs.mkdir(path.join(dir, 'skills/project-swarm'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills/project-swarm/SKILL.md'), '---\nname: project-swarm\ndescription: x\n---\nRunner: {{SWARM_RUNNER}}\n');
  await fs.writeFile(path.join(dir, 'SECURITY.md'), 'sec\n');
  await fs.writeFile(path.join(dir, 'CONTRIBUTING.md'), 'contrib\n');
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

test('install writes the swarm command and the zsh completion, and never overwrites a foreign file', async t => {
  const source = await minimalSource(t), home = await temp(t);
  const first = await installUser({ source, home });
  assert.equal(first.swarmCommand.status, 'installed');
  const wrapper = await fs.readFile(path.join(home, '.local/bin/swarm'), 'utf8');
  assert.ok(wrapper.includes(WRAPPER_MARKER));
  assert.ok(wrapper.includes(path.join(source, 'current/tools/swarm.mjs')));
  assert.equal((await fs.stat(path.join(home, '.local/bin/swarm'))).mode & 0o111, 0o111);
  assert.match(await fs.readFile(path.join(home, '.project-swarm/completions/_swarm'), 'utf8'), /^#compdef swarm/);
  assert.equal((await installUser({ source, home })).swarmCommand.status, 'unchanged');
  await fs.writeFile(path.join(home, '.local/bin/swarm'), '#!/bin/sh\necho mine\n');
  const foreign = await installUser({ source, home });
  assert.equal(foreign.status, 'installed');
  assert.equal(foreign.swarmCommand.status, 'refused');
  assert.equal(await fs.readFile(path.join(home, '.local/bin/swarm'), 'utf8'), '#!/bin/sh\necho mine\n');
});

test('the installed command runs in a non-interactive shell with no node on PATH', async t => {
  const source = await minimalSource(t), home = await temp(t);
  await fs.writeFile(path.join(source, 'tools/swarm.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  await installUser({ source, home });
  const result = await exec('/bin/bash', ['-c', 'swarm doctor all'], { env: { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin` } });
  assert.deepEqual(JSON.parse(result.stdout), ['doctor', 'all']);
});

test('autoInit runs init once on a clean project, skips an initialized or dirty one, and lists the files it changed', async () => {
  const calls = [];
  const deps = (over = {}) => ({ exists: async () => false, dirty: async () => false, init: async () => { calls.push('init'); return { status: 'initialized' }; }, changed: async () => ['.project-swarm.json', '.gitignore'], ...over });
  const ran = await autoInit('/p', deps());
  assert.deepEqual([ran.ran, ran.files, calls], [true, ['.project-swarm.json', '.gitignore'], ['init']]);
  assert.equal((await autoInit('/p', deps({ exists: async () => true }))).ran, false);
  const dirty = await autoInit('/p', deps({ dirty: async () => true }));
  assert.deepEqual([dirty.ran, dirty.skipped, calls.length], [false, 'goal-dirty', 1]);
});

test('swarm with no arguments prints a short status and five next commands', async t => {
  const root = await project(t), home = await temp(t);
  const { stdout } = await run(['--root', root], home);
  assert.match(stdout, /^autopilot: (on|off)\nProject Swarm status for /);
  assert.match(stdout, /Initialized: no; run: swarm init/);
  assert.match(stdout, /Next:\n {2}swarm init\n/);
  assert.equal(stdout.split('Next:\n')[1].trim().split('\n').length, 5);
  const json = JSON.parse((await run(['--root', root, '--json'], home)).stdout);
  assert.equal(json.initialized, false);
  assert.equal(json.next.length, 5);
  // owner decision 2026-10-22: autopilot default-on status fields
  assert.deepEqual(Object.keys(json).sort(), ['autopilot', 'idleWithReady', 'initialized', 'lanes', 'lastRun', 'next', 'readyTickets', 'root', 'spendToday']);
  assert.ok(json.autopilot === 'on' || json.autopilot === 'off');
  assert.equal(json.idleWithReady, false);
  assert.equal(json.readyTickets, 0);
});

test('completion zsh prints the script and __complete runs lists run ids newest first', async t => {
  const root = await project(t), home = await temp(t);
  assert.match((await run(['completion', 'zsh'], home)).stdout, /^#compdef swarm/);
  await fs.mkdir(path.join(root, '.swarm/runs/100-aaaa'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm/runs/200-bbbb'), { recursive: true });
  assert.equal((await run(['--root', root, '__complete', 'runs'], home)).stdout, '200-bbbb\n100-aaaa\n');
  assert.ok((await fail(['completion', 'fish'], home)).code === 1);
});

test('a quoted goal is shorthand for swarm go; a mistyped one-word command is not', async t => {
  const root = await project(t), home = await temp(t);
  await fs.writeFile(path.join(root, 'dirty.txt'), 'uncommitted\n');
  const { stdout } = await run(['--root', root, 'add a small thing to the project'], home).catch(error => error);
  const result = JSON.parse(stdout);
  assert.equal(result.stage, 'plan');
  assert.match(result.reason, /goal-dirty/);
  const typo = await fail(['--root', root, 'statsu'], home);
  assert.notEqual(typo.code, 0);
});

test('doctor all reports the swarm command and its PATH warning', async t => {
  const home = await temp(t);
  const result = JSON.parse((await run(['doctor', 'all'], home, { PATH: '/usr/bin:/bin' })).stdout);
  assert.equal(result.swarmCommand.installed, false);
  assert.ok(result.warnings.some(warning => warning.startsWith('swarm-command-missing')));
  assert.ok(result.warnings.some(warning => warning.startsWith('swarm-not-on-path')));
});
