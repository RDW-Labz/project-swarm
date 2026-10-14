// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, validateManifest, validateProject, inspectRun, integrateRun } from '../tools/swarm.mjs';
import { executeApi } from '../tools/api-adapters.mjs';
import { OPENROUTER_MODELS_URL, OPENROUTER_ENDPOINT } from '../tools/openrouter.mjs';

const exec = promisify(execFile);
const env = { OPENAI_API_KEY: 'fake-openai-lane-key', GEMINI_API_KEY: 'fake-gemini-lane-key', SWARM_CONFIG: process.env.SWARM_CONFIG };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const job = (n, agent = 'ollama', overrides = {}) => ({ id: `job-${n}`, agent, model: 'test-model', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 512, jobs, ...overrides });
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function completion(agent, n) {
  const text = JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}\n` }] });
  if (agent === 'openai') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
  if (agent === 'gemini') return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] };
  return { done: true, done_reason: 'stop', message: { content: text } };
}
function requestJob(url, options) {
  const agent = url.includes('generativelanguage') ? 'gemini' : url.includes('api.openai') ? 'openai' : 'ollama';
  const match = /out\/(\d+)\.txt/.exec(options.body);
  assert.ok(match, 'request names its declared output');
  return { agent, n: Number(match[1]) };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lanes-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}

test('500 API jobs respect lane caps, retry 429s, pause quota lanes, and prepare lazily', { timeout: 60000 }, async t => {
  const root = await fixture(t), start = Date.now();
  const caps = { ollama: 4, openai: 8, gemini: 16 };
  const lanes = Object.fromEntries(Object.entries(caps).map(([agent, concurrency]) => [agent, {
    concurrency, backoff: { baseMs: 5, maxMs: 50, maxRetries: 3 }, pauseMs: 300, maxPauseMs: 5000,
  }]));
  const jobs = Array.from({ length: 500 }, (_, n) => job(n, ['ollama', 'openai', 'gemini'][n % 3]));
  const active = { ollama: 0, openai: 0, gemini: 0 }, attempts = new Map();
  let first = true, finishedDuringPause = false;
  const state = await runManifest(root, manifest(jobs, { lanes }), {
    env, id: 'lane-500',
    onState: state => {
      const lane = state.lanes?.lanes.gemini;
      if (lane?.state === 'paused' && state.jobs.some(record => record.status === 'complete' && ['ollama', 'openai'].includes(record.agent) && Date.parse(record.finishedAt) >= Date.parse(lane.until) - 300)) finishedDuringPause = true;
    },
    fetchImpl: async (url, options) => {
      const { agent, n } = requestJob(url, options);
      assert.ok(++active[agent] <= caps[agent], `${agent} cap exceeded`);
      const attempt = (attempts.get(n) ?? 0) + 1; attempts.set(n, attempt);
      try {
        if (first) {
          first = false;
          const workspaces = readdirSync(path.join(root, '.swarm/workspaces/lane-500'));
          assert.ok(workspaces.length <= 28, `prepared ${workspaces.length} workspaces`);
        }
        await sleep(5);
        if (n === 2 && attempt === 1) return new Response('credit exhausted', { status: 402 });
        if (n % 10 === 0 && attempt === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0.005' } });
        return reply(completion(agent, n));
      } finally { active[agent]--; }
    },
  });
  assert.equal(state.jobs.filter(record => record.status === 'complete').length, 499, state.error);
  assert.equal(state.jobs[2].status, 'failed');
  for (let n = 0; n < 500; n += 10) {
    assert.equal(state.jobs[n].status, 'complete');
    assert.equal(state.jobs[n].rateLimitRetries, 1);
    assert.equal(state.jobs[n].attempts.length, 2);
  }
  for (const [agent, cap] of Object.entries(caps)) assert.ok(state.lanes.lanes[agent].peak <= cap);
  assert.ok(state.peakConcurrency <= 28);
  assert.equal(state.peakConcurrency, state.lanes.peakGlobal);
  assert.ok(finishedDuringPause, 'other providers completed during the gemini pause');
  assert.ok(Date.now() - start < 60000);
});

test('auto retries OpenRouter twice then falls back to Claude with three recorded attempts', async t => {
  const root = await fixture(t);
  const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lane-ledger-'));
  t.after(() => fs.rm(logs, { recursive: true, force: true }));
  const auto = job(0, 'auto'); delete auto.model;
  const lanes = { openrouter: { model: 'anthropic/claude-sonnet-5' }, claude: { model: 'sonnet' } };
  const validation = await validateProject(root, manifest([auto], { lanes }), { env });
  assert.equal(validation.routes[0].agent, 'openrouter');
  let calls = 0;
  const state = await runManifest(root, manifest([auto], { lanes }), {
    env: { ...env, OPENROUTER_API_KEY: 'sk-or-fake-lanes-key', SWARM_LOGS_DIR: logs },
    fetchImpl: async url => {
      if (url === OPENROUTER_MODELS_URL) return reply({ data: [{ id: lanes.openrouter.model, pricing: { prompt: '0.000002', completion: '0.00001' } }] });
      assert.equal(url, OPENROUTER_ENDPOINT); calls++;
      return new Response('private upstream details', { status: 500 });
    },
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/0.txt','done'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'complete'}));"], options),
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(calls, 2);
  assert.equal(state.jobs[0].lane, 'claude');
  assert.deepEqual(state.jobs[0].attempts.map(attempt => attempt.agent), ['openrouter', 'openrouter', 'claude']);
  assert.match(state.jobs[0].route.reason, /fallback after 2 failures on openrouter/);
  const inspection = await inspectRun(root, state.id);
  assert.equal(inspection.jobs[0].agent, 'claude');
  assert.equal(inspection.files[0].status, 'ready');
  await integrateRun(root, state.id);
  assert.equal(await fs.readFile(path.join(root, 'out/0.txt'), 'utf8'), 'done');
});

test('manifest accepts 5000 jobs and concurrency 512 and refuses invalid lanes and routes', async t => {
  const jobs = Array.from({ length: 5000 }, (_, n) => job(n, 'ollama', { outputs: [] }));
  assert.equal(validateManifest(manifest(jobs)).jobs.length, 5000);
  assert.throws(() => validateManifest(manifest([...jobs, job(5000)])), /1–5000/);
  assert.throws(() => validateManifest(manifest(jobs, { concurrency: 513 })), /1–512/);
  assert.throws(() => validateManifest(manifest([job(0, 'openrouter', { sensitive: true })])), { code: 'sensitive-openrouter' });
  assert.throws(() => validateManifest(manifest([job(0, 'auto')])), { code: 'auto-model-forbidden' });
  assert.throws(() => validateManifest(manifest([job(0)], { lanes: { ollama: { concurrency: 0 } } })), { code: 'lanes-invalid' });
  const root = await fixture(t), auto = job(0, 'auto'); delete auto.model;
  await assert.rejects(validateProject(root, manifest([auto]), { env }), { code: 'route-exhausted' });
  const result = await validateProject(root, manifest([auto], { lanes: { claude: { model: 'sonnet' } } }), { env });
  assert.deepEqual(result.routes, [{ jobId: auto.id, agent: 'claude', model: 'sonnet', reason: 'cheapest healthy lane' }]);
});

test('auto quota exhaustion routes around the paused lane and counts one failed attempt', async t => {
  const root = await fixture(t), auto = job(0, 'auto'); delete auto.model;
  const lanes = { openrouter: { model: 'anthropic/claude-sonnet-5', pauseMs: 300 }, claude: { model: 'sonnet' } };
  const state = await runManifest(root, manifest([auto], { lanes }), {
    env: { ...env, OPENROUTER_API_KEY: 'sk-or-fake-quota-key', SWARM_LOGS_DIR: root },
    fetchImpl: async url => {
      if (url === OPENROUTER_MODELS_URL) return reply({ data: [{ id: lanes.openrouter.model, pricing: { prompt: '0.000002', completion: '0.00001' } }] });
      assert.equal(url, OPENROUTER_ENDPOINT);
      return new Response('credit exhausted', { status: 402 });
    },
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; fs.mkdirSync('out',{recursive:true}); fs.writeFileSync('out/0.txt','done'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'complete'}));"], options),
  });
  assert.equal(state.status, 'complete', state.error);
  assert.deepEqual(state.jobs[0].attempts.map(attempt => attempt.agent), ['openrouter', 'claude']);
  assert.equal(state.jobs[0].routeFailures.openrouter, 1);
});

test('a context change after run start fails a queued job before another request', async t => {
  const root = await fixture(t); let calls = 0;
  const state = await runManifest(root, manifest([job(0), job(1, 'ollama', { after: ['job-0'] })], { concurrency: 1 }), {
    env, fetchImpl: async () => {
      calls++;
      await fs.writeFile(path.join(root, 'input.txt'), 'changed after snapshot');
      return reply(completion('ollama', 0));
    },
  });
  assert.equal(calls, 1);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[1].status, 'failed');
  assert.equal(state.jobs[1].error, 'snapshot-changed: input.txt');
});

test('200 short API jobs coalesce state.json writes', async t => {
  const root = await fixture(t); let writes = 0;
  const rename = fs.rename;
  fs.rename = async (...args) => {
    if (args[1].startsWith(root + path.sep) && args[1].endsWith('/state.json')) writes++;
    return rename(...args);
  };
  t.after(() => { fs.rename = rename; });
  const state = await runManifest(root, manifest(Array.from({ length: 200 }, (_, n) => job(n))), {
    env, fetchImpl: async (url, options) => { const { agent, n } = requestJob(url, options); return reply(completion(agent, n)); },
  });
  assert.equal(state.status, 'complete', state.error);
  assert.ok(writes < 80, `${writes} state writes for 200 jobs`);
});

test('a pause beyond maxPauseMs refuses queued jobs while another lane completes', async t => {
  const root = await fixture(t); const calls = [];
  const state = await runManifest(root, manifest([job(0, 'gemini'), job(1, 'gemini'), job(2)], {
    lanes: { gemini: { concurrency: 1, pauseMs: 300, maxPauseMs: 5 } },
  }), {
    env, fetchImpl: async (url, options) => {
      const { agent, n } = requestJob(url, options); calls.push(n);
      return n === 0 ? new Response('quota', { status: 402 }) : reply(completion(agent, n));
    },
  });
  assert.deepEqual(calls.sort(), [0, 2]);
  assert.deepEqual(state.jobs.map(record => record.status), ['failed', 'provider-limit', 'complete']);
  assert.match(state.jobs[1].error, /^provider-limit: lane gemini paused until /);
  assert.equal(state.jobs[1].attempts.length, 0);
});

test('exhausted rate-limit retries fail with a stable prefix', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest([job(0)], { lanes: { ollama: { backoff: { maxRetries: 0 } } } }), {
    env, fetchImpl: async () => new Response('rate limited', { status: 429 }),
  });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /^rate-limited: Provider HTTP 429/);
  assert.equal(state.jobs[0].rateLimitRetries, 0);
  assert.equal(state.jobs[0].attempts.length, 1);
});

test('auto dependency jobs skip worktree-only lanes and receive completed dependency outputs', async t => {
  const root = await fixture(t), auto = job(1, 'auto', { after: ['job-0'] }); delete auto.model;
  const spec = manifest([job(0), auto], { lanes: { codex: { model: 'gpt-5.4' }, claude: { model: 'sonnet' } } });
  const validation = await validateProject(root, spec, { env });
  assert.equal(validation.routes[0].agent, 'claude');
  const state = await runManifest(root, spec, {
    env, fetchImpl: async () => reply(completion('ollama', 0)),
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', "import fs from 'node:fs'; if(fs.readFileSync('out/0.txt','utf8') !== 'output 0\\n') process.exit(9); fs.writeFileSync('out/1.txt','dependency copied'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'complete'}));"], options),
  });
  assert.equal(state.status, 'complete', state.error);
  assert.equal(state.jobs[1].lane, 'claude');
});

test('HTTP outcome metadata is bounded and never retains an error body', async () => {
  const secret = 'private-provider-body';
  for (const [status, body, quotaExhausted] of [[402, secret, true], [429, 'insufficient_quota ' + secret, true], [429, secret, false], [500, 'x'.repeat(4096) + 'credit', false]]) {
    const result = await executeApi(job(0, 'openai'), [], { env, fetchImpl: async () => new Response(body, { status, headers: { 'retry-after': '1.5' } }) });
    assert.equal(result.httpStatus, status);
    assert.equal(result.retryAfterMs, 1500);
    assert.equal(result.quotaExhausted, quotaExhausted);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.error, `Provider HTTP ${status}; response body omitted to protect credentials and source`);
  }
  const date = new Date(Date.now() + 10000).toUTCString();
  const result = await executeApi(job(0, 'openai'), [], { env, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': date } }) });
  assert.ok(result.retryAfterMs > 0 && result.retryAfterMs <= 10000);
});
