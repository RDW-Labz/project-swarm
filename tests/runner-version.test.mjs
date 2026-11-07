// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrateVersionPackageJson, repairRunnerPackageJson, runnerVersionAtRoot } from '../tools/runner-version.mjs';
import { listPinReport } from '../tools/pins.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tmp(t, prefix = 'swarm-runner-ver-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return fs.realpath(d);
}

async function copyTools(targetDir) {
  await fs.cp(path.join(repoRoot, 'tools'), path.join(targetDir, 'tools'), { recursive: true });
}

async function runSwarmVersion(swarmPath) {
  const { stdout } = await execFileAsync(process.execPath, [swarmPath, 'version'], {
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

async function versionDir(install, semver, hash = 'abc1234') {
  const dir = path.join(install, 'versions', `${semver}-${hash}`);
  await fs.mkdir(dir, { recursive: true });
  await copyTools(dir);
  return dir;
}

test('pinned version folder reports its own package.json version', async t => {
  const install = await tmp(t);
  const currentDir = await versionDir(install, '1.163.0', 'cccccccc');
  await fs.writeFile(path.join(currentDir, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.163.0' }, null, 2)}\n`);
  const pinnedDir = await versionDir(install, '1.47.0', 'abc1234');
  await fs.writeFile(path.join(pinnedDir, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.47.0' }, null, 2)}\n`);
  await fs.writeFile(path.join(install, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.163.0' }, null, 2)}\n`);
  await fs.symlink(currentDir, path.join(install, 'current'));
  const result = await runSwarmVersion(path.join(pinnedDir, 'tools/swarm.mjs'));
  assert.equal(result.version, '1.47.0');
});

test('symlinked package.json is repaired and reports folder version', async t => {
  const install = await tmp(t);
  await fs.writeFile(path.join(install, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.163.0' }, null, 2)}\n`);
  const pinnedDir = await versionDir(install, '1.47.0', 'abc1234');
  await fs.symlink(path.join(install, 'package.json'), path.join(pinnedDir, 'package.json'));
  await migrateVersionPackageJson(install);
  const stat = await fs.lstat(path.join(pinnedDir, 'package.json'));
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(await runnerVersionAtRoot(pinnedDir), '1.47.0');
});

test('regular package.json in a version folder is never overwritten', async t => {
  const install = await tmp(t);
  const pinnedDir = await versionDir(install, '1.47.0', 'abc1234');
  const custom = `${JSON.stringify({ name: 'project-swarm', version: '1.47.0', note: 'keep-me' }, null, 2)}\n`;
  await fs.writeFile(path.join(pinnedDir, 'package.json'), custom);
  await repairRunnerPackageJson(pinnedDir);
  await migrateVersionPackageJson(install);
  assert.equal(await fs.readFile(path.join(pinnedDir, 'package.json'), 'utf8'), custom);
});

test('version folder without package.json uses the folder name', async t => {
  const install = await tmp(t);
  const pinnedDir = await versionDir(install, '1.47.0', 'abc1234');
  await fs.rm(path.join(pinnedDir, 'package.json'), { force: true }).catch(() => {});
  assert.equal(await runnerVersionAtRoot(pinnedDir), '1.47.0');
});

test('current runner reports the current snapshot version', async t => {
  const install = await tmp(t);
  const currentDir = await versionDir(install, '1.163.0', 'dddddddd');
  await fs.writeFile(path.join(currentDir, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.163.0' }, null, 2)}\n`);
  await fs.writeFile(path.join(install, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '9.9.9' }, null, 2)}\n`);
  await fs.symlink(currentDir, path.join(install, 'current'));
  const result = await runSwarmVersion(path.join(install, 'current/tools/swarm.mjs'));
  assert.equal(result.version, '1.163.0');
});

test('pin listing shows runner version from the pinned release folder', async t => {
  const install = await tmp(t);
  const pinnedDir = await versionDir(install, '1.47.0', 'abc1234');
  await fs.writeFile(path.join(pinnedDir, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.47.0' }, null, 2)}\n`);
  await fs.writeFile(path.join(install, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version: '1.163.0' }, null, 2)}\n`);
  const project = await tmp(t);
  await fs.writeFile(path.join(project, '.project-swarm.json'), JSON.stringify({
    install,
    version: '1.163.0',
    pinnedVersion: '1.47.0',
  }));
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([project]));
  const report = await listPinReport(install);
  assert.equal(report.pins.length, 1);
  assert.equal(report.pins[0].runnerVersion, '1.47.0');
});
