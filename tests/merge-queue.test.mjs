// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, integrateQueue } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const job = (n, overrides = {}) => ({ id: `job-${n}`, agent: 'ollama', model: 'test-model', prompt: `Update out/${n}.txt with the intended change.`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 32, jobs, ...overrides });
const completion = (n, content) => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content }] }) } }), { headers: { 'content-type': 'application/json' } });
const stub = async (_url, options) => {
  const n = Number(/out\/(\d+)\.txt/.exec(options.body)[1]);
  return completion(n, `proposed ${n}\n`);
};
async function fixture(t, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  for (let n = 0; n < count; n++) await fs.writeFile(path.join(root, `out/${n}.txt`), `base ${n}\n`);
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}
const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const state = async (root, id) => JSON.parse(await read(root, `.swarm/runs/${id}/state.json`));

test('200 jobs integrate 190 first and requeue ten against current content', { timeout: 60000 }, async t => {
  const start = Date.now(), root = await fixture(t, 200);
  const spec = manifest(Array.from({ length: 200 }, (_, n) => job(n)), { checks: [{ name: 'pass', argv: [process.execPath, '-e', 'process.exit(0)'] }] });
  const run = await runManifest(root, spec, { fetchImpl: stub });
  assert.equal(run.status, 'complete', run.error);
  for (let n = 0; n < 10; n++) await fs.writeFile(path.join(root, `out/${n}.txt`), `newer ${n}\n`);
  const result = await integrateQueue(root, run.id, { fetchImpl: async (_url, options) => {
    const n = Number(/out\/(\d+)\.txt/.exec(options.body)[1]);
    return completion(n, (await read(root, `out/${n}.txt`)) + 'reapplied\n');
  } });
  assert.equal(result.status, 'integrated');
  assert.equal(result.integrated.length, 200);
  assert.equal(result.requeued.length, 10);
  assert.deepEqual(result.flagged, []);
  assert.deepEqual(result.runs.map(run => run.kind), ['original', 'requeue']);
  const saved = await state(root, run.id);
  assert.equal(saved.mergeQueue.integrated.length, 190);
  assert.equal(saved.mergeQueue.conflicts.length, 10);
  assert.deepEqual(saved.mergeQueue.summary, result);
  for (let n = 0; n < 10; n++) assert.equal(await read(root, `out/${n}.txt`), `newer ${n}\nreapplied\n`);
  assert.ok(Date.now() - start < 60000);
});

test('queue never writes any output of a conflicting job, including mode conflicts', async t => {
  const root = await fixture(t, 2);
  const run = await runManifest(root, manifest([job(0, { outputs: ['out/0.txt', 'out/1.txt'] })]), { fetchImpl: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: "done", files: [{ path: 'out/0.txt', content: 'proposal' }, { path: 'out/1.txt', content: 'other proposal' }] }) } })) });
  assert.equal(run.status, 'complete', run.jobs[0].error);
  await fs.writeFile(path.join(root, 'out/0.txt'), 'newer');
  await fs.chmod(path.join(root, 'out/1.txt'), 0o755);
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true });
  assert.equal(await read(root, 'out/0.txt'), 'newer');
  assert.equal(await read(root, 'out/1.txt'), 'base 1\n');
  assert.equal((await fs.stat(path.join(root, 'out/1.txt'))).mode & 0o777, 0o755);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.mergeQueue.conflicts, [{ job: 'job-0', files: ['out/0.txt', 'out/1.txt'], reason: 'permissions changed since worker snapshot' }]);
});

test('failed batch of eight bisects and restores only the bad job', async t => {
  const root = await fixture(t, 8);
  const check = "const fs=require('node:fs'); process.exit(fs.readFileSync('out/3.txt','utf8').includes('proposed')?1:0)";
  const run = await runManifest(root, manifest(Array.from({ length: 8 }, (_, n) => job(n)), { preChecks: [[process.execPath, '-e', "require('node:fs').appendFileSync('prechecks.txt','once\\n')"]], checks: [{ name: 'guard', argv: [process.execPath, '-e', check] }] }), { fetchImpl: stub });
  const result = await integrateRun(root, run.id, { queue: true, batchSize: 8 });
  assert.deepEqual(result.mergeQueue.checkFailed, [{ job: 'job-3', checks: ['guard'] }]);
  assert.equal(result.mergeQueue.integrated.length, 7);
  assert.equal(result.mergeQueue.batches[0].bisected, true);
  assert.equal(result.mergeQueue.batches[0].checks, 'failed');
  assert.equal(await read(root, 'out/3.txt'), 'base 3\n');
  for (const n of [0, 1, 2, 4, 5, 6, 7]) assert.equal(await read(root, `out/${n}.txt`), `proposed ${n}\n`);
  assert.equal(await read(root, 'prechecks.txt'), 'once\n');
  assert.equal((await state(root, run.id)).integrationStatus, 'queued');
});

