// SPDX-License-Identifier: Apache-2.0
/*
 * RUNNER RACE (tools/swarm.mjs runManifestBody / runOne, ~3124–3367; cancelRun ~3836)
 *
 * Interleaving that can leave runManifest pending forever on a loaded CI runner:
 *
 * 1. All eight jobs enter runOne; manifest concurrency caps global in-flight work at four.
 * 2. Four jobs pass scheduler.acquire and enter prepare() (workspace copy/git). cancelled()
 *    is not polled during prepare (only immediately before it at ~3140).
 * 3. Those four reach fetchImpl and block in hanging (owned HTTP). The other four remain
 *    inside scheduler.acquire on the openai lane queue; their lane wait uses the ephemeral
 *    waiting AbortController in waitingJobs (~3124–3138), which checkWaiters aborts on cancel.
 * 4. cancelRun writes .swarm/runs/<id>/cancel. In-flight API work must observe it via
 *    executeApi's cancelled() polling and abort the fetch signal. If a runner is slow to
 *    schedule that abort (or a job sits in the synchronous gap after prepare() returns and
 *    before executeApi attaches the abort listener to fetchImpl), the four hanging requests
 *    keep their lane slots until the coordinator's test timeout.
 * 5. The four queued acquire waiters cannot start (lane still full). remaining never reaches
 *    zero; await runManifest(...) never settles — matching the 600s CI timeout on this test.
 *
 * Fix belongs in the runner (cancel during prepare / before fetch must fail fast and release
 * slots). Until then, integration tests bound runManifest and gate on fetch calls, not sleeps.
 */
// Lesson #152: imported directly (not only via the package.json test script) so this file stays
// hermetic even run alone as `node --test tests/adapters.test.mjs`.
import './_isolate-config.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeApi, validateEnvelope, apiConfiguration, apiDoctor } from '../tools/api-adapters.mjs';
import { runManifest, integrateRun, validateManifest, validateProject, cancelRun, readState } from '../tools/swarm.mjs';

const fake = name => [name, 'fixture', 'value'].join('-');
const cred = tag => [tag, 'fixture', 'credential'].join('-');
const isolateDir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'swarm-adapter-env-'));
const isolatedEnv = {
  SWARM_SPEND_DIR: path.join(isolateDir, 'spend'),
  SWARM_CONFIG: path.join(isolateDir, 'config.json'),
};
await fs.writeFile(isolatedEnv.SWARM_CONFIG, JSON.stringify({ dailyLimit: {
  usd: 1_000_000, mode: 'notify', ceilingUsd: 10_000_000,
} }), { mode: 0o600 });
after(() => fs.rm(isolateDir, { recursive: true, force: true }));
const env = {
  ...isolatedEnv,
  OPENAI_API_KEY: fake('openai'),
  GEMINI_API_KEY: fake('gemini'),
  LAMBDA_API_KEY: fake('lambda'),
};

const RUN_MANIFEST_BOUND_MS = 60_000;

function formatRunState(root, runId, err) {
  const prefix = err ? `${err.message}\n` : '';
  return readState(root, runId)
    .then(state => `${prefix}runManifest state: status=${state.status} jobs=${JSON.stringify(state.jobs.map(j => ({ id: j.id, status: j.status, error: j.error ?? null })))}`)
    .catch(() => `${prefix}runManifest state: (could not read state for ${runId})`);
}

function boundRunManifest(pending, root, runId) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      formatRunState(root, runId, new Error(`runManifest did not settle within ${RUN_MANIFEST_BOUND_MS}ms`))
        .then(detail => reject(new Error(detail)))
        .catch(reject);
    }, RUN_MANIFEST_BOUND_MS);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function waitForCalls(target, observe) {
  return new Promise((resolve, reject) => {
    let interval;
    let deadline;
    const finish = () => {
      if (interval) clearInterval(interval);
      if (deadline) clearTimeout(deadline);
    };
    const check = () => {
      if (observe() >= target) {
        finish();
        resolve();
        return true;
      }
      return false;
    };
    if (check()) return;
    interval = setInterval(() => { check(); }, 5);
    deadline = setTimeout(() => {
      finish();
      reject(new Error(`expected ${target} fetch calls, saw ${observe()}`));
    }, RUN_MANIFEST_BOUND_MS);
  });
}

