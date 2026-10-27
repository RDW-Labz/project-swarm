// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readAnthropicKey,
  anthropicLanePausedProblem,
  ANTHROPIC_KEY_ENV,
  ANTHROPIC_LANE_PAUSED,
} from '../tools/anthropic.mjs';
import {
  readOpenRouterKey,
  openrouterLanePausedProblem,
  OPENROUTER_KEY_ENV,
  OPENROUTER_LANE_PAUSED,
} from '../tools/openrouter.mjs';
import { routeJob } from '../tools/router.mjs';
import { validateManifest, validateProject } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const TIMEOUT = { timeout: 60000 };
const fakeKey = 'zz'.repeat(16);
const pausedAnthropic = { lanes: { anthropic: { paused: true } } };
const pausedOpenrouter = { lanes: { openrouter: { paused: true } } };

function recorder(stdout = `${fakeKey}\n`) {
  const calls = [];
  const exec = (...args) => {
    calls.push(args);
    return stdout;
  };
  return { calls, exec };
}

function mergeIsolatedConfig(patch) {
  const file = process.env.SWARM_CONFIG;
  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* empty */ }
  fs.writeFileSync(file, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

const testEnv = () => ({ SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME });
const manifest = jobs => ({ version: 1, jobs });

const anthropicJob = (overrides = {}) => ({
  id: 'api-worker',
  agent: 'anthropic',
  model: 'claude-haiku-5-5',
  prompt: 'Update the output.',
  context: ['input.txt'],
  outputs: ['output.txt'],
  sensitive: false,
  ...overrides,
});

const openrouterJob = (overrides = {}) => ({
  id: 'bookkeeping',
  agent: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash',
  prompt: 'Write metrics summary.',
  context: ['input.txt'],
  outputs: ['.swarm-manifests/metrics.md'],
  sensitive: false,
  ...overrides,
});

const plainClaudeJob = (overrides = {}) => ({
  id: 'writer',
  agent: 'claude',
  model: 'sonnet',
  prompt: 'Update the output.',
  context: ['input.txt'],
  outputs: ['output.txt'],
  ...overrides,
});

async function repo(t) {
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'swarm-paid-lane-pause-')));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fsPromises.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fsPromises.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fsPromises.mkdir(path.join(root, '.swarm-manifests'), { recursive: true });
  await fsPromises.writeFile(path.join(root, '.swarm-manifests/metrics.md'), 'metrics');
  await fsPromises.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

test('paused anthropic reader throws and never calls exec or reads the environment key', TIMEOUT, () => {
  const { calls, exec } = recorder();
  const env = { [ANTHROPIC_KEY_ENV]: fakeKey, SWARM_ANTHROPIC_NO_KEYCHAIN: '1' };
  const problem = anthropicLanePausedProblem(pausedAnthropic);
  assert.throws(
    () => readAnthropicKey(env, { platform: 'darwin', exec, config: pausedAnthropic }),
    error => error.message === problem && error.code === ANTHROPIC_LANE_PAUSED,
  );
  assert.equal(calls.length, 0);
});

test('paused openrouter reader throws and never calls exec or reads the environment key', TIMEOUT, () => {
  const { calls, exec } = recorder();
  const env = { [OPENROUTER_KEY_ENV]: fakeKey, SWARM_OPENROUTER_NO_KEYCHAIN: '1' };
  const problem = openrouterLanePausedProblem(pausedOpenrouter);
  assert.throws(
    () => readOpenRouterKey(env, { platform: 'darwin', exec, config: pausedOpenrouter }),
    error => error.message === problem && error.code === OPENROUTER_LANE_PAUSED,
  );
  assert.equal(calls.length, 0);
});

test('unpaused anthropic reader still resolves a key from the environment', TIMEOUT, () => {
  const { calls, exec } = recorder();
  const env = { [ANTHROPIC_KEY_ENV]: fakeKey, SWARM_ANTHROPIC_NO_KEYCHAIN: '1' };
  assert.equal(readAnthropicKey(env, { platform: 'darwin', exec, config: { lanes: { anthropic: { paused: false } } } }), fakeKey);
  assert.equal(calls.length, 0);
});

test('unpaused openrouter reader still resolves a key from the environment', TIMEOUT, () => {
  const { calls, exec } = recorder();
  const env = { [OPENROUTER_KEY_ENV]: fakeKey, SWARM_OPENROUTER_NO_KEYCHAIN: '1' };
  assert.equal(readOpenRouterKey(env, { platform: 'darwin', exec, config: { lanes: { openrouter: { paused: false } } } }), fakeKey);
  assert.equal(calls.length, 0);
});

test('unpaused anthropic reader still resolves a key via injected exec', TIMEOUT, () => {
  const { calls, exec } = recorder();
  assert.equal(readAnthropicKey({}, { platform: 'darwin', exec, config: { lanes: { anthropic: { paused: false } } } }), fakeKey);
  assert.equal(calls.length, 1);
});

test('unpaused openrouter reader still resolves a key via injected exec', TIMEOUT, () => {
  const { calls, exec } = recorder();
  assert.equal(readOpenRouterKey({}, { platform: 'darwin', exec, config: { lanes: { openrouter: { paused: false } } } }), fakeKey);
  assert.equal(calls.length, 1);
});

test('validateProject refuses an explicit anthropic job while paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  const root = await repo(t);
  const problem = anthropicLanePausedProblem({ lanes: { anthropic: { paused: true } } });
  await assert.rejects(
    validateProject(root, manifest([anthropicJob()]), { env: testEnv() }),
    error => error.message === problem && error.code === ANTHROPIC_LANE_PAUSED,
  );
});

test('validateProject refuses an explicit openrouter job while paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { openrouter: { paused: true } } });
  const root = await repo(t);
  const problem = openrouterLanePausedProblem({ lanes: { openrouter: { paused: true } } });
  await assert.rejects(
    validateProject(root, manifest([openrouterJob()]), { env: testEnv() }),
    error => error.message === problem && error.code === OPENROUTER_LANE_PAUSED,
  );
});

test('validateProject passes explicit paid jobs when lanes are not paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: false }, openrouter: { paused: false } } });
  const root = await repo(t);
  const result = await validateProject(root, manifest([anthropicJob(), openrouterJob()]), { env: testEnv() });
  assert.equal(result.status, 'valid');
});

test('validateProject passes a plain claude job while the anthropic lane is paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  const root = await repo(t);
  const result = await validateProject(root, manifest([plainClaudeJob()]), { env: testEnv() });
  assert.equal(result.status, 'valid');
});

test('validateManifest on a saved manifest with an anthropic job still passes while paused', TIMEOUT, () => {
  mergeIsolatedConfig({ lanes: { anthropic: { paused: true } } });
  assert.doesNotThrow(() => validateManifest(manifest([anthropicJob()]), { env: testEnv() }));
});

test('agent auto never resolves to a paused anthropic lane', TIMEOUT, () => {
  const lanes = {
    cursor: { model: 'cursor-fast' },
    codex: { model: 'codex', paused: true },
    anthropic: { model: 'claude-haiku-5-5', paused: true },
    claude: { model: 'sonnet' },
  };
  const job = {
    id: 'build',
    agent: 'auto',
    type: 'build',
    sensitive: false,
    prompt: 'Build it.',
    context: [],
    outputs: ['output.txt'],
  };
  const route = routeJob(job, { lanes, health: () => ({ state: 'ok' }) });
  assert.notEqual(route.agent, 'anthropic');
});
