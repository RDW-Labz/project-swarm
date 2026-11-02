// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateQueue, validateManifest } from '../tools/swarm.mjs';
import { buildRepoMap, writeRepoMap } from '../tools/repo-map.mjs';

const exec = promisify(execFile);
const git = (root, ...args) => exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
const job = n => ({ id: `job-${n}`, agent: 'ollama', model: 'test-model', prompt: `Update src/a${n}.mjs with the intended change. ignoreTests: the fixture test is not part of this job.`, context: ['input.txt'], outputs: [`src/a${n}.mjs`], ignoreTests: [`tests/t${n}.test.mjs`], timeoutMs: 30000 });
const completion = (n, content) => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `src/a${n}.mjs`, content }] }) } }), { headers: { 'content-type': 'application/json' } });
const stub = async (_url, options) => { const n = Number(/src\/a(\d+)\.mjs/.exec(options.body)[1]); return completion(n, `export const a${n} = 'changed ${n}';\n`); };

async function fixture(t, count, { map = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-affected-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  for (let n = 0; n < count; n++) {
    await fs.writeFile(path.join(root, `src/a${n}.mjs`), `export const a${n} = 'base ${n}';\n`);
    await fs.writeFile(path.join(root, `tests/t${n}.test.mjs`), `import '../src/a${n}.mjs';\n`);
  }
  await exec('git', ['init', '-q', root]);
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'fixture');
  if (map) await writeRepoMap(root, await buildRepoMap(root, { head: (await git(root, 'rev-parse', 'HEAD')).stdout.trim(), list: async r => (await git(r, 'ls-files')).stdout.split('\n').filter(Boolean) }));
  return root;
}
const log = root => fs.readFile(path.join(root, 'log.txt'), 'utf8').then(text => text.trim().split('\n'), () => []);
const checks = () => [{ name: 'tests', argv: [process.execPath, '-e', "require('fs').appendFileSync('log.txt','full\\n')"], affectedArgv: [process.execPath, '-e', "require('fs').appendFileSync('log.txt','affected '+process.argv.slice(1).join(',')+'\\n')", '{affected}'], fullEvery: 3 }];

test('validateManifest accepts affectedArgv and fullEvery and refuses bad ones', () => {
  const base = { version: 1, jobs: [job(0)] };
  const ok = { name: 'tests', argv: ['node', '--test'], affectedArgv: ['node', '--test', '{affected}'], fullEvery: 4 };
  assert.doesNotThrow(() => validateManifest({ ...base, checks: [ok] }, process.cwd()));
  for (const bad of [{ ...ok, affectedArgv: ['node', '--test'] }, { ...ok, affectedArgv: ['{affected}', '{affected}'] }, { ...ok, fullEvery: 0 }, { name: 'tests', argv: ['node'], fullEvery: 3 }]) {
    assert.throws(() => validateManifest({ ...base, checks: [bad] }, process.cwd()));
  }
});

test('queue runs only the affected tests, a full run every third batch and on the last batch', async t => {
  const root = await fixture(t, 6);
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 6 }, (_, n) => job(n)), checks: checks() }, { fetchImpl: stub });
  assert.equal(run.status, 'complete', run.error);
  const result = await integrateQueue(root, run.id, { batchSize: 1 });
  assert.equal(result.status, 'integrated');
  assert.deepEqual(await log(root), ['affected ./tests/t0.test.mjs', 'affected ./tests/t1.test.mjs', 'full', 'affected ./tests/t3.test.mjs', 'affected ./tests/t4.test.mjs', 'full']);
  const saved = JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${run.id}/state.json`), 'utf8'));
  const modes = saved.mergeQueue.batches.length;
  assert.equal(modes, 6);
});

test('without a repo map every batch runs the normal check', async t => {
  const root = await fixture(t, 3, { map: false });
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 3 }, (_, n) => job(n)), checks: checks() }, { fetchImpl: stub });
  await integrateQueue(root, run.id, { batchSize: 1 });
  assert.deepEqual(await log(root), ['full', 'full', 'full']);
});

test('a change that no map entry covers falls back to the full check', async t => {
  const root = await fixture(t, 2);
  const jobs = [job(0), { ...job(1), outputs: ['src/new.mjs'], prompt: 'Create src/a1.mjs.' }];
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs, checks: checks() }, { fetchImpl: async (_u, o) => { const n = Number(/src\/a(\d+)\.mjs/.exec(o.body)[1]); return n === 0 ? completion(0, "export const a0 = 'x';\n") : new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'd', files: [{ path: 'src/new.mjs', content: 'export const n = 1;\n' }] }) } }), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(run.status, 'complete', run.error);
  await integrateQueue(root, run.id, { batchSize: 1 });
  const lines = await log(root);
  assert.equal(lines[0], 'affected ./tests/t0.test.mjs');
  assert.equal(lines[1], 'full');
});

test('--adaptive grows the batch size after passing batches and records it', async t => {
  const root = await fixture(t, 12, { map: false });
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 12 }, (_, n) => job(n)), checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exit(0)'] }] }, { fetchImpl: stub });
  assert.equal(run.status, 'complete', String(run.error));
  const result = await integrateQueue(root, run.id, { batchSize: 2, adaptive: true });
  assert.equal(result.status, 'integrated');
  assert.equal(result.integrated.length, 12);
  const saved = JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${run.id}/state.json`), 'utf8'));
  assert.deepEqual(saved.mergeQueue.adaptive.sizes, [2, 2, 2, 25]);
  assert.equal(saved.mergeQueue.adaptive.steps.up, 1);
  assert.deepEqual(saved.mergeQueue.batches.map(b => b.jobs.length), [2, 2, 2, 6]);
});