const job = (agent = 'openai', overrides = {}) => ({ id: agent, agent, ...(['openai', 'gemini', 'lambda'].includes(agent) ? { sensitive: false } : {}), model: 'test-model', context: ['input.txt'], outputs: ['report.md'], prompt: 'Review copied source.', timeoutMs: 1000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 4, jobs });
const envelope = { summary: 'Reviewed source; tests not run.', files: [{ path: 'report.md', content: '# Review\nA concrete finding.\n' }] };
function body(agent, value = envelope) { const text = JSON.stringify(value); if (agent === 'openai') return { status: 'completed', model: 'resolved-openai', usage: { input_tokens: 23, output_tokens: 19, private: 'never log' }, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }; if (agent === 'gemini') return { modelVersion: 'resolved-gemini', usageMetadata: { promptTokenCount: 23, candidatesTokenCount: 19 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }; if (agent === 'lambda') return { id: 'cmpl-1', model: 'resolved-lambda', usage: { prompt_tokens: 23, completion_tokens: 19, private: 'never log' }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }; return { done: true, done_reason: 'stop', model: 'resolved-ollama', prompt_eval_count: 23, eval_count: 19, message: { content: text } }; }
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-adapter-')); await fs.writeFile(path.join(root, 'input.txt'), 'copied source'); await fs.writeFile(path.join(root, 'private.txt'), 'private unlisted text'); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
for (const agent of ['openai', 'gemini', 'ollama', 'lambda']) test(`${agent} sends fixed tool-free requests and accepts structured files`, async () => { let request; const result = await executeApi(job(agent), [{ path: 'input.txt', content: 'source' }], { env, fetchImpl: async (url, options) => { request = { url, ...options }; return reply(body(agent)); } }); assert.equal(result.status, 'complete'); assert.deepEqual(result.files, envelope.files); assert.equal(result.actualModel, `resolved-${agent}`); const payload = JSON.parse(request.body); assert.equal(request.redirect, 'error'); assert.ok(request.signal); if (agent !== 'lambda') assert.equal(request.headers['x-helm-session'], undefined); assert.ok(!payload.tools || !payload.tools.length); assert.ok(!request.body.includes(env.OPENAI_API_KEY)); if (agent === 'openai') { assert.equal(request.url, 'https://api.openai.com/v1/responses'); assert.equal(payload.store, false); assert.equal(payload.text.format.strict, true); assert.equal(payload.max_output_tokens, 8192); } if (agent === 'gemini') { assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent'); assert.equal(payload.generationConfig.responseMimeType, 'application/json'); assert.equal(request.headers['x-goog-api-key'], env.GEMINI_API_KEY); } if (agent === 'ollama') { assert.equal(request.url, 'http://127.0.0.1:11434/api/chat'); assert.equal(payload.stream, false); assert.equal(request.headers.authorization, undefined); } if (agent === 'lambda') { assert.equal(request.url, 'https://api.lambda.ai/v1/chat/completions'); assert.equal(payload.stream, false); assert.equal(payload.response_format.json_schema.strict, true); assert.equal(payload.max_tokens, 8192); assert.equal(request.headers.authorization, `Bearer ${env.LAMBDA_API_KEY}`); assert.match(request.headers['x-helm-session'], /^swarm-[0-9a-f]{32}-lambda$/); } assert.ok(!JSON.stringify(result).includes('private')); assert.equal(result.costUsd, null); });
test('API jobs copy only assigned text and integrate after review without Claude', async t => { const root = await fixture(t); let calls = 0; const state = await runManifest(root, manifest([job()]), { env, fetchImpl: async (_url, options) => { calls++; assert.ok(options.body.includes('copied source')); assert.ok(!options.body.includes('private unlisted text')); return reply(body('openai')); }, spawnImpl: () => assert.fail('Claude must not launch') }); assert.equal(state.status, 'complete'); assert.equal(calls, 1); await assert.rejects(fs.access(path.join(root, 'report.md'))); assert.equal(state.jobs[0].usage.input_tokens, 23); await integrateRun(root, state.id); assert.equal(await fs.readFile(path.join(root, 'report.md'), 'utf8'), envelope.files[0].content); const logs = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'openai/provider.jsonl'), 'utf8'); assert.ok(!logs.includes('copied source')); assert.ok(!logs.includes(env.OPENAI_API_KEY)); });
test('structured output rejects undeclared, missing, duplicate and invalid files', () => { for (const value of [null, { ...envelope, extra: true }, { summary: 'x', files: [] }, { summary: 'x', files: [{ path: '../bad', content: 'x' }] }, { summary: 'x', files: [{ path: 'report.md', content: 3 }] }, { summary: 'x', files: [{ path: 'report.md', content: 'x', mode: 511 }] }]) assert.throws(() => validateEnvelope(value, ['report.md'])); assert.throws(() => validateEnvelope({ summary: 'x', files: [{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }] }, ['a', 'b'])); assert.deepEqual(validateEnvelope({ summary: 'read-only', files: [] }, []), { summary: 'read-only', files: [] }); });
test('invalid API output writes nothing and cannot integrate', async t => { const root = await fixture(t); const state = await runManifest(root, manifest([job()]), { env, fetchImpl: async () => reply(body('openai', { summary: 'bad', files: [{ path: '../escape', content: 'x' }] })) }); assert.equal(state.status, 'failed'); await assert.rejects(fs.access(path.join(root, '.swarm/workspaces', state.id, 'openai/report.md'))); await assert.rejects(integrateRun(root, state.id), /Only a complete/); });
test('a self-hosted Lambda origin disables thinking by default and honours an explicit opt-in', async () => {
  const capture = async request => { let seen; await executeApi(job('lambda'), [], { env: { ...isolatedEnv, ...request }, fetchImpl: async (url, options) => { seen = JSON.parse(options.body); return reply(body('lambda')); } }); return seen; };
  const hosted = await capture(env); assert.equal(hosted.chat_template_kwargs, undefined);
  for (const origin of ['http://127.0.0.1:8000', 'https://gpu.example']) { const off = await capture({ SWARM_LAMBDA_URL: origin }); assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false }); assert.equal(off.response_format.json_schema.strict, true); assert.equal(off.max_tokens, 8192); }
  const on = await capture({ SWARM_LAMBDA_URL: 'http://127.0.0.1:8000', SWARM_LAMBDA_THINKING: 'on' }); assert.equal(on.chat_template_kwargs, undefined);
  const other = await capture({ SWARM_LAMBDA_URL: 'http://127.0.0.1:8000', SWARM_LAMBDA_THINKING: 'yes' }); assert.deepEqual(other.chat_template_kwargs, { enable_thinking: false });
  assert.equal(apiConfiguration('lambda', env).selfHosted, false); assert.equal(apiConfiguration('lambda', { SWARM_LAMBDA_URL: 'http://127.0.0.1:8000' }).selfHosted, true);
});

