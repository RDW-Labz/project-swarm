// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeApi } from '../tools/api-adapters.mjs';
import { gpuSessionPath } from '../tools/rented.mjs';

const MODEL = 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8';
const SHORT = 'a\n';
const MEDIUM = 'bb'.repeat(20) + '\n';
const LONG = 'c'.repeat(200) + '\n';
const JOB = { id: 'j1', agent: 'rented', model: MODEL, sensitive: false, prompt: 'Write out/a.txt', context: [], outputs: ['out/a.txt'] };
const envelope = content => JSON.stringify({ summary: 'ok', files: [{ path: 'out/a.txt', content }], edits: [] });
const choice = text => ({ finish_reason: 'stop', message: { role: 'assistant', content: text } });

function fake(choices) {
  const seen = { bodies: [], inits: [] };
  const fetchImpl = async (url, init) => {
    seen.inits.push(init);
    seen.bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ model: MODEL, choices, usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-bestof-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({}));
  const env = { SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') };
  const session = { version: 1, target: 'ubuntu@203.0.113.9', key: '/k', model: MODEL, replicas: 1, endpoints: ['http://127.0.0.1:18000'], perReplica: 8, hourlyUsd: 3, capUsd: 20, maxHours: 4, startedAt: '2030-01-01T11:00:00.000Z', expiresAt: '2100-01-01T00:00:00.000Z' };
  const sessionFile = gpuSessionPath(env);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, JSON.stringify(session));
  return env;
}

test('best-of sends n: 3 and no authorization header on the rented server', async t => {
  const env = await fixture(t);
  const { seen, fetchImpl } = fake([choice(envelope(LONG)), choice(envelope(SHORT)), choice(envelope(MEDIUM))]);
  const result = await executeApi({ ...JOB, bestOf: 3 }, [], { env, fetchImpl, bestOfCheck: async () => ({ ok: true }) });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(seen.bodies[0].n, 3);
  assert.equal(seen.inits[0].headers.authorization, undefined);
});

test('best-of with all checks passing picks the shortest candidate', async t => {
  const env = await fixture(t);
  const { fetchImpl } = fake([choice(envelope(LONG)), choice(envelope(SHORT)), choice(envelope(MEDIUM))]);
  const result = await executeApi({ ...JOB, bestOf: 3 }, [], { env, fetchImpl, bestOfCheck: async () => ({ ok: true }) });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.files[0].content, SHORT);
  assert.deepEqual(result.bestOf, { n: 3, valid: 3, passed: 3, chosen: 1, checked: true });
});

test('best-of with the shortest failing picks the smallest passing candidate', async t => {
  const env = await fixture(t);
  const { fetchImpl } = fake([choice(envelope(LONG)), choice(envelope(SHORT)), choice(envelope(MEDIUM))]);
  const bestOfCheck = ({ envelope }) => ({ ok: envelope.files[0].content !== SHORT });
  const result = await executeApi({ ...JOB, bestOf: 3 }, [], { env, fetchImpl, bestOfCheck });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.files[0].content, MEDIUM);
  assert.deepEqual(result.bestOf, { n: 3, valid: 3, passed: 2, chosen: 2, checked: true });
});

test('best-of with every check false fails with best-of-failed', async t => {
  const env = await fixture(t);
  const { fetchImpl } = fake([choice(envelope(LONG)), choice(envelope(SHORT)), choice(envelope(MEDIUM))]);
  const result = await executeApi({ ...JOB, bestOf: 3 }, [], { env, fetchImpl, bestOfCheck: async () => ({ ok: false }) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /best-of-failed/);
});

test('best-of without a checker still completes with a structural pick', async t => {
  const env = await fixture(t);
  const { fetchImpl } = fake([choice(envelope(LONG)), choice(envelope(SHORT)), choice(envelope(MEDIUM))]);
  const result = await executeApi({ ...JOB, bestOf: 3 }, [], { env, fetchImpl });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.files[0].content, SHORT);
  assert.equal(result.bestOf.checked, false);
  assert.equal(result.bestOf.passed, 0);
  assert.equal(result.bestOf.chosen, 1);
});

test('a job without bestOf sends no n field and returns one choice as before', async t => {
  const env = await fixture(t);
  const { seen, fetchImpl } = fake([choice(envelope(SHORT))]);
  const result = await executeApi({ ...JOB }, [], { env, fetchImpl });
  assert.equal(result.status, 'complete', result.error);
  assert.equal('n' in seen.bodies[0], false);
  assert.equal(result.bestOf, undefined);
  assert.equal(result.files[0].content, SHORT);
});

test('best-of skips a choice that is not valid JSON', async t => {
  const env = await fixture(t);
  const { fetchImpl } = fake([choice('not json {'), choice(envelope(LONG)), choice(envelope(SHORT))]);
  const result = await executeApi({ ...JOB, bestOf: 3 }, [], { env, fetchImpl, bestOfCheck: async () => ({ ok: true }) });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.bestOf.valid, 2);
  assert.equal(result.bestOf.passed, 2);
  assert.equal(result.files[0].content, SHORT);
});
