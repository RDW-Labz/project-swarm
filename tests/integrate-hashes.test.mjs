// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateRun, readState } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const job = (n, overrides = {}) => ({
  id: `job-${n}`,
  agent: 'ollama',
  model: 'test-model',
  prompt: `Update out/${n}.txt with the intended change.`,
  context: ['input.txt'],
  outputs: [`out/${n}.txt`],
  timeoutMs: 5000,
  ...overrides,
});
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 32, jobs, ...overrides });
const reply = files => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files }) } }), { headers: { 'content-type': 'application/json' } });
const worker = contents => async (_url, options) => {
  const n = Number(/out\/(\d+)\.txt/.exec(options.body)[1]);
  return reply([{ path: `out/${n}.txt`, content: contents[n] ?? `proposed ${n}\n` }]);
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-integrate-hashes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  await fs.writeFile(path.join(root, 'out/0.txt'), 'base 0\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

test('integrateRun records integratedHashes for written files', async t => {
  const root = await fixture(t);
  const text = 'integrated bytes\n';
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: text }) });
  assert.equal(run.status, 'complete', run.error);
  await integrateRun(root, run.id, { noChecks: true });
  const state = await readState(root, run.id);
  const bytes = await fs.readFile(path.join(root, 'out/0.txt'));
  assert.equal(state.integratedHashes['out/0.txt'], digest(bytes));
});

test('merge queue merges integratedHashes across batches and keeps earlier paths', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0), job(1)]), { fetchImpl: worker({ 0: 'first integrate\n', 1: 'second integrate\n' }) });
  assert.equal(run.status, 'complete', run.error);
  await integrateRun(root, run.id, { queue: true, batchSize: 1, noChecks: true });
  const state = await readState(root, run.id);
  const b0 = await fs.readFile(path.join(root, 'out/0.txt'));
  const b1 = await fs.readFile(path.join(root, 'out/1.txt'));
  assert.equal(state.integratedHashes['out/0.txt'], digest(b0));
  assert.equal(state.integratedHashes['out/1.txt'], digest(b1));
});