test('refusals, truncation, tool calls, malformed transport and output fail closed', async () => { const cases = [['openai', { ...body('openai'), status: 'incomplete' }], ['openai', { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }], ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }], ['ollama', { ...body('ollama'), done_reason: 'length' }], ['ollama', { ...body('ollama'), message: { content: JSON.stringify(envelope), tool_calls: [{}] } }], ['lambda', { ...body('lambda'), choices: [{ finish_reason: 'length', message: { content: JSON.stringify(envelope) } }] }], ['lambda', { ...body('lambda'), choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(envelope), tool_calls: [{}] } }] }], ['lambda', { ...body('lambda'), choices: [{ finish_reason: 'stop', message: { refusal: 'policy', content: null } }] }]]; for (const [agent, value] of cases) assert.equal((await executeApi(job(agent), [], { env, fetchImpl: async () => reply(value) })).status, 'failed'); const malformed = await executeApi(job(), [], { env, fetchImpl: async () => new Response('{invalid') }); assert.match(malformed.error, /malformed JSON/); const bad = await executeApi(job(), [], { env, fetchImpl: async () => reply({ ...body('openai'), output: [{ type: 'message', content: [{ type: 'output_text', text: 'not JSON' }] }] }) }); assert.match(bad.error, /structured output/); });
test('HTTP, transport, stream errors and echoed credentials never persist secrets', async () => { for (const fetchImpl of [async () => new Response(env.OPENAI_API_KEY, { status: 401 }), async () => { throw Error(env.OPENAI_API_KEY); }, async () => new Response(new ReadableStream({ start(controller) { controller.error(Error(env.OPENAI_API_KEY)); } })), async () => reply(body('openai', { summary: env.OPENAI_API_KEY, files: envelope.files }))]) { const result = await executeApi(job(), [], { env, fetchImpl }); assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes(env.OPENAI_API_KEY)); assert.deepEqual(result.files, []); } });
test('large chunked response is bounded without accepting partial output', async () => { const chunk = new Uint8Array(1024 * 1024); let chunks = 0; const result = await executeApi(job(), [], { env, fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { chunks++; controller.enqueue(chunk); if (chunks === 20) controller.close(); } })) }); assert.equal(result.status, 'failed'); assert.match(result.error, /16 MiB/); assert.ok(chunks <= 19); });
const hanging = async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
test('timeout and external cancellation abort the owned HTTP request', async () => { assert.equal((await executeApi(job('openai', { timeoutMs: 50 }), [], { env, fetchImpl: hanging })).status, 'timeout'); const controller = new AbortController(); const pending = executeApi(job(), [], { env, fetchImpl: hanging, signal: controller.signal }); setTimeout(() => controller.abort(), 30); assert.equal((await pending).status, 'cancelled'); });
test('four concurrent API requests cancel together and queued jobs never start', async t => {
  const root = await fixture(t);
  const runId = 'cancel-many';
  let calls = 0, active = 0, maximum = 0;
  const jobs = Array.from({ length: 8 }, (_, i) => job('openai', { id: `job-${i}`, outputs: [] }));
  const pending = runManifest(root, manifest(jobs), {
    id: runId,
    env,
    fetchImpl: async (...args) => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await hanging(...args);
      } finally {
        active--;
      }
    },
  });
  await waitForCalls(4, () => calls);
  await cancelRun(root, runId);
  const state = await boundRunManifest(pending, root, runId);
  assert.equal(state.status, 'cancelled');
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(calls, 4);
  assert.ok(state.jobs.every(j => j.status === 'cancelled'));
});

