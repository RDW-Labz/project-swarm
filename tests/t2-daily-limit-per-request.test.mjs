import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest } from '../tools/swarm.mjs';
import { executeApi } from '../tools/api-adapters.mjs';
import { assertDailyLimitBeforeSend, withSpendStore } from '../tools/spend.mjs';

const now = () => new Date('2026-10-29T02:00:00Z'); // Still October 28 in Chicago.
const answer = JSON.stringify({ summary: 'ok', files: [], edits: [] });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function fixture(t, { billed = 2, mode = 'stop' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't2-request-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, SWARM_CONFIG: path.join(root, 'config.json'),
    SWARM_SPEND_DIR: path.join(root, 'spend'), SWARM_LOGS_DIR: path.join(root, 'logs'),
    SWARM_ANTHROPIC_API_KEY: 'test-anthropic-secret', OPENROUTER_API_KEY: 'test-openrouter-secret' };
  await fs.writeFile(env.SWARM_CONFIG, JSON.stringify({ dailyLimit: { mode } }));
  await withSpendStore(store => {
    store.entries.paid = { day: '2026-10-28', at: '2026-10-28T18:00:00Z', lane: 'gemini',
      root: '/another-project', jobId: 'paid', kind: 'actual', usd: billed, tokens: 10 };
  }, { dir: env.SWARM_SPEND_DIR, now: () => +now() });
  return { root, env };
}

async function run(agent, fixture, overrides = {}, truncated = false) {
  let calls = 0;
  const job = { id: 'j', agent, model: agent === 'anthropic' ? 'claude-sonnet-5-5' : 'test/model',
    prompt: 'say ok', outputs: [], sensitive: false, ...overrides };
  const result = await executeApi(job, [], { ...fixture, now, fetchImpl: async (url, init) => {
    if (init.method === 'GET') return json({ data: [{ id: job.model, pricing: { prompt: '0', completion: '0.00004' } }] });
    calls += 1;
    const cut = truncated && calls === 1;
    return agent === 'anthropic'
      ? json({ model: job.model, stop_reason: cut ? 'max_tokens' : 'end_turn',
        content: [{ type: 'text', text: answer }], usage: { input_tokens: 10000, output_tokens: 4096 } })
      : json({ model: job.model, choices: [{ finish_reason: cut ? 'length' : 'stop',
        message: { content: cut ? '' : answer } }], usage: { cost: 0.02 } });
  } });
  return { result, calls };
}

test('Anthropic length retry rechecks the shared daily limit before a second fetch', async t => {
  const f = await fixture(t);
  await withSpendStore(store => {
    store.entries.own = { day: '2026-10-28', at: '2026-10-29T01:00:00Z', lane: 'anthropic',
      root: f.root, jobId: 'j', kind: 'reservation', usd: 0.1, tokens: 10, pid: process.pid, host: os.hostname() };
  }, { dir: f.env.SWARM_SPEND_DIR, now: () => +now() });
  const { result, calls } = await run('anthropic', f, { prompt: 'x'.repeat(190000) }, true);
  assert.equal(calls, 1);
  assert.equal(result.code, 'daily-limit-stop');
  assert.match(result.error, /billed.*in-flight reserves.*worstUsd.*2\.50/);
});

for (const agent of ['anthropic', 'openrouter']) {
  test(`${agent} refuses an over-limit first request before paid fetch`, async t => {
    const f = await fixture(t);
    const { result, calls } = await run(agent, f, { maxOutputTokens: agent === 'anthropic' ? 60000 : 16000 });
    assert.equal(calls, 0);
    assert.equal(result.code, 'daily-limit-stop');
  });

  test(`${agent} sends requests well under the daily limit`, async t => {
    const { result, calls } = await run(agent, await fixture(t));
    assert.equal(result.status, 'complete', result.error);
    assert.equal(calls, 1);
  });

  test(`${agent} notify mode permits a retry past the soft limit`, async t => {
    const f = await fixture(t, { mode: 'notify' });
    const { result, calls } = await run(agent, f, agent === 'anthropic' ? { prompt: 'x'.repeat(190000) } : {}, true);
    assert.equal(result.status, 'complete', result.error);
    assert.equal(calls, 2);
  });

  test(`${agent} notify mode still refuses a retry past the hard ceiling`, async t => {
    const f = await fixture(t, { mode: 'notify', billed: 7 });
    const { result, calls } = await run(agent, f, agent === 'anthropic' ? { prompt: 'x'.repeat(190000) } : {}, true);
    assert.equal(calls, 1);
    assert.equal(result.code, 'daily-limit-stop');
    assert.match(result.error, /hard ceiling \$7\.50/);
  });
}

