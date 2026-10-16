// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardManifest } from '../bench/gpu-bakeoff/hard-task.mjs';

test('anthropic hard job has sensitive settings and no contract fields', () => {
  const job = hardManifest({ agent: 'anthropic', model: 'claude-haiku-5-5' }).jobs[0];
  assert.equal(job.agent, 'anthropic');
  assert.equal(job.model, 'claude-haiku-5-5');
  assert.equal(job.sensitive, true);
  assert.deepEqual(job.context, ['TASK.md', 'planWaves.mjs']);
  assert.deepEqual(job.outputs, ['planWaves.mjs']);
  assert.equal(job.timeoutMs, 600000);
  assert.equal(job.maxOutputTokens, 32000);
  assert.equal('contract' in job, false);
  assert.equal('acceptance' in job, false);
  assert.equal('bestOf' in job, false);
});

test('codex hard job has sensitive settings and no contract fields', () => {
  const job = hardManifest({ agent: 'codex', model: 'gpt-6.1-sol' }).jobs[0];
  assert.equal(job.agent, 'codex');
  assert.equal(job.model, 'gpt-6.1-sol');
  assert.equal(job.sensitive, true);
  assert.deepEqual(job.context, ['TASK.md', 'planWaves.mjs']);
  assert.deepEqual(job.outputs, ['planWaves.mjs']);
  assert.equal(job.timeoutMs, 600000);
  assert.equal(job.maxOutputTokens, undefined, 'a CLI lane takes no output limits');
  assert.equal(job.outputCapBytes, undefined);
  assert.equal('contract' in job, false);
  assert.equal('acceptance' in job, false);
  assert.equal('bestOf' in job, false);
});

test('default rented job has contract and acceptance', () => {
  const job = hardManifest({ model: 'm/x' }).jobs[0];
  assert.equal(job.agent, 'rented');
  assert.equal(job.sensitive, false);
  assert.equal(job.contract, 'TASK.md');
  assert.ok(Array.isArray(job.acceptance));
});

test('rented maxOutputTokens depends on SWARM_RENTED_THINKING', () => {
  const saved = process.env.SWARM_RENTED_THINKING;
  try {
    delete process.env.SWARM_RENTED_THINKING;
    assert.equal(hardManifest({ model: 'm/x' }).jobs[0].maxOutputTokens, 30000);
    process.env.SWARM_RENTED_THINKING = 'off';
    assert.equal(hardManifest({ model: 'm/x' }).jobs[0].maxOutputTokens, 16000);
  } finally {
    if (saved === undefined) delete process.env.SWARM_RENTED_THINKING;
    else process.env.SWARM_RENTED_THINKING = saved;
  }
});