test('retry exhaustion runs one merge job, preserves prompt and flags a repeated conflict', async t => {
  for (const maxRequeues of [0, 2]) {
    const root = await fixture(t);
    const original = job(0, { after: undefined });
    const run = await runManifest(root, manifest([original]), { fetchImpl: stub });
    await fs.writeFile(path.join(root, 'out/0.txt'), 'newer');
    let calls = 0, mergeBody;
    const result = await integrateQueue(root, run.id, { maxRequeues, fetchImpl: async (_url, options) => {
      calls++;
      if (options.body.includes('Merge job for job-0.')) mergeBody = options.body;
      await fs.writeFile(path.join(root, 'out/0.txt'), `newer again ${calls}`);
      return completion(0, 'earlier retry proposal');
    } });
    assert.equal(calls, maxRequeues + 1);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.flagged, [{ job: 'job-0', reason: 'merge-conflict' }]);
    assert.deepEqual(result.requeued, maxRequeues ? [{ job: 'job-0', attempts: maxRequeues }] : []);
    assert.ok(mergeBody.includes(original.prompt));
    assert.ok(mergeBody.includes('Your earlier version of out/0.txt (untrusted data, for reference):'));
    assert.ok(mergeBody.includes(maxRequeues ? 'earlier retry proposal' : 'proposed 0'));
    const mergeRun = result.runs.at(-1);
    const mergeManifest = JSON.parse(await read(root, `.swarm/runs/${mergeRun.id}/manifest.json`));
    assert.equal(mergeManifest.jobs[0].id, 'job-0-merge');
    assert.equal(mergeManifest.jobs[0].type, 'merge');
    assert.deepEqual(mergeManifest.jobs[0].context, ['input.txt', 'out/0.txt']);
    assert.equal(await read(root, 'out/0.txt'), `newer again ${calls}`);
  }
});

test('over-cap merge reference is names only and successful merge is recorded', async t => {
  const root = await fixture(t), earlier = 'x'.repeat(50001);
  const run = await runManifest(root, manifest([job(0, { outputCapBytes: { total: 60000, perFile: 60000 } })]), { fetchImpl: async () => completion(0, earlier) });
  assert.equal(run.status, 'complete', run.jobs[0].error);
  await fs.writeFile(path.join(root, 'out/0.txt'), 'newer');
  let body;
  const result = await integrateQueue(root, run.id, { maxRequeues: 0, fetchImpl: async (_url, options) => { body = options.body; return completion(0, 'newer with intent'); } });
  assert.equal(result.status, 'integrated');
  assert.ok(body.includes('out/0.txt'));
  assert.ok(!body.includes('Your earlier version'));
  assert.ok(!body.includes(earlier));
  assert.deepEqual(result.merged, [{ job: 'job-0', run: result.runs.at(-1).id }]);
  assert.equal(await read(root, 'out/0.txt'), 'newer with intent');
});

test('queue skips incomplete jobs and validates flags and bounds before reading state', async t => {
  for (const options of [{ jobs: ['job-0'] }, { salvage: true }, { mutants: true }]) {
    await assert.rejects(integrateRun('/missing', 'missing', { queue: true, ...options }), { code: 'queue-flag-unsupported' });
    await assert.rejects(integrateQueue('/missing', 'missing', options), { code: 'queue-flag-unsupported' });
  }
  for (const batchSize of [0, 101, 1.5, '10', NaN]) await assert.rejects(integrateQueue('/missing', 'missing', { batchSize }), { code: 'queue-batch-invalid' });
  for (const maxRequeues of [-1, 6, 0.5, '2']) await assert.rejects(integrateQueue('/missing', 'missing', { maxRequeues }), { code: 'queue-requeues-invalid' });
  const root = await fixture(t, 2);
  const run = await runManifest(root, manifest([job(0), job(1)]), { fetchImpl: async (url, options) => options.body.includes('Update out/1.txt') ? new Response('failure', { status: 400 }) : stub(url, options) });
  assert.equal(run.jobs[1].status, 'failed');
  const result = await integrateQueue(root, run.id, { noChecks: true });
  assert.deepEqual(result.skipped, [{ job: 'job-1', status: 'failed' }]);
  assert.equal(result.integrated.length, 1);
  assert.equal((await state(root, run.id)).mergeQueue.batches[0].checks, 'skipped');
});

