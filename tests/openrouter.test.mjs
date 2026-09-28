// SPDX-License-Identifier: Apache-2.0
// OpenRouter worker pool (decisions #226-#228): data_collection deny on every request,
// anthropic/* pinned to Anthropic, deepseek/* bookkeeping only, $5/job and $25/day caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeApi, apiConfiguration, apiDoctor } from '../tools/api-adapters.mjs';
import { validateManifest } from '../tools/swarm.mjs';
import { providerPolicy, assertRequestBody, nonBookkeepingOutputs, readOpenRouterKey, spentSoFar, worstCaseUsd, OPENROUTER_ENDPOINT, OPENROUTER_MODELS_URL } from '../tools/openrouter.mjs';

const KEY = 'sk-or-FAKE-0000-0000-0000';
const envelope = { summary: 'Wrote the payload; tests not run.', files: [{ path: 'coordination/x-pr-create.json', content: '{"title":"t"}\n' }] };
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const completion = (value = envelope, extra = {}) => ({ id: 'gen-1', model: 'resolved-model', provider: 'Anthropic', usage: { prompt_tokens: 40, completion_tokens: 20, cost: 0.0123 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }], ...extra });
const models = { data: [
  { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000002', completion: '0.00001' } },
  { id: 'deepseek/deepseek-v4.1-flash', pricing: { prompt: '0.000000014', completion: '0.0000004' } },
  { id: 'pricey/model', pricing: { prompt: '0.01', completion: '0.01' } },
] };
const job = overrides => ({ id: 'or-job', agent: 'openrouter', model: 'anthropic/claude-sonnet-5', context: ['input.txt'], outputs: ['coordination/x-pr-create.json'], prompt: 'Write the payload.', timeoutMs: 2000, ...overrides });

async function logsDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-openrouter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function transport(onChat, { pricing = models } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === OPENROUTER_MODELS_URL) return reply(pricing);
    if (url === OPENROUTER_ENDPOINT) return onChat(JSON.parse(options.body), options);
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

test('every request carries data_collection deny; anthropic models pin the Anthropic provider with no fallback', async t => {
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await logsDir(t) };
  let sent, headers;
  const { fetchImpl } = transport((body, options) => { sent = body; headers = options.headers; return reply(completion()); });
  const result = await executeApi(job(), [{ path: 'input.txt', content: 'source' }], { env, fetchImpl });
  assert.equal(result.status, 'complete', result.error);
  assert.equal(sent.provider.data_collection, 'deny');
  assert.deepEqual(sent.provider.order, ['anthropic']);
  assert.equal(sent.provider.allow_fallbacks, false);
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(result.costUsd, 0.0123);
  assert.ok(!JSON.stringify(result).includes(KEY), 'the key never appears in a result');
});

test('a non-anthropic model still denies data collection and is not pinned', () => {
  const policy = providerPolicy('deepseek/deepseek-v4.1-flash');
  assert.equal(policy.data_collection, 'deny');
  assert.equal(policy.order, undefined);
});

test('a request body without data_collection deny is refused before anything is sent', () => {
  assert.throws(() => assertRequestBody({ model: 'x/y', provider: {} }), /data_collection must be "deny"/);
  assert.throws(() => assertRequestBody({ model: 'x/y', provider: { data_collection: 'allow' } }), /data_collection must be "deny"/);
  assert.throws(() => assertRequestBody({ model: 'x/y' }), /data_collection must be "deny"/);
  assert.throws(() => assertRequestBody({ model: 'anthropic/claude-sonnet-5', provider: { data_collection: 'deny', order: ['anthropic'], allow_fallbacks: true } }), /must pin/);
  assert.throws(() => assertRequestBody({ model: 'anthropic/claude-sonnet-5', provider: { data_collection: 'deny', order: ['other', 'anthropic'], allow_fallbacks: false } }), /must pin/);
  assert.doesNotThrow(() => assertRequestBody({ model: 'anthropic/claude-sonnet-5', provider: providerPolicy('anthropic/claude-sonnet-5') }));
});

