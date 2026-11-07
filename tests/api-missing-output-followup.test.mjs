// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeApi } from '../tools/api-adapters.mjs';
import { usageCostUsd } from '../tools/anthropic.mjs';

const KEY = 'sk-ant-test-0123456789';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'api-missing-followup-'));
const job = (over = {}) => ({
  id: 'missing-followup',
  agent: 'anthropic',
  model: 'claude-haiku-5-5',
  prompt: 'write both outputs',
  context: [],
  outputs: ['a.txt', 'b.txt'],
  sensitive: true,
  ...over,
});

const reply = (envelope, usage = { input_tokens: 100, output_tokens: 50 }) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  body: new Response(JSON.stringify({
    type: 'message',
    model: 'claude-haiku-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ summary: 'ok', files: [], edits: [], ...envelope }) }],
    usage,
  })).body,
});

test('one follow-up merges missing declared outputs and sums usage', async () => {
  const env = { SWARM_LOGS_DIR: tmp(), SWARM_ANTHROPIC_API_KEY: KEY };
  let calls = 0;
  const result = await executeApi(job(), [], {
    env,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return reply({ files: [{ path: 'a.txt', content: 'A\n' }] });
      }
      return reply({ files: [{ path: 'b.txt', content: 'B\n' }] }, { input_tokens: 80, output_tokens: 40 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'complete', result.error);
  assert.deepEqual(result.files.map(file => file.path).sort(), ['a.txt', 'b.txt']);
  assert.equal(result.usage.input_tokens, 180);
  assert.equal(result.usage.output_tokens, 90);
  const expected = usageCostUsd('claude-haiku-5-5', { input_tokens: 100, output_tokens: 50 })
    + usageCostUsd('claude-haiku-5-5', { input_tokens: 80, output_tokens: 40 });
  assert.equal(result.costUsd, expected);
});

test('still missing after follow-up appends (after one follow-up request)', async () => {
  const env = { SWARM_LOGS_DIR: tmp(), SWARM_ANTHROPIC_API_KEY: KEY };
  let calls = 0;
  const result = await executeApi(job(), [], {
    env,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return reply({ files: [{ path: 'a.txt', content: 'A\n' }] });
      return reply({ files: [] });
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Worker must return every declared output exactly once \(after one follow-up request\)/);
});

test('follow-up undeclared output fails immediately without a second follow-up', async () => {
  const env = { SWARM_LOGS_DIR: tmp(), SWARM_ANTHROPIC_API_KEY: KEY };
  let calls = 0;
  const result = await executeApi(job(), [], {
    env,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return reply({ files: [{ path: 'a.txt', content: 'A\n' }] });
      return reply({ files: [{ path: 'extra.txt', content: 'X\n' }] });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /not in declared outputs/);
  assert.doesNotMatch(result.error, /after one follow-up request/);
});

test('duplicate path in the first reply fails with no follow-up request', async () => {
  const env = { SWARM_LOGS_DIR: tmp(), SWARM_ANTHROPIC_API_KEY: KEY };
  let calls = 0;
  const result = await executeApi(job(), [], {
    env,
    fetchImpl: async () => {
      calls += 1;
      return reply({
        files: [
          { path: 'a.txt', content: 'A\n' },
          { path: 'a.txt', content: 'A2\n' },
        ],
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /duplicate/);
});
