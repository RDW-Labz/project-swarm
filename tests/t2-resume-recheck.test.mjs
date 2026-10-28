import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, resumeRun } from '../tools/swarm.mjs';
import { withSpendStore } from '../tools/spend.mjs';

const exec = promisify(execFile);
// Chicago midnight occurs between these clocks, within the same UTC day.
const day1 = Date.parse('2026-10-29T04:30:00Z');
const day2 = Date.parse('2026-10-29T05:30:00Z');
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

async function fixture(t, { agent = 'anthropic', laneCap = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 't2-resume-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  const context = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
  for (const file of context) await fs.writeFile(path.join(root, file), 'x'.repeat(47500));
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const env = { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'),
    SWARM_SPEND_DIR: path.join(temp, 'spend'), SWARM_LOGS_DIR: path.join(temp, 'logs'),
    SWARM_ANTHROPIC_API_KEY: 'test-secret', OPENAI_API_KEY: 'test-secret' };
  const config = { dailyLimit: { mode: 'stop' } };
  await fs.writeFile(env.SWARM_CONFIG, JSON.stringify(config));
  let time = day1, fetches = 0, keyReads = 0;
  const options = { env, liveDir: path.join(temp, 'live'), now: () => time,
    fetchImpl: async () => {
      fetches += 1;
      return json({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ summary: 'ok', files: [], edits: [] }) }],
        usage: { input_tokens: 100, output_tokens: 20 } });
    } };
  const seed = async (usd, at = time, kind = 'actual') => withSpendStore(store => {
    store.entries[`paid-${at}-${kind}`] = { day: new Date(at).toISOString().slice(0, 10),
      at: new Date(at).toISOString(), lane: 'gemini', root: '/another-project',
      kind, usd, tokens: 10, pid: process.pid, host: os.hostname() };
  }, { dir: env.SWARM_SPEND_DIR, now: () => time });
  if (!laneCap) await seed(2);
  const state = await runManifest(root, { version: 1, concurrency: 1,
    ...(laneCap ? { budget: { lanes: { [agent]: { dailyUsd: 0.1 } } } } : {}),
    jobs: [{ id: 'j', agent, model: agent === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5',
      prompt: 'Review supplied files.', context: laneCap ? [] : context,
      outputs: [], sensitive: false, ...(!laneCap ? { maxOutputTokens: 12000 } : {}) }] }, options);
  assert.equal(state.status, 'paused', state.error);
  assert.equal(state.jobs[0].heldReason, 'lane-cap');
  if (!laneCap) assert.equal(state.jobs[0].code, 'daily-limit-stop');
  assert.equal(fetches, 0);
  time = day2;
  for (const key of ['SWARM_ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    Object.defineProperty(env, key, { enumerable: true, get() { keyReads += 1; return 'test-secret'; } });
  }
  const saved = async () => JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'state.json'), 'utf8'));
  return { root, env, config, state, options, seed, saved,
    counts: () => ({ fetches, keyReads }),
    pause: async () => fs.writeFile(env.SWARM_CONFIG, JSON.stringify({ ...config, lanes: { [agent]: { paused: true } } })) };
}

test('daily-limit held job refuses a newly paused lane after Chicago midnight without reading a key', async t => {
  const f = await fixture(t);
  await f.pause();
  await assert.rejects(resumeRun(f.root, f.state.id, f.options), error => {
    assert.equal(error.code, 'anthropic-lane-paused');
    assert.match(error.message, /anthropic.*paused/);
    return true;
  });
  assert.deepEqual(f.counts(), { fetches: 0, keyReads: 0 });
  assert.equal((await f.saved()).status, 'paused');
  assert.deepEqual((await f.saved()).jobs, f.state.jobs);
});

test('daily-limit held job is admitted on the next Chicago day with one paid fetch', async t => {
  const f = await fixture(t);
  const resumed = await resumeRun(f.root, f.state.id, f.options);
  assert.equal(resumed.status, 'complete', resumed.error);
  assert.equal(resumed.jobs[0].status, 'complete', resumed.jobs[0].error);
  assert.equal(f.counts().fetches, 1);
});

for (const kind of ['actual', 'reservation']) {
  test(`resume refuses machine-wide ${kind} exposure on the new Chicago day`, async t => {
    const f = await fixture(t);
    await f.seed(2.5, day2, kind);
    await assert.rejects(resumeRun(f.root, f.state.id, f.options), { code: 'resume-over-cap' });
    assert.deepEqual(f.counts(), { fetches: 0, keyReads: 0 });
    assert.equal((await f.saved()).status, 'paused');
  });
}

test('old valid daily admission cannot bypass the shared paid-lane config pause', async t => {
  const f = await fixture(t, { agent: 'openai', laneCap: true });
  await f.pause();
  await assert.rejects(resumeRun(f.root, f.state.id, f.options), { code: 'openai-lane-paused' });
  assert.deepEqual(f.counts(), { fetches: 0, keyReads: 0 });
  assert.equal((await f.saved()).status, 'paused');
});
