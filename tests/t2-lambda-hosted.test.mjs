import './_isolate-config.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isHostedLambdaInference, pausedPaidLaneProblems } from '../tools/paid-lane-pause.mjs';
import { apiConfiguration } from '../tools/api-adapters.mjs';
import { validateProject } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const pausedConfig = { lanes: { lambda: { paused: true } } };
const testEnv = extra => ({ SWARM_CONFIG: process.env.SWARM_CONFIG, HOME: process.env.HOME, ...extra });
const manifest = {
  version: 1,
  jobs: [{
    id: 'lambda-worker', agent: 'lambda', model: 'meta-llama/Llama-3.1-8B-Instruct',
    prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], sensitive: false,
  }],
};

for (const [url, hosted] of [
  [undefined, true],
  ['https://api.lambda.ai', true],
  ['https://evil.example', true],
  ['http://localhost:8000', false],
  ['http://127.0.0.1:9000', false],
  ['http://127.42.12.99:9000', false],
  ['http://[::1]:8000', false],
  ['garbage string', true],
  ['https://localhost.evil.example', true],
  ['http://128.0.0.1:9000', true],
]) {
  test(`Lambda hosted predicate: ${url ?? 'unset'}`, () => {
    assert.equal(isHostedLambdaInference(url === undefined ? {} : { SWARM_LAMBDA_URL: url }), hosted);
  });
}

test('explicit hosted Lambda URL refuses while paused before reading the key', () => {
  let reads = 0;
  const env = testEnv({ SWARM_LAMBDA_URL: 'https://api.lambda.ai' });
  Object.defineProperty(env, 'LAMBDA_API_KEY', { get() { reads++; return 'zz'.repeat(16); } });
  assert.throws(() => apiConfiguration('lambda', env, { config: pausedConfig }), {
    code: 'lambda-lane-paused',
  });
  assert.equal(reads, 0);
  assert.deepEqual(pausedPaidLaneProblems(manifest, pausedConfig), [{
    lane: 'lambda', code: 'lambda-lane-paused',
    message: 'lambda-lane-paused: the paid lambda lane is paused and no key was read',
  }]);
});

test('loopback Lambda URL still reads its key while the paid lane is paused', () => {
  const key = 'zz'.repeat(16);
  const result = apiConfiguration('lambda', testEnv({
    SWARM_LAMBDA_URL: 'http://127.0.0.1:9000', LAMBDA_API_KEY: key,
  }), { config: pausedConfig });
  assert.equal(result.key, key);
  assert.equal(result.selfHosted, true);
});

test('validation refuses explicit hosted Lambda while paused and allows loopback', { timeout: 60000 }, async t => {
  const root = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'swarm-t2-lambda-hosted-')));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await fsPromises.writeFile(path.join(root, 'input.txt'), 'committed context');
  await fsPromises.writeFile(path.join(root, 'output.txt'), 'committed output');
  await fsPromises.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const file = process.env.SWARM_CONFIG;
  let base = {};
  try { base = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* empty */ }
  fs.writeFileSync(file, `${JSON.stringify({ ...base, ...pausedConfig }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(validateProject(root, manifest, {
    env: testEnv({ SWARM_LAMBDA_URL: 'https://api.lambda.ai', LAMBDA_API_KEY: 'zz'.repeat(16) }),
  }), { code: 'lambda-lane-paused' });
  const result = await validateProject(root, manifest, {
    env: testEnv({ SWARM_LAMBDA_URL: 'http://127.0.0.1:9000' }),
  });
  assert.equal(result.status, 'valid');
});
