// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, readState, resumeRun, integrateRun, validateManifest } from '../tools/swarm.mjs';
import { rollupRun, renderRollupText } from '../tools/reports.mjs';
import { renderMonitorView } from '../tools/monitor-view.mjs';

const exec = promisify(execFile);
const lead = (letter, area = {}) => ({ id: `lead-${letter}`, agent: 'ollama', model: 'test-model', type: 'lead', prompt: `Plan area ${letter}`, context: ['input.txt'], outputs: [`plans/${letter}.json`], area: { goal: `Build area ${letter}`, scope: [`app/${letter}/`], agents: ['ollama'], concurrency: 4, ...area } });
const worker = (letter, n, extra = {}) => ({ id: `worker-${n}`, agent: 'ollama', model: 'test-model', prompt: `Write app/${letter}/${n}.txt`, context: ['input.txt'], outputs: [`app/${letter}/${n}.txt`], ...extra });
const manifest = jobs => ({ version: 1, concurrency: 5, jobs });
const reply = (file, content) => new Response(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 60, eval_count: 40, message: { content: JSON.stringify({ summary: 'done', files: [{ path: file, content }] }) } }), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-leads-run-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(temp, 'config.json'), '{}');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
}

function workers({ count = 1, mutate = child => child, calls = [], onWorker } = {}) {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    const text = JSON.stringify(body);
    const plan = /Plan area ([a-e])/.exec(text);
    if (plan) {
      const letter = plan[1];
      calls.push(`lead-${letter}`);
      assert.match(text, /concurrency cap/);
      return reply(`plans/${letter}.json`, JSON.stringify(mutate({ version: 1, jobs: Array.from({ length: count }, (_, n) => worker(letter, n)) }, letter)));
    }
    const file = /Write (app\/[a-e]\/\d+\.txt)/.exec(text)?.[1];
    assert.ok(file, text);
    calls.push(file);
    if (onWorker) return onWorker(file, request);
    return reply(file, `output ${file}\n`);
  };
}

test('five leads run 105 workers and integrate child files without plan artifacts', async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest('abcde'.split('').map(letter => lead(letter))), { ...options, fetchImpl: workers({ count: 21 }) });
  assert.equal(state.status, 'complete', JSON.stringify(state));
  assert.equal(state.children.length, 5);
  for (const child of state.children) {
    const childState = await readState(options.root, child.run);
    assert.equal(childState.status, 'complete');
    assert.equal(childState.parentRun, state.id);
    assert.equal(childState.leadJob, child.job);
    assert.equal(childState.jobs.length, 21);
  }
  const rollup = rollupRun(state);
  assert.equal(rollup.leads.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(rollup)) < 4096);
  assert.match(renderRollupText(rollup), /lead lead-a -> .* complete 21\/21 \$0.00/);
  assert.match(renderMonitorView({ ...state, leads: rollup.leads }), /leads  5 \(5 complete, 0 running\)/);
  const result = await integrateRun(options.root, state.id, options);
  assert.equal(result.children.length, 5);
  assert.equal(result.children.flatMap(child => child.files).length, 105);
  for (const letter of 'abcde') {
    for (let n = 0; n < 21; n++) assert.equal(await fs.readFile(path.join(options.root, `app/${letter}/${n}.txt`), 'utf8'), `output app/${letter}/${n}.txt\n`);
    await assert.rejects(fs.stat(path.join(options.root, `plans/${letter}.json`)), { code: 'ENOENT' });
  }
  await assert.rejects(integrateRun(options.root, state.id, options), /already integrated/);
});

for (const [name, mutate, reason] of [
  ['outside output', child => ({ ...child, jobs: [worker('b', 0)] }), 'outside scope'],
  ['nested lead', child => ({ ...child, jobs: [worker('a', 0, { type: 'lead' })] }), 'depth limit 2'],
  ['child checks', child => ({ ...child, checks: [] }), 'checks'],
]) test(`invalid ${name} fails the lead while a sibling completes`, async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest([lead('a'), lead('b')]), { ...options, fetchImpl: workers({ mutate: (child, letter) => letter === 'a' ? mutate(child) : child }) });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /lead-child-invalid/);
  assert.ok(state.jobs[0].error.includes(reason));
  assert.equal(state.jobs[0].childRun, undefined);
  assert.equal(state.jobs[1].status, 'complete', JSON.stringify(state));
  assert.deepEqual(state.children.map(child => child.job), ['lead-b']);
});

test('manifest rejects overlapping lead areas and area on a worker', () => {
  assert.throws(() => validateManifest(manifest([lead('a'), lead('b', { scope: ['app/a/nested/'] })])), { code: 'lead-scope-overlap' });
  assert.throws(() => validateManifest(manifest([worker('a', 0, { area: lead('a').area })])), { code: 'lead-area-invalid' });
  const job = lead('a'); delete job.area;
  assert.throws(() => validateManifest(manifest([job])), { code: 'lead-area-invalid' });
});

test('parent resume raises a child cap without repeating its lead call', async t => {
  const options = await fixture(t), calls = [];
  const state = await runManifest(options.root, manifest([lead('a', { concurrency: 1, budget: { maxTokens: 100 } })]), { ...options, fetchImpl: workers({ count: 3, calls }) });
  assert.equal(state.status, 'paused', JSON.stringify(state));
  assert.equal(state.jobs[0].heldReason, 'child-paused');
  const resumed = await resumeRun(options.root, state.id, { ...options, fetchImpl: workers({ count: 3, calls }), raises: [{ key: 'maxTokens', value: 1000 }], reason: 'finish approved work' });
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed));
  assert.equal(calls.filter(call => call === 'lead-a').length, 1);
  assert.equal(calls.length, 4);
  assert.equal((await readState(options.root, resumed.jobs[0].childRun)).status, 'complete');
});

test('a larger parent cap does not lift a child area budget', async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest([lead('a', { concurrency: 1, budget: { maxTokens: 100 } })]), { ...options, maxTokens: 1000000, fetchImpl: workers({ count: 3 }) });
  assert.equal(state.status, 'paused', JSON.stringify(state));
  assert.equal((await readState(options.root, state.jobs[0].childRun)).budget.maxTokens, 100);
});

test('parent AbortSignal cancels running children', async t => {
  const options = await fixture(t), controller = new AbortController();
  const state = await runManifest(options.root, manifest([lead('a')]), { ...options, signal: controller.signal, fetchImpl: workers({ onWorker: async (_file, request) => {
    controller.abort();
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } }) });
  const child = await readState(options.root, state.jobs[0].childRun);
  assert.equal(child.status, 'cancelled', JSON.stringify(child));
  assert.match(state.jobs[0].error, /lead-child-cancelled/);
});
