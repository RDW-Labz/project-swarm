// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PAID_LANES } from '../tools/spend.mjs';
import {
  PAID_KEY_LANES,
  assertPaidLaneNotPaused,
  paidLanePauseCode,
  paidLanePausedProblem,
  isHostedLambdaInference,
} from '../tools/paid-lane-pause.mjs';
import { validateProject } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';
import { apiConfiguration } from '../tools/api-adapters.mjs';
import { readRentedKey, RENTED_DEFAULTS } from '../tools/rented.mjs';
import { readAnthropicKey, ANTHROPIC_KEY_ENV } from '../tools/anthropic.mjs';
import { readOpenRouterKey, OPENROUTER_KEY_ENV } from '../tools/openrouter.mjs';

const TIMEOUT = { timeout: 60000 };
const fakeKey = 'zz'.repeat(16);
const testEnv = extra => ({ SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME, ...extra });
const manifest = jobs => ({ version: 1, jobs });

const apiJob = (agent, overrides = {}) => ({
  id: `${agent}-worker`,
  agent,
  model: agent === 'gemini' ? 'gemini-2.5-flash' : agent === 'rented' ? 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8' : agent === 'lambda' ? 'meta-llama/Llama-3.1-8B-Instruct' : 'gpt-5',
  prompt: 'Update the output.',
  context: ['input.txt'],
  outputs: ['output.txt'],
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
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'swarm-paid-lane-pause-validate-')));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fsPromises.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fsPromises.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fsPromises.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}

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

function pausedConfig(lane) {
  return { lanes: { [lane]: { paused: true } } };
}

function unpausedConfig(lane) {
  return { lanes: { [lane]: { paused: false } } };
}

function assertPausedRefusal(fn, lane, fake) {
  const code = paidLanePauseCode(lane);
  assert.throws(fn, error => {
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(`^${code}: the paid ${lane} lane is paused`));
    assert.ok(!String(error.message).includes(fake));
    assert.ok(!String(error.stack ?? '').includes(fake));
    return true;
  });
}

const rentedGpu = {
  rentedGpu: {
    endpoint: 'https://203.0.113.9',
    model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
    hourlyUsd: 24.5,
  },
};

test('openai: paused refuses before env key; unpaused reads key', () => {
  const env = { OPENAI_API_KEY: fakeKey, SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME };
  assertPausedRefusal(() => apiConfiguration('openai', env, { config: pausedConfig('openai') }), 'openai', fakeKey);
  const cfg = apiConfiguration('openai', env, { config: unpausedConfig('openai') });
  assert.equal(cfg.key, fakeKey);
});

test('gemini: paused refuses with GEMINI_API_KEY set', () => {
  const env = { GEMINI_API_KEY: fakeKey, SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME };
  assertPausedRefusal(() => apiConfiguration('gemini', env, { config: pausedConfig('gemini') }), 'gemini', fakeKey);
  assert.equal(apiConfiguration('gemini', env, { config: unpausedConfig('gemini') }).key, fakeKey);
});

test('gemini: paused refuses with GOOGLE_API_KEY set', () => {
  const env = { GOOGLE_API_KEY: fakeKey, SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME };
  assertPausedRefusal(() => apiConfiguration('gemini', env, { config: pausedConfig('gemini') }), 'gemini', fakeKey);
  assert.equal(apiConfiguration('gemini', env, { config: unpausedConfig('gemini') }).key, fakeKey);
});

test('rented readRentedKey: paused refuses and never calls exec', () => {
  const { calls, exec } = recorder();
  const env = { SWARM_RENTED_API_KEY: fakeKey, SWARM_RENTED_NO_KEYCHAIN: '1' };
  assertPausedRefusal(
    () => readRentedKey(env, RENTED_DEFAULTS.keyItem, { platform: 'darwin', exec, config: pausedConfig('rented') }),
    'rented',
    fakeKey,
  );
  assert.equal(calls.length, 0);
});

test('rented readRentedKey: unpaused reads env key', () => {
  const { calls, exec } = recorder();
  const env = { SWARM_RENTED_API_KEY: fakeKey, SWARM_RENTED_NO_KEYCHAIN: '1' };
  assert.equal(readRentedKey(env, RENTED_DEFAULTS.keyItem, { platform: 'darwin', exec, config: unpausedConfig('rented') }), fakeKey);
  assert.equal(calls.length, 0);
});

test('rented apiConfiguration: paused refuses before keychain', () => {
  mergeIsolatedConfig({ ...rentedGpu, lanes: { rented: { paused: true } } });
  const { calls, exec } = recorder();
  const env = {
    SWARM_RENTED_API_KEY: fakeKey,
    SWARM_RENTED_NO_KEYCHAIN: '1',
    SWARM_CONFIG: process.env.SWARM_CONFIG,
    HOME: process.env.HOME,
  };
  assertPausedRefusal(() => apiConfiguration('rented', env, { exec }), 'rented', fakeKey);
  assert.equal(calls.length, 0);
});

