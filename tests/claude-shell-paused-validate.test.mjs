// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../tools/swarm.mjs';
import { claudeShellPausedProblem } from '../tools/claude-shell.mjs';

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

test('validateManifest refuses a shell job while the anthropic lane is paused', TIMEOUT, () => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  const problem = claudeShellPausedProblem({ lanes: { anthropic: { paused: true } } });
  assert.throws(
    () => validateManifest(manifest([shellJob()]), { env: testEnv() }),
    error => error.message === problem && error.code === 'claude-shell-paused',
  );
});

test('validateManifest passes a shell job when the anthropic lane is not paused', TIMEOUT, () => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: false }, claude: { shellPaused: false } } });
  assert.doesNotThrow(() => validateManifest(manifest([shellJob()]), { env: testEnv() }));
});

test('validateManifest passes a plain claude job while the anthropic lane is paused', TIMEOUT, () => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  assert.doesNotThrow(() => validateManifest(manifest([plainJob()]), { env: testEnv() }));
});
