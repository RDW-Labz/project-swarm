// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, validateManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const job = (n, extra = {}) => ({ id: `job-${n}`, agent: 'ollama', model: 'm', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 60000, ...extra });
const env = root => ({ SWARM_CONFIG: process.env.SWARM_CONFIG, SWARM_SPEND_DIR: path.join(root, '.swarm/spend') });
async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-p14-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i']);
  return root;
}
function fakeApi(latency) {
  const seen = { inFlight: 0, peak: 0 };
  const fetchImpl = async (url, options) => {
    seen.peak = Math.max(seen.peak, ++seen.inFlight);
    const n = /out\/(\d+)\.txt/.exec(options.body)[1];
    await new Promise(resolve => setTimeout(resolve, latency));
    seen.inFlight--;
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'ok', files: [{ path: `out/${n}.txt`, content: `o${n}\n` }] }) } }), { headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchImpl };
}

test('API jobs are limited by their lane, never by the local host capacity or by each other (60 requests in flight at once)', async t => {
  const root = await repo(t);
  const { seen, fetchImpl } = fakeApi(400);
  const started = Date.now();
  const state = await runManifest(root, {
    version: 1, concurrency: 60, hosts: [{ id: 'local', kind: 'local', capacity: 2 }], lanes: { ollama: { concurrency: 60 } },
    jobs: Array.from({ length: 60 }, (_, n) => job(n)),
  }, { env: env(root), fetchImpl, id: 'wide' });
  assert.equal(state.status, 'complete');
  assert.equal(seen.peak, 60);
  assert.ok(Date.now() - started < 8000, 'one 400 ms wave, not fifteen');
});

test('a few hundred jobs finish in seconds, and the saved state stays correct', async t => {
  const root = await repo(t);
  const { fetchImpl } = fakeApi(2);
  const started = Date.now();
  const state = await runManifest(root, { version: 1, concurrency: 256, lanes: { ollama: { concurrency: 256 } }, jobs: Array.from({ length: 600 }, (_, n) => job(n)) }, { env: env(root), fetchImpl, id: 'many' });
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs.filter(entry => entry.status === 'complete').length, 600);
  assert.ok(Date.now() - started < 60000, `took ${Date.now() - started} ms`);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/many/state.json'), 'utf8'));
  assert.equal(saved.status, 'complete');
  assert.equal(saved.jobs.length, 600);
  assert.equal(saved.summary.counts.complete, 600);
});

test('a job that starts while others are being saved is not held until they finish', async t => {
  const root = await repo(t);
  const { seen, fetchImpl } = fakeApi(1200);
  const state = await runManifest(root, { version: 1, concurrency: 20, lanes: { ollama: { concurrency: 20 } }, jobs: Array.from({ length: 20 }, (_, n) => job(n)) }, { env: env(root), fetchImpl, id: 'overlap' });
  assert.equal(state.status, 'complete');
  assert.equal(seen.peak, 20);
});

test('the output overlap check is a set lookup, still refuses a folder and a file inside it, and 3000 jobs validate quickly', () => {
  const many = Array.from({ length: 3000 }, (_, n) => ({ id: `j${n}`, agent: 'codex', model: 'gpt-6.1-sol', prompt: 'x', context: [], outputs: [`dir${n % 50}/file${n}.txt`] }));
  const began = Date.now();
  validateManifest({ version: 1, jobs: many });
  assert.ok(Date.now() - began < 3000);
  const clash = (a, b) => validateManifest({ version: 1, jobs: [{ id: 'a', agent: 'codex', model: 'gpt-6.1-sol', prompt: 'x', context: [], outputs: [a] }, { id: 'b', agent: 'codex', model: 'gpt-6.1-sol', prompt: 'x', context: [], outputs: [b] }] });
  assert.throws(() => clash('docs', 'docs/a.md'), /Overlapping output paths: docs, docs\/a\.md/);
  assert.throws(() => clash('docs/a/b.md', 'docs'), /Overlapping output paths: docs, docs\/a\/b\.md/);
  assert.doesNotThrow(() => clash('docs/a.md', 'docs/ab.md'));
  assert.doesNotThrow(() => clash('docs-old/a.md', 'docs/a.md'));
});

test('cacheContext is only for Anthropic jobs, 1-10 unique paths that are in context', () => {
  const base = { id: 'a', agent: 'anthropic', model: 'claude-haiku-5-5', sensitive: true, prompt: 'x', context: ['c1.md', 'c2.md'], outputs: ['o.txt'] };
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [{ ...base, cacheContext: ['c1.md'] }] }));
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [(({ model, ...rest }) => ({ ...rest, agent: 'auto', cacheContext: ['c1.md', 'c2.md'] }))(base)] }));
  for (const cacheContext of [[], ['c3.md'], ['c1.md', 'c1.md'], 'c1.md', [5], Array.from({ length: 11 }, (_, n) => `c${n}.md`)]) {
    assert.throws(() => validateManifest({ version: 1, jobs: [{ ...base, cacheContext }] }), /cacheContext/, JSON.stringify(cacheContext));
  }
  assert.throws(() => validateManifest({ version: 1, jobs: [{ ...base, agent: 'codex', model: 'gpt-6.1-sol', sensitive: undefined, cacheContext: ['c1.md'] }] }), /cacheContext is for the anthropic lane/);
});

test('a manifest can ask for an adaptive lane, and the setting is validated', () => {
  const jobs = [job(1)];
  assert.doesNotThrow(() => validateManifest({ version: 1, lanes: { openai: { concurrency: 40, adaptive: true } }, jobs }));
  assert.doesNotThrow(() => validateManifest({ version: 1, lanes: { openai: { concurrency: 40, adaptive: { start: 4, min: 2 } } }, jobs }));
  assert.throws(() => validateManifest({ version: 1, lanes: { openai: { concurrency: 40, adaptive: { start: 99 } } }, jobs }), /lanes-invalid/);
});