test('deepseek models may write bookkeeping files only, refused at validate and at run with no request sent', async t => {
  assert.deepEqual(nonBookkeepingOutputs('deepseek/deepseek-v4.1-flash', ['coordination/t47-pr-create.json', 'CHANGELOG.md', '.swarm-manifests/t47-mutants.json', 'coordination/swarm-metrics.md']), []);
  assert.deepEqual(nonBookkeepingOutputs('deepseek/deepseek-v4.1-flash', ['src/gates/secrets_port.py', 'CHANGELOG.md']), ['src/gates/secrets_port.py']);
  assert.deepEqual(nonBookkeepingOutputs('anthropic/claude-sonnet-5', ['src/gates/secrets_port.py']), [], 'Claude tiers may write code');
  const manifest = { version: 1, concurrency: 1, jobs: [job({ model: 'deepseek/deepseek-v4.1-flash', outputs: ['tools/ship.mjs'] })] };
  assert.throws(() => validateManifest(manifest), /bookkeeping jobs only.*tools\/ship\.mjs/);
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await logsDir(t) };
  const { fetchImpl, calls } = transport(() => reply(completion()));
  const result = await executeApi(job({ model: 'deepseek/deepseek-v4.1-flash', outputs: ['src/app.py'] }), [], { env, fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /bookkeeping jobs only/);
  assert.equal(calls.length, 0, 'no pricing or chat request is made');
});

test('spend caps: a request whose worst case would pass $5 for the job or $25 for the day is refused before the chat call', async t => {
  const dir = await logsDir(t);
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: dir };
  const now = () => new Date('2026-09-28T15:00:00Z');
  // Day cap: $24.99 already spent today by other jobs.
  await fs.writeFile(path.join(dir, 'openrouter-spend.jsonl'), `${JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', jobId: 'other', model: 'm', costUsd: 24.99 })}\n${JSON.stringify({ ts: '2026-09-27T10:00:00.000Z', jobId: 'old', model: 'm', costUsd: 100 })}\n`);
  let t1 = transport(() => reply(completion()));
  let result = await executeApi(job(), [{ path: 'input.txt', content: 'x'.repeat(10000) }], { env, fetchImpl: t1.fetchImpl, now });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /day cap/);
  assert.ok(!t1.calls.some(call => call.url === OPENROUTER_ENDPOINT), 'the chat endpoint is never called');
  // Yesterday's spend does not count; job cap: this job id already spent $4.99.
  await fs.writeFile(path.join(dir, 'openrouter-spend.jsonl'), `${JSON.stringify({ ts: '2026-09-28T10:00:00.000Z', jobId: 'or-job', model: 'm', costUsd: 4.99 })}\n`);
  t1 = transport(() => reply(completion()));
  result = await executeApi(job(), [{ path: 'input.txt', content: 'x'.repeat(10000) }], { env, fetchImpl: t1.fetchImpl, now });
  assert.match(result.error, /job cap/);
  // A single request that is itself too expensive in the worst case.
  await fs.writeFile(path.join(dir, 'openrouter-spend.jsonl'), '');
  t1 = transport(() => reply(completion()));
  result = await executeApi(job({ model: 'pricey/model' }), [], { env, fetchImpl: t1.fetchImpl, now });
  assert.match(result.error, /job cap/);
});