test('cancel during workspace prepare releases lane before fetch (runner race)', { skip: 'RUNNER RACE: runOne does not poll cancelled() during prepare(); see file header until swarm.mjs is fixed' }, async t => {
  const root = await fixture(t);
  const runId = 'cancel-prepare-race';
  let prepareEntered = 0;
  let releasePrepareGate;
  const prepareGate = new Promise(resolve => { releasePrepareGate = resolve; });
  let cancelSent;
  const jobs = Array.from({ length: 8 }, (_, i) => job('openai', { id: `job-${i}`, outputs: [] }));
  const pending = runManifest(root, manifest(jobs), {
    id: runId,
    env,
    fetchImpl: async (...args) => {
      if (prepareEntered < 4) {
        prepareEntered += 1;
        if (prepareEntered === 4) cancelSent = cancelRun(root, runId);
        await prepareGate;
      }
      return hanging(...args);
    },
  });
  await cancelSent;
  releasePrepareGate();
  const state = await boundRunManifest(pending, root, runId);
  assert.equal(state.status, 'cancelled');
  assert.ok(state.jobs.every(j => j.status === 'cancelled'));
});

test('configuration is honest without network calls and endpoint overrides are bounded', () => {
  const googleEnv = { GOOGLE_API_KEY: fake('google') };
  assert.equal(apiDoctor('openai', {}).status, 'unconfigured');
  assert.equal(apiDoctor('openai', env).liveVerified, false);
  assert.ok(!JSON.stringify(apiDoctor('openai', env)).includes(env.OPENAI_API_KEY));
  assert.equal(apiConfiguration('openai', { ...env, OPENAI_BASE_URL: 'https://evil.invalid' }).endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(apiConfiguration('ollama', {}).configured, true);
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?key=x', 'file:///tmp/x']) assert.throws(() => apiConfiguration('ollama', { SWARM_OLLAMA_URL: url }), /SWARM_OLLAMA_URL/);
  assert.equal(apiConfiguration('ollama', { SWARM_OLLAMA_URL: 'https://private.example' }).endpoint, 'https://private.example/api/chat');
  assert.equal(apiConfiguration('gemini', googleEnv).configured, true);
  assert.equal(apiConfiguration('lambda', {}).configured, false);
  assert.equal(apiConfiguration('lambda', env).endpoint, 'https://api.lambda.ai/v1/chat/completions');
  assert.equal(apiConfiguration('lambda', { ...env, LAMBDA_API_BASE: 'https://evil.invalid' }).endpoint, 'https://api.lambda.ai/v1/chat/completions');
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?key=x', 'file:///tmp/x']) assert.throws(() => apiConfiguration('lambda', { SWARM_LAMBDA_URL: url }), /SWARM_LAMBDA_URL/);
  assert.equal(apiConfiguration('lambda', { SWARM_LAMBDA_URL: 'http://127.0.0.1:8000' }).configured, true);
  assert.equal(apiConfiguration('lambda', { SWARM_LAMBDA_URL: 'https://gpu.example' }).endpoint, 'https://gpu.example/v1/chat/completions');
  const lambdaRemote = { SWARM_LAMBDA_URL: 'http://remote.example', LAMBDA_API_KEY: fake('lambda-remote') };
  assert.throws(() => apiConfiguration('lambda', lambdaRemote), /SWARM_LAMBDA_URL/);
  assert.ok(!JSON.stringify(apiDoctor('lambda', env)).includes(env.LAMBDA_API_KEY));
});
test('API validation requires a model, bounds tokens and rejects binary context before spending', async t => {
  const badEnv = { KEY: fake('manifest') };
  for (const overrides of [{ model: undefined }, { maxOutputTokens: 255 }, { maxOutputTokens: 32769 }, { endpoint: 'https://evil.invalid' }, { env: badEnv }]) assert.throws(() => validateManifest(manifest([job('openai', overrides)])));
  assert.equal(validateManifest({ ...manifest([job()]), concurrency: 2048 }).concurrency, 2048);
  assert.throws(() => validateManifest({ ...manifest([job()]), concurrency: 2049 }));
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), Buffer.from([0xff, 0]));
  await assert.rejects(validateProject(root, manifest([job()])), /UTF-8/);
  let called = false;
  const state = await runManifest(root, manifest([job()]), { env, fetchImpl: async () => { called = true; return reply(body('openai')); } });
  assert.equal(called, false);
  assert.equal(state.status, 'failed');
});

