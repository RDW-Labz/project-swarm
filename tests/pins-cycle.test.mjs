// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', '.swarm', 'tests', 'coordination', 'versions', 'current', 'node_modules', '_to_delete', 'evals', '.claude', 'bench', '.swarm-install.json']);

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

const git = (cwd, ...args) => {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 60000,
      env: GIT_ENV,
    },
  );
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r;
};

const rmTempDir = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test('pins.mjs has no static import of install.mjs', async () => {
  const text = await fs.readFile(path.join(SOURCE, 'tools', 'pins.mjs'), 'utf8');
  assert.doesNotMatch(text, /^\s*import\s+.*\s+from\s+['"]\.\/install\.mjs['"]/m);
});

test('node tools/install.mjs --user completes without install/pins circular import', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pins-cycle-install-')));
  t.after(async () => {
    await rmTempDir(base);
  });
  const home = path.join(base, 'home');
  const install = path.join(base, 'install');
  await fs.mkdir(home);
  await fs.cp(SOURCE, install, {
    recursive: true,
    filter: src => {
      const rel = path.relative(SOURCE, src);
      const top = rel.split(path.sep)[0];
      return !(SKIP.has(top) || top.startsWith('.tmp-') || rel.startsWith(path.join('docs', 'design')));
    },
  });
  const version = JSON.parse(await fs.readFile(path.join(install, 'package.json'), 'utf8')).version;
  git(install, 'init', '-q');
  git(install, 'add', '-A');
  git(install, 'commit', '-qm', 'install');
  git(install, 'tag', `v${version}`);
  const run = spawnSync(process.execPath, [path.join(install, 'tools', 'install.mjs'), '--user'], {
    cwd: install,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(run.error, undefined, run.error?.message ?? 'install subprocess failed to start');
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, out);
  assert.doesNotMatch(out, /unsettled top-level await/i);
});