test('each completed request is appended to the spend ledger with the provider-reported cost; missing cost records the worst case', async t => {
  const dir = await logsDir(t);
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: dir };
  const now = () => new Date('2026-09-28T15:00:00Z');
  await executeApi(job(), [], { env, fetchImpl: transport(() => reply(completion())).fetchImpl, now });
  const noCost = completion(); delete noCost.usage.cost;
  await executeApi(job({ id: 'or-job-2' }), [], { env, fetchImpl: transport(() => reply(noCost)).fetchImpl, now });
  const rows = (await fs.readFile(path.join(dir, 'openrouter-spend.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].costUsd, 0.0123);
  assert.equal(rows[0].estimated, false);
  assert.equal(rows[1].estimated, true);
  assert.ok(rows[1].costUsd > 0);
  assert.ok(!JSON.stringify(rows).includes(KEY));
  assert.deepEqual(spentSoFar(rows, { jobId: 'or-job', day: '2026-09-28' }).job, 0.0123);
});

test('pricing that cannot be fetched refuses the request (the cap can never be skipped)', async t => {
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await logsDir(t) };
  const fetchImpl = async url => (url === OPENROUTER_MODELS_URL ? new Response('nope', { status: 503 }) : reply(completion()));
  const result = await executeApi(job(), [], { env, fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /cannot be checked/);
});

test('the key comes from env, else the keychain item named by config (default project-swarm), and a missing key refuses', async t => {
  assert.equal(readOpenRouterKey({ OPENROUTER_API_KEY: KEY }), KEY);
  // config: {} is passed explicitly throughout so this never falls back to reading the real home.
  let argv;
  const exec = (bin, args) => { argv = [bin, ...args]; return `${KEY}\n`; };
  assert.equal(readOpenRouterKey({}, { platform: 'darwin', exec, config: {} }), KEY);
  assert.deepEqual(argv, ['/usr/bin/security', 'find-generic-password', '-s', 'project-swarm', '-a', 'openrouter.api_key', '-w']);
  assert.equal(readOpenRouterKey({}, { platform: 'darwin', exec: () => { throw new Error('not found'); }, config: {} }), null);
  assert.equal(readOpenRouterKey({}, { platform: 'linux', exec, config: {} }), null);
  const configuredArgv = [];
  const configuredExec = (bin, args) => { configuredArgv.push(bin, ...args); return `${KEY}\n`; };
  assert.equal(readOpenRouterKey({}, { platform: 'darwin', exec: configuredExec, config: { keychain: { service: 'acme-swarm' } } }), KEY);
  assert.deepEqual(configuredArgv, ['/usr/bin/security', 'find-generic-password', '-s', 'acme-swarm', '-a', 'openrouter.api_key', '-w']);
  assert.equal(apiConfiguration('openrouter', {}, { readKey: () => null }).configured, false);
  const result = await executeApi(job(), [], { env: { SWARM_LOGS_DIR: await logsDir(t) }, readKey: () => null, fetchImpl: async () => { throw new Error('no request expected'); } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /OPENROUTER_API_KEY is required/);
});

test('an echoed key discards the output', async t => {
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await logsDir(t) };
  const leaked = { summary: `key ${KEY}`, files: envelope.files };
  const result = await executeApi(job(), [], { env, fetchImpl: transport(() => reply(completion(leaked))).fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /credential/);
});

test('worst case counts every input character as a token plus the full output budget', () => {
  assert.equal(worstCaseUsd({ prompt: 0.000002, completion: 0.00001 }, { inputChars: 1000, maxTokens: 100 }), 0.002 + 0.001);
});

// Row #185 wiring: executeApi's own extract() names the real finish_reason on an incomplete
// OpenRouter reply, the same wording tools/openrouter.mjs's assertCompleteChatResponse produces.
test('an incomplete OpenRouter reply names its finish_reason through executeApi', async t => {
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await logsDir(t) };
  const truncated = completion(envelope, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{"partial":' } }] });
  const result = await executeApi(job(), [], { env, fetchImpl: transport(() => reply(truncated)).fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /truncated: finish_reason length/);
});

// apiDoctor's auth string names the configured keychain service, never a hard-coded product name.
test('apiDoctor names the configured keychain service, defaulting to project-swarm', () => {
  assert.match(apiDoctor('openrouter', { SWARM_CONFIG: '/nonexistent/swarm-config.json' }).authentication, /keychain project-swarm\/openrouter\.api_key/);
});

test('a key read from the keychain (not env) that is echoed back still discards the output', async t => {
  const env = { SWARM_LOGS_DIR: await logsDir(t) };
  const leaked = { summary: `key ${KEY}`, files: envelope.files };
  const result = await executeApi(job(), [], { env, readKey: () => KEY, fetchImpl: transport(() => reply(completion(leaked))).fetchImpl });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /credential/);
});

test("yesterday's spend never counts toward today's cap", async t => {
  const dir = await logsDir(t);
  await fs.writeFile(path.join(dir, 'openrouter-spend.jsonl'), `${JSON.stringify({ ts: '2026-09-27T23:59:00.000Z', jobId: 'old', model: 'm', costUsd: 100 })}\n`);
  const result = await executeApi(job(), [], { env: { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: dir }, fetchImpl: transport(() => reply(completion())).fetchImpl, now: () => new Date('2026-09-28T00:01:00Z') });
  assert.equal(result.status, 'complete', result.error);
});
