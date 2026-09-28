// Field lessons #184, #193 (ask's slice): an API agent's free-text summary is never lost to a
// JSON-parse mismatch, and two `ask` runs launched in the same millisecond never collide.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { askRun } from '../tools/swarm.mjs';
import { OPENROUTER_ENDPOINT, OPENROUTER_MODELS_URL } from '../tools/openrouter.mjs';

const KEY = 'sk-or-FAKE-0000-0000-0000';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-ask-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'source');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Only tests inject a provider. The production Claude adapter spawns the literal claude command.
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });

const models = { data: [{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000002', completion: '0.00001' } }] };
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function transport(onChat) {
  const fetchImpl = async (url, options) => {
    if (url === OPENROUTER_MODELS_URL) return reply(models);
    if (url === OPENROUTER_ENDPOINT) return onChat(JSON.parse(options.body));
    throw new Error(`unexpected url ${url}`);
  };
  return fetchImpl;
}
const completion = summary => ({ id: 'gen-1', model: 'resolved-model', provider: 'Anthropic', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary, files: [] }) } }] });

// --- run id uniqueness (field lesson #193) --------------------------------------------------

test('ask ids carry a random suffix: <prefix>-<ms>-<8 hex>, unlike the old ask-<ms> that two runs could share', async t => {
  const root = await fixture(t);
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ answer: 'ok' }))},total_cost_usd:0.01}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Ok?' }, { spawnImpl: fake(script) });
  assert.match(result.id, /^ask-\d+-[0-9a-f]{8}$/);
});

test('a claim collision on the first id is retried once with a fresh id, and the run still completes', async t => {
  const root = await fixture(t);
  const collidingId = 'ask-collision-fixture';
  await fs.mkdir(path.join(root, '.swarm/runs', collidingId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', collidingId, 'claim'), '');
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ answer: 'ok' }))},total_cost_usd:0.01}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Ok?' }, { spawnImpl: fake(script), id: collidingId });
  assert.notEqual(result.id, collidingId);
  assert.match(result.id, /^ask-\d+-[0-9a-f]{8}$/);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.result, { answer: 'ok' });
});

// --- API agent JSON fallback (field lesson #184) --------------------------------------------

test('#184: an API agent whose summary is plain prose returns {status:"ok", answer, parsed:false} instead of an error', async t => {
  const root = await fixture(t);
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-openrouter-logs-')) };
  t.after(() => fs.rm(env.SWARM_LOGS_DIR, { recursive: true, force: true }));
  const fetchImpl = transport(body => reply(completion('The answer is plainly yes, based on the source file.')));
  const result = await askRun(root, { model: 'anthropic/claude-sonnet-5', context: ['input.txt'], agent: 'openrouter', question: 'Is it yes?' }, { env, fetchImpl });
  assert.deepEqual(Object.keys(result).sort(), ['actualModel', 'answer', 'contextFiles', 'costUsd', 'id', 'model', 'modelMismatch', 'parsed', 'status'].sort());
  assert.equal(result.status, 'ok');
  assert.equal(result.parsed, false);
  assert.equal(result.answer, 'The answer is plainly yes, based on the source file.');
  assert.equal('error' in result, false);
  assert.equal('result' in result, false);
});

test('#184: an API agent whose summary already ends in a parsable JSON line is returned as a normal parsed result, not the prose fallback', async t => {
  const root = await fixture(t);
  const env = { OPENROUTER_API_KEY: KEY, SWARM_LOGS_DIR: await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-openrouter-logs-')) };
  t.after(() => fs.rm(env.SWARM_LOGS_DIR, { recursive: true, force: true }));
  const fetchImpl = transport(() => reply(completion(`Reasoning first.\n${JSON.stringify({ answer: 'yes' })}`)));
  const result = await askRun(root, { model: 'anthropic/claude-sonnet-5', context: ['input.txt'], agent: 'openrouter', question: 'Is it yes?' }, { env, fetchImpl });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.result, { answer: 'yes' });
  assert.equal('parsed' in result, false);
  assert.equal('answer' in result, false);
});

test('#184: the claude agent keeps its existing "no parsable JSON" error shape (the fallback is API-agent only)', async t => {
  const root = await fixture(t);
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify('Just prose, no JSON here.')},total_cost_usd:0.01}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Ok?' }, { spawnImpl: fake(script) });
  assert.equal(result.status, 'complete');
  assert.equal(result.error, 'Worker returned no parsable final JSON');
  assert.equal('answer' in result, false);
  assert.equal('parsed' in result, false);
});