test('hosted lambda: paused refuses before LAMBDA_API_KEY read', () => {
  const env = { LAMBDA_API_KEY: fakeKey, SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME };
  assert.ok(isHostedLambdaInference(env));
  assertPausedRefusal(() => apiConfiguration('lambda', env, { config: pausedConfig('lambda') }), 'lambda', fakeKey);
  assert.equal(apiConfiguration('lambda', env, { config: unpausedConfig('lambda') }).key, fakeKey);
});

test('self-hosted lambda: lanes.lambda paused does not block key read', () => {
  const env = {
    LAMBDA_API_KEY: fakeKey,
    SWARM_LAMBDA_URL: 'http://127.0.0.1:8000',
    SWARM_CONFIG: process.env.SWARM_CONFIG,
    HOME: process.env.HOME,
  };
  assert.equal(apiConfiguration('lambda', env, { config: pausedConfig('lambda') }).key, fakeKey);
});

test('every PAID_LANES entry with a key reader refuses when paused', () => {
  const readers = {
    anthropic: (env, { exec, config }) => readAnthropicKey(env, { platform: 'darwin', exec, config }),
    openrouter: (env, { exec, config }) => readOpenRouterKey(env, { platform: 'darwin', exec, config }),
    openai: (env, { config }) => apiConfiguration('openai', env, { config }),
    gemini: (env, { config }) => apiConfiguration('gemini', env, { config }),
    rented: (env, { exec, config }) => readRentedKey(env, RENTED_DEFAULTS.keyItem, { platform: 'darwin', exec, config }),
    lambda: (env, { config }) => apiConfiguration('lambda', env, { config }),
  };
  const envKeys = {
    anthropic: ANTHROPIC_KEY_ENV,
    openrouter: OPENROUTER_KEY_ENV,
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    rented: 'SWARM_RENTED_API_KEY',
    lambda: 'LAMBDA_API_KEY',
  };
  for (const lane of PAID_LANES) {
    assert.ok(readers[lane], `missing key reader for paid lane ${lane}`);
    const { calls, exec } = recorder();
    const env = {
      [envKeys[lane]]: fakeKey,
      SWARM_ANTHROPIC_NO_KEYCHAIN: '1',
      SWARM_OPENROUTER_NO_KEYCHAIN: '1',
      SWARM_RENTED_NO_KEYCHAIN: '1',
      SWARM_CONFIG: process.env.SWARM_CONFIG,
      HOME: process.env.HOME,
    };
    assertPausedRefusal(() => readers[lane](env, { exec, config: pausedConfig(lane) }), lane, fakeKey);
    assert.equal(calls.length, 0, `${lane} must not call keychain exec when paused`);
  }
});

test('PAID_KEY_LANES lists every paid lane that reads a hosted credential', () => {
  for (const lane of PAID_LANES) assert.ok(PAID_KEY_LANES.includes(lane), lane);
});

test('assertPaidLaneNotPaused is a no-op when lane is not paused', () => {
  assert.doesNotThrow(() => assertPaidLaneNotPaused('openai', { lanes: { openai: { paused: false } } }));
});

for (const lane of ['openai', 'gemini', 'rented']) {
  test(`validateProject refuses an explicit ${lane} job while paused`, TIMEOUT, async t => {
    mergeIsolatedConfig({ lanes: { [lane]: { paused: true } } });
    const root = await repo(t);
    const config = { lanes: { [lane]: { paused: true } } };
    const problem = paidLanePausedProblem(lane, config);
    const code = paidLanePauseCode(lane);
    await assert.rejects(
      validateProject(root, manifest([apiJob(lane)]), { env: testEnv() }),
      error => error.message === problem && error.code === code,
    );
  });
}

test('validateProject passes when paid lanes are paused but no explicit paid jobs use them', TIMEOUT, async t => {
  mergeIsolatedConfig({
    lanes: { openai: { paused: true }, gemini: { paused: true }, rented: { paused: true }, lambda: { paused: true } },
  });
  const root = await repo(t);
  const result = await validateProject(root, manifest([plainClaudeJob()]), { env: testEnv() });
  assert.equal(result.status, 'valid');
});

test('validateProject passes a self-hosted lambda job while the lambda lane is paused', TIMEOUT, async t => {
  mergeIsolatedConfig({ lanes: { lambda: { paused: true } } });
  const root = await repo(t);
  const result = await validateProject(root, manifest([apiJob('lambda')]), {
    env: testEnv({ SWARM_LAMBDA_URL: 'http://127.0.0.1:8000' }),
  });
  assert.equal(result.status, 'valid');
});
