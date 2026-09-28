// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ship } from '../tools/ship.mjs';

const execFileAsync = promisify(execFile);
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = stderr => ({ code: 1, stdout: '', stderr });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lock183-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lock-fixture', version: '1.0.0', private: true }));
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Fixture', head: 'feature', base: 'main', body: 'Checked.' }));
  return { root, payloadPath };
}

async function runShip(fixture, npmResult = async () => ok()) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    if (file === 'npm') return npmResult(file, args, opts);
    if (file === 'git' && args[0] === 'remote') return ok('https://github.com/example/fixture.git');
    if (file === 'git' && args[0] === 'status') return ok();
    if (file === 'git' && args[0] === 'rev-parse') return ok('fixture-sha');
    // Stop at a fake push: no real git or network side effect is possible.
    if (file === 'git' && args[0] === 'push') return fail('fixture push stop');
    throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
  };
  const result = await ship({ ...fixture, exec, runChecks: async () => [],
    integratedFiles: ['package.json'], merge: false, sleep: async () => {} });
  return { result, calls };
}

test('L183: missing lockfile names the manifest and explicitly says the lock check did not run', async t => {
  const f = await fixture(t);
  const { result, calls } = await runShip(f);
  assert.ok(result.warnings.includes(`no-lockfile: ${path.join(f.root, 'package.json')} has no package-lock.json`),
    'missing-lock warning must name the package.json path');
  assert.ok(result.warnings.includes('npm-lock-check did not run: package-lock.json is missing'));
  assert.equal(calls.some(call => call.file === 'npm'), false, 'npm ci must not run without a lockfile');
  assert.ok(calls.some(call => call.file === 'git' && call.args[0] === 'push'), 'warning must allow shipping to continue');
});

test('L183: a present lockfile runs npm ci --dry-run in the project root', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package-lock.json'), '{}');
  const { result, calls } = await runShip(f);
  assert.deepEqual(calls.filter(call => call.file === 'npm'), [{ file: 'npm', args: ['ci', '--dry-run'], cwd: f.root }]);
  assert.deepEqual(result.warnings, []);
  assert.ok(calls.some(call => call.file === 'git' && call.args[0] === 'push'));
});

test('L183: a stale lockfile still refuses before push', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'package-lock.json'), '{}');
  const { result, calls } = await runShip(f, async () => fail('package.json and package-lock.json are not in sync'));
  assert.equal(result.status, 'refused');
  assert.match(result.reason, /^npm-lock-check failed: package.json and package-lock.json are not in sync/);
  assert.equal(calls.some(call => call.file === 'git' && call.args[0] === 'push'), false);
  assert.deepEqual(result.warnings, []);
});

test('L183: real npm accepts a generated lock and refuses a local dependency missing from it', async t => {
  const f = await fixture(t);
  const userConfig = path.join(f.root, 'empty-user.npmrc');
  const globalConfig = path.join(f.root, 'empty-global.npmrc');
  await fs.writeFile(userConfig, '');
  await fs.writeFile(globalConfig, '');
  const env = { ...process.env, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(f.root, 'npm-cache'), npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_ignore_scripts: 'true' };
  await execFileAsync('npm', ['install', '--package-lock-only'], { cwd: f.root, env, timeout: 30000 });
  const npmFailures = [];
  const realNpm = async (file, args, opts) => {
    try { return { code: 0, ...await execFileAsync(file, args, { ...opts, env, timeout: 30000 }) }; }
    catch (error) {
      npmFailures.push(error.stderr ?? '');
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  const valid = await runShip(f, realNpm);
  assert.ok(valid.calls.some(call => call.file === 'npm'));
  assert.ok(valid.calls.some(call => call.file === 'git' && call.args[0] === 'push'), valid.result.reason);
  await fs.mkdir(path.join(f.root, 'local-extra'));
  await fs.writeFile(path.join(f.root, 'local-extra/package.json'), JSON.stringify({ name: 'local-extra', version: '1.0.0' }));
  const pkgPath = path.join(f.root, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.dependencies = { 'local-extra': 'file:./local-extra' };
  await fs.writeFile(pkgPath, JSON.stringify(pkg));
  const stale = await runShip(f, realNpm);
  assert.equal(stale.result.status, 'refused');
  assert.match(stale.result.reason, /^npm-lock-check failed:/);
  assert.equal(stale.calls.some(call => call.file === 'git' && call.args[0] === 'push'), false);
  assert.deepEqual(stale.result.warnings, []);
  assert.equal(npmFailures.length, 1);
  assert.match(npmFailures[0], /package.json and package-lock.json.*in sync/s);
  assert.match(npmFailures[0], /Missing: local-extra/);
  t.diagnostic('Real npm accepted the generated lock, then refused the missing local-extra dependency as out of sync.');
});
