// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SHORTLIST, validateUpOptions, PINNED_IMAGE, GPU_DEFAULTS } from '../tools/gpu.mjs';
import { selectCandidates, LEVELS } from '../tools/gpu-bakeoff.mjs';
import { executeApi } from '../tools/api-adapters.mjs';
import { gpuSessionPath } from '../tools/rented.mjs';

const LABELS = ['qwen3.6-35b-a3b-nvfp4', 'nemotron-3.5-lightning-nvfp4', 'qwen3-coder-next-nvfp4'];
const MODELS = ['nvidia/Qwen3.6-35B-A3B-NVFP4', 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4', 'RedHatAI/Qwen3-Coder-Next-NVFP4'];

test('shortlist has the three NVFP4 entries in order with the expected models', () => {
  assert.equal(SHORTLIST.length, 3);
  assert.deepEqual(SHORTLIST.map(item => item.label), LABELS);
  assert.deepEqual(SHORTLIST.map(item => item.model), MODELS);
});

test('qwen3.6 and Lightning are full runs; only Coder-Next is optional (time permitting)', () => {
  assert.equal(SHORTLIST[0].optional, undefined);
  assert.equal(SHORTLIST[1].optional, undefined);
  assert.equal(SHORTLIST[2].optional, true);
});

test('every shortlist entry is NVFP4 and its label says so', () => {
  assert.deepEqual(SHORTLIST.map(item => item.quant), ['nvfp4', 'nvfp4', 'nvfp4']);
  for (const item of SHORTLIST) assert.match(item.label, /nvfp4$/);
});

test('every shortlist entry passes validateUpOptions', () => {
  for (const item of SHORTLIST) {
    assert.doesNotThrow(() => validateUpOptions({ target: 'ubuntu@203.0.113.9', key: '/k', model: item.model, hourlyUsd: 2, maxUsd: 15, args: item.args }));
  }
});

test('qwen3.6 args include the qwen3 reasoning parser', () => {
  const args = SHORTLIST[0].args;
  const i = args.indexOf('--reasoning-parser');
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], 'qwen3');
});

test('nemotron args include the nemotron_v3 parser and async scheduling, and no moe backend override', () => {
  const args = SHORTLIST[1].args;
  const i = args.indexOf('--reasoning-parser');
  assert.notEqual(i, -1);
  assert.equal(args[i + 1], 'nemotron_v3');
  assert.notEqual(args.indexOf('--async-scheduling'), -1);
  assert.equal(args.indexOf('--moe-backend'), -1);
});

test('the pinned image is vLLM v0.31.0 by digest and the memory utilization is 0.93', () => {
  assert.match(PINNED_IMAGE, /^vllm\/vllm-openai@sha256:[0-9a-f]{64}$/);
  assert.equal(GPU_DEFAULTS.memoryUtilization, 0.93);
});

test('the agent levels are 32, 64, 96, 128 and 192', () => {
  assert.deepEqual([...LEVELS], [32, 64, 96, 128, 192]);
});

test('selectCandidates with no argument returns all three shortlist entries', () => {
  const picked = selectCandidates();
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map(item => item.label), LABELS);
});

test('selectCandidates with all three labels returns them in order with args', () => {
  const picked = selectCandidates(LABELS.join(','));
  assert.deepEqual(picked.map(item => item.label), LABELS);
  assert.deepEqual(picked.map(item => item.args), SHORTLIST.map(item => item.args));
});

const JOB = { id: 'j2', agent: 'rented', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', sensitive: false, prompt: 'Write out/a.txt', context: [], outputs: ['out/a.txt'] };
const MODEL = JOB.model;
const reply = JSON.stringify({ summary: 'ok', files: [{ path: 'out/a.txt', content: 'a\n' }], edits: [] });

function fakeFetch() {
  const seen = { bodies: [] };
  const fetchImpl = async (url, init) => {
    seen.bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: reply } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

async function rentedFixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lineup-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({}));
  const env = { SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') };
  const session = { version: 1, target: 'ubuntu@203.0.113.9', key: '/k', model: MODEL, replicas: 1, endpoints: ['http://127.0.0.1:18000'], perReplica: 8, hourlyUsd: 3, capUsd: 20, maxHours: 4, startedAt: '2030-01-01T11:00:00.000Z', expiresAt: '2100-01-01T00:00:00.000Z' };
  const sessionFile = gpuSessionPath(env);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, JSON.stringify(session));
  return env;
}

test('rented job without bestOf sends chat_template_kwargs enable_thinking false', async t => {
  const env = await rentedFixture(t);
  const { seen, fetchImpl } = fakeFetch();
  const result = await executeApi({ ...JOB }, [], { env, fetchImpl });
  assert.equal(result.status, 'complete', result.error);
  assert.deepEqual(seen.bodies[0].chat_template_kwargs, { enable_thinking: false });
});

test('rented job with SWARM_RENTED_THINKING on sends no chat_template_kwargs', async t => {
  const env = await rentedFixture(t);
  const { seen, fetchImpl } = fakeFetch();
  const result = await executeApi({ ...JOB }, [], { env: { ...env, SWARM_RENTED_THINKING: 'on' }, fetchImpl });
  assert.equal(result.status, 'complete', result.error);
  assert.equal('chat_template_kwargs' in seen.bodies[0], false);
});
