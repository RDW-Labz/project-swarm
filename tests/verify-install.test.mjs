// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { snapshotVersion } from '../tools/install.mjs';
import { verifyInstall, formatVerifyInstall, runVerifyInstallCommand } from '../tools/verify-install.mjs';

const execFileAsync = promisify(execFile);

async function tmp(t, prefix = 'swarm-verify-install-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return fs.realpath(d);
}

async function minimalFakeSource(t, { git = false, version = '1.0.0' } = {}) {
  const source = await tmp(t, 'swarm-verify-src-');
  await fs.mkdir(path.join(source, 'tools'), { recursive: true });
  await fs.writeFile(path.join(source, 'tools/router.mjs'), 'export const x = 1;\n');
  await fs.mkdir(path.join(source, 'skills/project-swarm'), { recursive: true });
  await fs.writeFile(path.join(source, 'skills/project-swarm/SKILL.md'), '---\nname: x\n---\n{{SWARM_RUNNER}}\n');
  await fs.writeFile(path.join(source, 'SECURITY.md'), 'security\n');
  await fs.writeFile(path.join(source, 'CONTRIBUTING.md'), 'contrib\n');
  await fs.mkdir(path.join(source, 'docs'));
  await fs.writeFile(path.join(source, 'docs/guide.md'), 'guide\n');
  await fs.writeFile(path.join(source, 'package.json'), `${JSON.stringify({ name: 'project-swarm', version })}\n`);
  if (git) {
    await execFileAsync('git', ['init'], { cwd: source });
    await execFileAsync('git', ['checkout', '-b', 'main'], { cwd: source });
    await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: source });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: source });
    await execFileAsync('git', ['add', '-A'], { cwd: source });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: source });
  }
  return source;
}

function hashBytes(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

test('snapshotVersion writes manifest with installed file hashes', async (t) => {
  const source = await minimalFakeSource(t, { git: true });
  const { stdout: commit } = await execFileAsync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const versionDir = await snapshotVersion(source, '1.0.0');
  const manifest = JSON.parse(await fs.readFile(path.join(versionDir, '.swarm-install.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.source.commit, commit.trim());
  assert.equal(manifest.source.dirty, false);
  assert.ok(manifest.createdAt);
  const router = await fs.readFile(path.join(versionDir, 'tools/router.mjs'));
  assert.equal(manifest.files['tools/router.mjs'], hashBytes(router));
  assert.equal(manifest.files['package.json'], hashBytes(await fs.readFile(path.join(versionDir, 'package.json'))));
  assert.ok(manifest.files['skills/project-swarm/SKILL.md']);
});

test('snapshotVersion records null commit for non-git source', async (t) => {
  const source = await minimalFakeSource(t, { git: false });
  const versionDir = await snapshotVersion(source, '1.0.0');
  const manifest = JSON.parse(await fs.readFile(path.join(versionDir, '.swarm-install.json'), 'utf8'));
  assert.equal(manifest.source.commit, null);
  assert.equal(manifest.source.dirty, null);
});

test('verifyInstall ok immediately after snapshotVersion', async (t) => {
  const source = await minimalFakeSource(t);
  const versionDir = await snapshotVersion(source, '1.0.0');
  await fs.symlink(versionDir, path.join(source, 'current'));
  const result = await verifyInstall({ installRoot: source });
  assert.equal(result.ok, true);
  assert.equal(result.manifest, true);
  assert.equal(result.problems.length, 0);
  assert.equal(result.versionDir, versionDir);
});

test('verifyInstall reports changed when a tools file is edited', async (t) => {
  const source = await minimalFakeSource(t);
  const versionDir = await snapshotVersion(source, '1.0.0');
  await fs.appendFile(path.join(versionDir, 'tools/router.mjs'), '// edited\n');
  const result = await verifyInstall({ installRoot: source, versionDir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ kind: 'changed', path: 'tools/router.mjs' }]);
});

test('verifyInstall reports missing when a manifest file is deleted', async (t) => {
  const source = await minimalFakeSource(t);
  const versionDir = await snapshotVersion(source, '1.0.0');
  await fs.unlink(path.join(versionDir, 'tools/router.mjs'));
  const result = await verifyInstall({ installRoot: source, versionDir });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.kind === 'missing' && p.path === 'tools/router.mjs'));
});

test('verifyInstall reports extra files not in the manifest', async (t) => {
  const source = await minimalFakeSource(t);
  const versionDir = await snapshotVersion(source, '1.0.0');
  await fs.writeFile(path.join(versionDir, 'tools/extra.mjs'), 'extra\n');
  const result = await verifyInstall({ installRoot: source, versionDir });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ kind: 'extra', path: 'tools/extra.mjs' }]);
});

test('verifyInstall reports no-manifest for legacy version dirs', async (t) => {
  const install = await tmp(t);
  const versionDir = path.join(install, 'versions', '1.0.0-deadbeef');
  await fs.mkdir(path.join(versionDir, 'tools'), { recursive: true });
  await fs.writeFile(path.join(versionDir, 'tools/swarm.mjs'), 'x\n');
  const result = await verifyInstall({ installRoot: install, versionDir });
  assert.equal(result.ok, false);
  assert.equal(result.manifest, false);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].kind, 'no-manifest');
});

test('formatVerifyInstall formats ok and problem output', async (t) => {
  const source = await minimalFakeSource(t, { git: true });
  const versionDir = await snapshotVersion(source, '1.0.0');
  const ok = await verifyInstall({ installRoot: source, versionDir });
  const okLines = formatVerifyInstall(ok);
  assert.match(okLines[0], /^install ok: .+ \(from [0-9a-f]+\)$/);
  await fs.appendFile(path.join(versionDir, 'tools/router.mjs'), '!\n');
  const bad = await verifyInstall({ installRoot: source, versionDir });
  const badLines = formatVerifyInstall(bad);
  assert.match(badLines[0], /^WARNING: installed swarm files do not match/);
  assert.ok(badLines.some((line) => line === '  changed tools/router.mjs'));
});

test('runVerifyInstallCommand exits 1 on problems and supports --json', async (t) => {
  const source = await minimalFakeSource(t);
  const versionDir = await snapshotVersion(source, '1.0.0');
  await fs.symlink(versionDir, path.join(source, 'current'));
  const okCli = await runVerifyInstallCommand([], { installRoot: source });
  assert.equal(okCli.exitCode, 0);
  assert.match(okCli.stdout, /^install ok:/);
  await fs.appendFile(path.join(versionDir, 'tools/router.mjs'), '// bad\n');
  const textCli = await runVerifyInstallCommand([], { installRoot: source });
  assert.equal(textCli.exitCode, 1);
  assert.match(textCli.stdout, /^WARNING:/);
  const jsonCli = await runVerifyInstallCommand(['--json'], { installRoot: source });
  assert.equal(jsonCli.exitCode, 1);
  const parsed = JSON.parse(jsonCli.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.ok(parsed.problems.some((p) => p.kind === 'changed'));
  const rootCli = await runVerifyInstallCommand(['--json', '--root', source], { installRoot: '/ignored' });
  assert.equal(rootCli.exitCode, 1);
});