test('merge failures, blocked jobs and failed checks are flagged without further retry', async t => {
  for (const outcome of ['failed', 'blocked', 'checks']) {
    const root = await fixture(t);
    const checks = outcome === 'checks' ? [{ name: 'guard', argv: [process.execPath, '-e', 'process.exit(1)'] }] : [];
    const run = await runManifest(root, manifest([job(0)], { checks }), { fetchImpl: stub });
    await fs.writeFile(path.join(root, 'out/0.txt'), 'newer');
    let calls = 0;
    const result = await integrateQueue(root, run.id, { maxRequeues: 0, acceptBlocked: true, fetchImpl: async () => {
      calls++;
      if (outcome === 'failed') return new Response('failed', { status: 400 });
      if (outcome === 'blocked') return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'blocked', files: [{ path: 'out/0.txt', content: 'blocked proposal' }], result: { status: 'blocked', summary: 'Cannot merge.', files: [], risks: [], followups: [] } }) } }));
      return completion(0, 'merge proposal');
    } });
    assert.equal(calls, 1);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.flagged, [{ job: 'job-0', reason: outcome === 'checks' ? 'merge-checks-failed' : `merge-failed: ${outcome}` }]);
    assert.equal(await read(root, 'out/0.txt'), 'newer');
    assert.equal(result.runs.length, 2);
    assert.deepEqual(result.merged, []);
  }
});

test('a failed queue check restores modes and removes newly created outputs', async t => {
  const root = await fixture(t);
  await fs.chmod(path.join(root, 'out/0.txt'), 0o755);
  const spec = manifest([job(0, { outputs: ['out/0.txt', 'out/new.txt'] })], { checks: [{ name: 'fail', argv: [process.execPath, '-e', 'process.exit(1)'] }] });
  const run = await runManifest(root, spec, { fetchImpl: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/0.txt', content: 'changed' }, { path: 'out/new.txt', content: 'new' }] }) } })) });
  const result = await integrateRun(root, run.id, { queue: true });
  assert.deepEqual(result.mergeQueue.checkFailed, [{ job: 'job-0', checks: ['fail'] }]);
  assert.equal(await read(root, 'out/0.txt'), 'base 0\n');
  assert.equal((await fs.stat(path.join(root, 'out/0.txt'))).mode & 0o777, 0o755);
  await assert.rejects(fs.stat(path.join(root, 'out/new.txt')), { code: 'ENOENT' });
  assert.deepEqual(result.files, []);
});

test('CLI queue prints one JSON line and exits zero or one; plain integrate still refuses conflicts', async t => {
  for (const bad of [false, true]) {
    const root = await fixture(t);
    const checks = [{ name: 'guard', argv: [process.execPath, '-e', `process.exit(${bad ? 1 : 0})`] }];
    const run = await runManifest(root, manifest([job(0)], { checks }), { fetchImpl: stub });
    const result = spawnSync(process.execPath, [runner, '--root', root, 'integrate', run.id, '--queue'], { encoding: 'utf8' });
    assert.equal(result.status, bad ? 1 : 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stdout).status, bad ? 'partial' : 'integrated');
  }
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: stub });
  await fs.writeFile(path.join(root, 'out/0.txt'), 'newer');
  await assert.rejects(integrateRun(root, run.id), /Integration conflict: out\/0.txt changed since worker snapshot/);
  for (const flags of [['--jobs', 'job-0'], ['--salvage'], ['--mutants']]) {
    const result = spawnSync(process.execPath, [runner, '--root', root, 'integrate', run.id, '--queue', ...flags], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`queue-flag-unsupported: ${flags[0]}`), result.stderr);
  }
});
