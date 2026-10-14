// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { NON_SENSITIVE_ONLY_AGENTS, validateManifest, askRun, resolveAskRoute } from '../tools/swarm.mjs';

const cli = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const exec = promisify(execFile);
const job = (agent, extra = {}) => ({ id: 'review', agent, model: agent === 'codex' ? 'gpt-5.4' : 'test-model', prompt: 'Review.', context: [], outputs: [], ...extra });
const manifest = spec => ({ version: 1, jobs: [spec] });

test('non-sensitive-only providers require an explicit boolean opt-in', () => {
  assert.deepEqual(NON_SENSITIVE_ONLY_AGENTS, ['openrouter', 'openai', 'gemini', 'lambda']);
  assert.equal(Object.isFrozen(NON_SENSITIVE_ONLY_AGENTS), true);
  for (const agent of NON_SENSITIVE_ONLY_AGENTS) {
    for (const extra of [{}, { sensitive: true }]) {
      assert.throws(() => validateManifest(manifest(job(agent, extra))), {
        code: agent === 'openrouter' ? 'sensitive-openrouter' : 'sensitive-provider',
        message: `Job review: ${agent === 'openrouter' ? 'OpenRouter' : agent} only gets jobs that set sensitive: false`
      });
    }
    assert.doesNotThrow(() => validateManifest(manifest(job(agent, { sensitive: false }))));
    assert.throws(() => validateManifest(manifest(job(agent, { sensitive: 'false' }))), /sensitive must be true or false/);
  }
});

test('subscription and local agents remain unaffected', () => {
  for (const agent of ['qwen', 'ollama', 'claude', 'codex', 'hermes', 'cursor']) {
    for (const extra of [{}, { sensitive: true }, { sensitive: false }]) {
      assert.doesNotThrow(() => validateManifest(manifest(job(agent, extra))));
    }
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-sensitive-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'source');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('ask refuses all sensitive API routes before fetch, including tier and fallback routes', async t => {
  const root = await fixture(t);
  let calls = 0;
  for (const agent of NON_SENSITIVE_ONLY_AGENTS) {
    const message = `ask-sensitive-provider: ${agent} needs --not-sensitive; the question and context would leave for a third-party API`;
    for (const extra of [{}, { sensitive: true }]) {
      await assert.rejects(askRun(root, { agent, model: 'test-model', context: ['input.txt'], question: 'Review?', ...extra }, {
        fetchImpl: async () => { calls++; assert.fail('sensitive API route fetched'); }
      }), { code: 'ask-sensitive-provider', message });
    }
    const config = { tiers: { cheap: { agent, model: 'test-model' } } };
    assert.throws(() => resolveAskRoute({ tier: 'cheap' }, config), { code: 'ask-sensitive-provider', message });
    assert.deepEqual(resolveAskRoute({ tier: 'cheap', sensitive: false }, config), { agent, model: 'test-model' });
    assert.throws(() => resolveAskRoute({ tier: 'cheap' }, { tiers: { cheap: { agent: 'codex', model: 'gpt-5.4', fallback: { agent, model: 'test-model' } } } }), { code: 'ask-sensitive-provider', message });
  }
  assert.equal(calls, 0);
});

test('OpenRouter ask runs with sensitive false and a stub transport', async t => {
  const root = await fixture(t);
  let calls = 0;
  const result = await askRun(root, { agent: 'openrouter', model: 'test-model', sensitive: false, context: ['input.txt'], question: 'Review?' }, {
    env: { OPENROUTER_API_KEY: 'sk-or-FAKE-0000', SWARM_LOGS_DIR: path.join(root, 'logs') },
    fetchImpl: async url => {
      calls++;
      const value = String(url).endsWith('/models')
        ? { data: [{ id: 'test-model', pricing: { prompt: '0.000002', completion: '0.00001' } }] }
        : { id: 'gen-1', model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: JSON.stringify({ answer: 'yes' }), files: [] }) } }] };
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.result, { answer: 'yes' });
  assert.ok(calls > 0);
});

test('CLI parses the boolean --not-sensitive without consuming the question', async t => {
  const root = await fixture(t);
  const args = ['--root', root, 'ask', '--agent', 'openai', '--model', 'test-model', '--context', 'input.txt'];
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  await assert.rejects(exec(process.execPath, [cli, ...args, 'Review?'], { env }), error => {
    assert.match(error.stderr, /ask-sensitive-provider: openai needs --not-sensitive/);
    return true;
  });
  await assert.rejects(exec(process.execPath, [cli, ...args, '--not-sensitive', 'Review?'], { env }), asyncError => {
    assert.doesNotMatch(asyncError.stderr, /ask-sensitive-provider|ask-route-invalid|exactly one question/);
    const result = JSON.parse(asyncError.stdout.trim());
    assert.equal(result.status, 'unparsed');
    return true;
  });
  const runs = await fs.readdir(path.join(root, '.swarm/runs'));
  assert.equal(runs.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', runs[0], 'manifest.json'), 'utf8'));
  assert.equal(saved.jobs[0].sensitive, false);
  assert.match(saved.jobs[0].prompt, /^Review\?/);
});
