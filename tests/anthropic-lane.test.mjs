// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeApi, apiConfiguration, anthropicSchema } from '../tools/api-adapters.mjs';
import { worstCaseUsd, usageCostUsd, assertWithinCaps, assertOpusTier, spentSoFar, readAnthropicKey, ledgerPath } from '../tools/anthropic.mjs';
import { routeJob } from '../tools/router.mjs';

const KEY = 'sk-ant-test-0123456789';
const answer = { summary: 'ok', files: [], edits: [] };
const reply = (over = {}) => ({ ok: true, status: 200, headers: new Headers(), body: new Response(JSON.stringify({ type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 1000, output_tokens: 200 }, ...over })).body });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-lane-'));
const job = (over = {}) => ({ id: 'j1', agent: 'anthropic', model: 'claude-haiku-5-5', prompt: 'say ok', context: [], outputs: [], sensitive: true, ...over });

test('key comes from the keychain item, ignores ambient ANTHROPIC_API_KEY, never throws when absent', () => {
  const calls = [];
  const key = readAnthropicKey({}, { platform: 'darwin', exec: (cmd, args) => { calls.push(args); return `${KEY}\n`; } });
  assert.equal(key, KEY);
  assert.deepEqual(calls[0].slice(0, 5), ['find-generic-password', '-s', 'project-swarm', '-a', 'anthropic.api_key']);
  assert.equal(readAnthropicKey({ ANTHROPIC_API_KEY: 'ambient-key-value' }, { platform: 'darwin', exec: () => { throw new Error('none'); } }), null);
  assert.equal(apiConfiguration('anthropic', { SWARM_ANTHROPIC_API_KEY: KEY }).configured, true);
});

test('request carries the key only in a header, effort low, and a sanitized schema; cost is recorded', async () => {
  const dir = tmp(); let seen;
  const env = { SWARM_LOGS_DIR: dir, SWARM_ANTHROPIC_API_KEY: KEY };
  const result = await executeApi(job(), [], { env, fetchImpl: async (url, init) => { seen = { url, init }; return reply(); } });
  assert.equal(result.status, 'complete');
  assert.equal(seen.init.headers['x-api-key'], KEY);
  assert.ok(!seen.init.body.includes(KEY));
  const body = JSON.parse(seen.init.body);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(body.output_config.format.schema).includes('"additionalProperties":true'));
  assert.equal(result.costUsd, usageCostUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 200 }));
  const rows = fs.readFileSync(ledgerPath(env), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].costUsd, result.costUsd);
});

test('a refusal or truncation fails the job without echoing the key', async () => {
  const env = { SWARM_LOGS_DIR: tmp(), SWARM_ANTHROPIC_API_KEY: KEY };
  const refused = await executeApi(job(), [], { env, fetchImpl: async () => reply({ stop_reason: 'refusal', content: [] }) });
  assert.equal(refused.status, 'failed');
  const cut = await executeApi(job(), [], { env, fetchImpl: async () => reply({ stop_reason: 'max_tokens' }) });
  assert.match(cut.error, /truncated/);
  assert.equal(cut.costUsd, usageCostUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 200 }));
});

test('missing key names the keychain item before any request', async () => {
  let called = false;
  const result = await executeApi(job(), [], { env: { SWARM_LOGS_DIR: tmp(), SWARM_ANTHROPIC_NO_KEYCHAIN: '1' }, fetchImpl: async () => { called = true; return reply(); } });
  assert.equal(called, false);
  assert.match(result.error, /api-key-missing.*project-swarm\/anthropic\.api_key/);
});

test('machine-wide total and day caps refuse before a request is sent', async () => {
  const dir = tmp(); const env = { SWARM_LOGS_DIR: dir, SWARM_ANTHROPIC_API_KEY: KEY };
  const today = new Date().toISOString();
  fs.writeFileSync(ledgerPath(env), `${JSON.stringify({ ts: today, jobId: 'other', model: 'claude-haiku-5-5', costUsd: 19.999 })}\n`);
  let called = false;
  const day = await executeApi(job({ maxOutputTokens: 8192 }), [], { env, fetchImpl: async () => { called = true; return reply(); } });
  assert.equal(called, false);
  assert.match(day.error, /day cap/);
  const old = '2025-01-01T00:00:00.000Z';
  fs.writeFileSync(ledgerPath(env), `${JSON.stringify({ ts: old, jobId: 'old', model: 'claude-haiku-5-5', costUsd: 499.999 })}\n`);
  const total = await executeApi(job({ maxOutputTokens: 8192 }), [], { env, fetchImpl: async () => { called = true; return reply(); } });
  assert.match(total.error, /total cap/);
  assert.equal(called, false);
  assert.throws(() => assertWithinCaps({ worstUsd: 1, spent: { job: 0, today: 19.5, total: 0 } }), /day cap/);
  assert.deepEqual(spentSoFar([{ ts: today, jobId: 'a', costUsd: 1 }], { jobId: 'a', day: today.slice(0, 10) }), { job: 1, today: 1, total: 1 });
});

test('Opus needs tier expensive; Haiku and Sonnet do not', () => {
  assert.throws(() => assertOpusTier({ model: 'claude-opus-5-5', tier: 'mid' }), /anthropic-opus-needs-tier/);
  assert.doesNotThrow(() => assertOpusTier({ model: 'claude-opus-5-5', tier: 'expensive' }));
  assert.doesNotThrow(() => assertOpusTier({ model: 'claude-sonnet-5-5' }));
  assert.ok(worstCaseUsd('claude-haiku-5-5', { inputChars: 1000, maxTokens: 8192 }) < 0.01);
});

test('router puts anthropic first, allows sensitive jobs, mid tier picks Sonnet, and keeps OpenRouter for bookkeeping', () => {
  const lanes = { codex: { model: 'c' }, cursor: { model: 'u' }, anthropic: { model: 'claude-haiku-5-5' }, openrouter: { model: 'o' }, claude: { model: 'sonnet' } };
  const sensitive = { id: 'r', agent: 'auto', sensitive: true, outputs: ['src/a.js'] };
  assert.equal(routeJob(sensitive, { lanes }).agent, 'anthropic');
  assert.equal(routeJob({ ...sensitive, tier: 'mid' }, { lanes: { anthropic: lanes.anthropic } }).model, 'claude-sonnet-5-5');
  assert.equal(routeJob({ ...sensitive, sensitive: false }, { lanes }).agent, 'anthropic');
  assert.equal(routeJob({ ...sensitive, sensitive: false }, { lanes: { codex: lanes.codex, openrouter: lanes.openrouter } }).agent, 'codex');
  assert.equal(routeJob({ ...sensitive, sensitive: false, outputs: ['CHANGELOG.md'] }, { lanes: { openrouter: lanes.openrouter } }).agent, 'openrouter');
  assert.equal(routeJob({ ...sensitive, tier: 'expensive' }, { lanes }).agent, 'claude');
});

test('schema sanitizer drops unsupported keywords and open result objects', () => {
  const out = anthropicSchema({ type: 'object', properties: { result: { type: 'object', additionalProperties: true }, s: { type: 'string', minLength: 1, maxLength: 5 }, a: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string' } } } });
  assert.deepEqual(out, { type: 'object', properties: { s: { type: 'string' }, a: { type: 'array', items: { type: 'string' } } } });
});
