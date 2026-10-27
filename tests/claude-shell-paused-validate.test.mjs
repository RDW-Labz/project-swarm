// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, validateProject } from '../tools/swarm.mjs';
import { claudeShellPausedProblem } from '../tools/claude-shell.mjs';
import { git } from '../tools/codex-adapter.mjs';

const TIMEOUT = { timeout: 60000 };
const manifest = jobs => ({ version: 1, jobs });
const shellJob = (overrides = {}) => ({
  id: 'builder',
  agent: 'claude',
  model: 'sonnet',
  shell: true,
  prompt: 'Update the output.',
  context: ['input.txt'],
  outputs: ['output.txt'],
  ...overrides,
});
const plainJob = (overrides = {}) => ({
  id: 'writer',
  agent: 'claude',
  model: 'sonnet',
  prompt: 'Update the output.',
  context: ['input.txt'],
  outputs: ['output.txt'],
  ...overrides,
});

function mergeIsolatedConfig(patch) {
  const file = process.env.SWARM_CONFIG;
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* empty */ }
  fs.writeFileSync(file, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

const testEnv = () => ({ SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME });

async function repo(t) {
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'swarm-shell-pause-validate-')));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fsPromises.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fsPromises.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fsPromises.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

test('validateProject refuses a shell job while the anthropic lane is paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  const root = await repo(t);
  const problem = claudeShellPausedProblem({ lanes: { anthropic: { paused: true } } });
  await assert.rejects(
    validateProject(root, manifest([shellJob()]), { env: testEnv() }),
    error => error.message === problem && error.code === 'claude-shell-paused',
  );
});

test('validateProject refuses a shell job while lanes.claude.shellPaused is true', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { claude: { shellPaused: true } } });
  const root = await repo(t);
  const problem = claudeShellPausedProblem({ lanes: { claude: { shellPaused: true } } });
  await assert.rejects(
    validateProject(root, manifest([shellJob()]), { env: testEnv() }),
    error => error.message === problem && error.code === 'claude-shell-paused',
  );
});

test('validateProject passes a shell job when the anthropic lane is not paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: false }, claude: { shellPaused: false } } });
  const root = await repo(t);
  const result = await validateProject(root, manifest([shellJob()]), { env: testEnv() });
  assert.equal(result.status, 'valid');
});

test('validateProject passes a plain claude job while the anthropic lane is paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  const root = await repo(t);
  const result = await validateProject(root, manifest([plainJob()]), { env: testEnv() });
  assert.equal(result.status, 'valid');
});

test('validateManifest on a saved-style shell manifest does not refuse while paused', TIMEOUT, () => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  const saved = shellJob({ preset: 'sonnet-shell', tier: 'cheap' });
  assert.doesNotThrow(() => validateManifest(manifest([saved]), { env: testEnv() }));
});