test('--adaptive steps down after a failing batch and bisect still isolates the bad job', async t => {
  const root = await fixture(t, 6, { map: false });
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 6 }, (_, n) => job(n)), checks: [{ name: 'no-a3', argv: [process.execPath, '-e', "const s=require('fs').readFileSync('src/a3.mjs','utf8');process.exit(s.includes('changed 3')?1:0)"] }] }, { fetchImpl: stub });
  const result = await integrateQueue(root, run.id, { batchSize: 3, adaptive: true });
  assert.equal(result.integrated.length, 5);
  const saved = JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${run.id}/state.json`), 'utf8'));
  assert.deepEqual(saved.mergeQueue.checkFailed.map(f => f.job), ['job-3']);
  assert.ok(saved.mergeQueue.adaptive.steps.down >= 1);
});

test('a stale map (built at another commit) is ignored and every batch runs the normal check', async t => {
  const root = await fixture(t, 3);
  await fs.writeFile(path.join(root, 'input.txt'), 'changed input\n');
  await git(root, 'commit', '-qam', 'move head');
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 3 }, (_, n) => job(n)), checks: checks() }, { fetchImpl: stub });
  const result = await integrateQueue(root, run.id, { batchSize: 1 });
  assert.deepEqual(await log(root), ['full', 'full', 'full']);
  assert.ok(result.status);
});

test('a failed full run is not narrowed away when its batch is bisected', async t => {
  const root = await fixture(t, 4);
  const failing = [{ name: 'tests', argv: [process.execPath, '-e', "const fs=require('fs');fs.appendFileSync('log.txt','full\\n');const s=fs.readFileSync('src/a1.mjs','utf8');process.exit(s.includes('changed 1')?1:0)"], affectedArgv: [process.execPath, '-e', "require('fs').appendFileSync('log.txt','affected\\n')", '{affected}'], fullEvery: 1 }];
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 4 }, (_, n) => job(n)), checks: failing }, { fetchImpl: stub });
  const result = await integrateQueue(root, run.id, { batchSize: 4 });
  assert.equal(result.checkFailed.length, 1);
  assert.equal(result.checkFailed[0].job, 'job-1');
  assert.ok(!(await log(root)).includes('affected'));
});

test('when the last batch fails and is rolled back, one full run still covers the affected-only batches', async t => {
  const root = await fixture(t, 2);
  const check = [{ name: 'tests', argv: [process.execPath, '-e', "const fs=require('fs');fs.appendFileSync('log.txt','full\\n');process.exit(fs.readFileSync('src/a1.mjs','utf8').includes('changed 1')?1:0)"], affectedArgv: [process.execPath, '-e', "require('fs').appendFileSync('log.txt','affected '+process.argv.slice(1).join(',')+'\\n')", '{affected}'], fullEvery: 9 }];
  const run = await runManifest(root, { version: 1, concurrency: 8, jobs: Array.from({ length: 2 }, (_, n) => job(n)), checks: check }, { fetchImpl: stub });
  const result = await integrateQueue(root, run.id, { batchSize: 1 });
  assert.deepEqual(await log(root), ['affected ./tests/t0.test.mjs', 'full', 'full']);
  assert.equal(result.checkFailed[0].job, 'job-1');
  const saved = JSON.parse(await fs.readFile(path.join(root, `.swarm/runs/${run.id}/state.json`), 'utf8'));
  assert.equal(saved.mergeQueue.finalCheck.passed, true);
});