test('OpenRouter length retry is refused before a second paid fetch', async t => {
  const { result, calls } = await run('openrouter', await fixture(t), {}, true);
  assert.equal(calls, 1);
  assert.equal(result.code, 'daily-limit-stop');
});

test('other jobs reserve machine-wide exposure while the current job is counted once', async t => {
  const f = await fixture(t);
  const entry = { day: '2026-10-28', at: '2026-10-29T01:00:00Z', lane: 'anthropic',
    root: f.root, jobId: 'j', kind: 'reservation', usd: 0.1, tokens: 10, pid: process.pid, host: os.hostname() };
  await withSpendStore(store => {
    store.entries.own = entry;
    store.entries.other = { ...entry, root: '/other-project', jobId: 'other', lane: 'openai', usd: 0.3 };
  }, { dir: f.env.SWARM_SPEND_DIR, now: () => +now() });
  const input = { ...f, lane: 'anthropic', jobId: 'j', now, worstUsd: 0.15 };
  await assertDailyLimitBeforeSend(input);
  await assert.rejects(assertDailyLimitBeforeSend({ ...input, worstUsd: 0.25 }), { code: 'daily-limit-stop' });
});

for (const truncated of [false, true]) {
  test(`run holds a daily-limit refusal ${truncated ? 'after a billed first call' : 'before any paid fetch'}`, async t => {
    const f = await fixture(t);
    f.root = path.join(f.root, 'repo');
    await fs.mkdir(f.root);
    const exec = promisify(execFile);
    const context = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    for (const file of context) await fs.writeFile(path.join(f.root, file), 'x'.repeat(47500));
    await fs.writeFile(path.join(f.root, '.gitignore'), '.swarm/\nspend/\nlogs/\n');
    await exec('git', ['init', '-q', f.root]);
    await exec('git', ['-C', f.root, 'add', '.']);
    await exec('git', ['-C', f.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    let calls = 0;
    const state = await runManifest(f.root, { version: 1, concurrency: 1, jobs: [{
      id: 'j', agent: 'anthropic', model: 'claude-sonnet-5-5',
      prompt: 'Review supplied files.', context, outputs: [], sensitive: false,
      ...(!truncated ? { maxOutputTokens: 12000 } : {}),
    }] }, { ...f, liveDir: path.join(f.root, 'live'), now: () => +now(), fetchImpl: async () => {
      calls += 1;
      return json({ model: 'claude-sonnet-5-5', stop_reason: 'max_tokens',
        content: [{ type: 'text', text: answer }], usage: { input_tokens: 10000, output_tokens: 4096 } });
    } });
    assert.equal(calls, truncated ? 1 : 0);
    assert.equal(state.status, 'paused', state.error);
    const [record] = state.jobs;
    assert.equal(record.status, 'held');
    assert.equal(record.heldReason, 'lane-cap');
    assert.equal(record.code, 'daily-limit-stop');
    assert.equal(record.attempts.length, truncated ? 1 : 0);
    const entries = Object.values(JSON.parse(await fs.readFile(path.join(f.env.SWARM_SPEND_DIR, 'daily.json'), 'utf8')).entries);
    assert.equal(entries.filter(entry => entry.kind === 'reservation').length, 0);
    assert.equal(entries.length, truncated ? 2 : 1);
    if (truncated) {
      assert.ok(record.costUsd > 0);
      assert.equal(entries.find(entry => entry.jobId === 'j').usd, record.costUsd);
    }
  });
}