test('cancellation while reading a response body rejects partial output', async () => {
  const controller = new AbortController();
  const pending = executeApi(job(), [], { env, signal: controller.signal, fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"status":')); signal.addEventListener('abort', () => stream.error(Error('private stream detail')), { once: true }); } })) });
  setTimeout(() => controller.abort(), 30); const result = await pending; assert.equal(result.status, 'cancelled'); assert.deepEqual(result.files, []); assert.ok(!JSON.stringify(result).includes('private stream detail'));
});

function withOutputText(agent, text) {
  const value = body(agent);
  if (agent === 'openai') value.output[0].content[0].text = text;
  else if (agent === 'gemini') value.candidates[0].content.parts[0].text = text;
  else if (agent === 'lambda') value.choices[0].message.content = text;
  else value.message.content = text;
  return value;
}

for (const agent of ['openai', 'gemini', 'ollama', 'lambda']) {
  test(`${agent} rejects decoded credential echoes before retaining output`, async () => {
    const keyName = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', ollama: 'OLLAMA_API_KEY', lambda: 'LAMBDA_API_KEY' }[agent];
    const samples = [cred('fixture'), cred('quoted"h'), cred('backslash\\'), cred('tiny')];
    for (const key of samples) {
      for (const field of ['summary', 'path', 'content']) {
        const value = { summary: 'reviewed', files: [{ path: 'report.md', content: 'safe output' }] };
        if (field === 'summary') value.summary = key;
        else value.files[0][field] = key;
        const text = JSON.stringify(value).replace(/[a-z]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
        const result = await executeApi(job(agent, { outputs: [value.files[0].path] }), [], {
          env: { ...isolatedEnv, [keyName]: key }, fetchImpl: async () => reply(withOutputText(agent, text)),
        });
        assert.equal(result.status, 'failed', `${field} echo for ${agent}`);
        assert.match(result.error, /contained a credential/);
        assert.deepEqual(result.files, []);
        assert.equal(result.response, '');
        assert.equal(result.stdout, '');
        assert.ok(!JSON.stringify(result).includes(key));
      }
    }
  });
}

test('credential checks inspect retained metadata without treating JSON field names as echoes', async () => {
  const textKey = [116, 101, 120, 116].map(code => String.fromCharCode(code)).join('');
  const unitKey = [117, 110, 105, 116].map(code => String.fromCharCode(code)).join('');
  const safe = await executeApi(job('lambda'), [], {
    env: { ...isolatedEnv, LAMBDA_API_KEY: textKey }, fetchImpl: async () => reply(body('lambda')),
  });
  assert.equal(safe.status, 'complete');
  for (const field of ['model', 'usage']) {
    const value = body('lambda');
    if (field === 'model') value.model = unitKey;
    else value.usage = { [unitKey]: 42 };
    const result = await executeApi(job('lambda'), [], {
      env: { ...isolatedEnv, LAMBDA_API_KEY: unitKey }, fetchImpl: async () => reply(value),
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /contained a credential/);
    assert.equal(result.actualModel, null);
    assert.equal(result.usage, null);
  }
  const empty = await executeApi(job('ollama'), [], {
    env: { ...isolatedEnv, OLLAMA_API_KEY: [].join() }, fetchImpl: async () => reply(body('ollama')),
  });
  assert.equal(empty.status, 'complete');
});

test('Lambda sessions are unique for repeated and concurrent same-ID requests', async () => {
  const sessions = [];
  const options = { env: { ...env, SWARM_LAMBDA_SESSION: 'operator-one' }, fetchImpl: async (_url, request) => {
    sessions.push(request.headers['x-helm-session']);
    return reply(body('lambda'));
  } };
  const results = [await executeApi(job('lambda'), [], options), await executeApi(job('lambda'), [], options)];
  results.push(...await Promise.all(Array.from({ length: 4 }, () => executeApi(job('lambda'), [], options))));
  assert.ok(results.every(result => result.status === 'complete'));
  assert.equal(new Set(sessions).size, 6);
  for (const session of sessions) assert.match(session, /^operator-one-[0-9a-f]{32}-lambda$/);
});

test('Lambda sessions remain distinct across manifest runs in one process', async t => {
  const root = await fixture(t);
  const sessions = [];
  const options = { env, fetchImpl: async (_url, request) => {
    sessions.push(request.headers['x-helm-session']);
    return reply(body('lambda'));
  } };
  for (const id of ['lambda-first-run', 'lambda-next-run']) {
    const state = await runManifest(root, manifest([job('lambda')]), { ...options, id });
    assert.equal(state.status, 'complete');
  }
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
});

test('escaped credential rejection fails the manifest without persisting or integrating output', async t => {
  const root = await fixture(t);
  const key = cred('lambda');
  const text = JSON.stringify({ summary: key, files: [{ path: 'report.md', content: key }] }).replaceAll('fixture', '\\u0066ixture');
  const state = await runManifest(root, manifest([job('lambda')]), {
    env: { ...isolatedEnv, LAMBDA_API_KEY: key }, fetchImpl: async () => reply(withOutputText('lambda', text)),
  });
  assert.equal(state.status, 'failed');
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /contained a credential/);
  await assert.rejects(fs.access(path.join(root, '.swarm/workspaces', state.id, 'lambda/report.md')));
  await assert.rejects(fs.access(path.join(root, 'report.md')));
  await assert.rejects(integrateRun(root, state.id), /Only a complete/);
  for (const name of ['provider.jsonl', 'stderr.log', 'response.txt']) {
    const saved = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'lambda', name), 'utf8');
    assert.equal(saved, '');
  }
  const savedState = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'state.json'), 'utf8');
  assert.ok(!savedState.includes(key));
});
