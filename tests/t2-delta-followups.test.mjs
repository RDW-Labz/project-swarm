import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apiConfiguration, apiDoctor } from '../tools/api-adapters.mjs';
import { runManifest, resumeRun } from '../tools/swarm.mjs';
import { withSpendStore, resolveBudget, laneDayTotals, capDecision } from '../tools/spend.mjs';

const exec = promisify(execFile);
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const text = JSON.stringify({ summary: 'ok', files: [], edits: [] });
const job = (id, agent, extra = {}) => ({ id, agent, model: agent === 'anthropic' ? 'claude-sonnet-5-5' : 'test-model',
  prompt: 'Review supplied files.', context: ['input.txt'], outputs: [], sensitive: false, ...extra });

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 't2-delta-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'input.txt'), 'source\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const env = { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'),
    SWARM_SPEND_DIR: path.join(temp, 'spend'), SWARM_LOGS_DIR: path.join(temp, 'logs'),
    SWARM_ANTHROPIC_API_KEY: 'test-secret', OPENAI_API_KEY: 'test-secret' };
  await fs.writeFile(env.SWARM_CONFIG, '{}');
  return { root, env, liveDir: path.join(temp, 'live') };
}

for (const [url, selfHosted] of [
  ['https://api.lambda.ai', false], ['https://gpu.example', false],
  ['http://127.0.0.1:9000', true], ['http://localhost:8000', true],
]) {
  test(`Lambda configuration and doctor classify ${url}`, () => {
    const env = { SWARM_CONFIG: process.env.SWARM_CONFIG, SWARM_LAMBDA_URL: url };
    const config = apiConfiguration('lambda', env, { config: {} });
    assert.equal(config.selfHosted, selfHosted);
    assert.equal(config.configured, selfHosted);
    const doctor = apiDoctor('lambda', env);
    assert.equal(doctor.configured, selfHosted);
    assert.equal(doctor.status, selfHosted ? 'configured' : 'unconfigured');
    assert.equal(apiConfiguration('lambda', { ...env, LAMBDA_API_KEY: 'test-key' }, { config: {} }).configured, true);
  });
}

for (const agent of ['openai', 'anthropic']) {
  test(`${agent} paused between admissions is held and resumes after unpause`, async t => {
    const options = await fixture(t);
    let paidFetches = 0;
    const fetchImpl = async url => {
      if (String(url).includes('/api/chat')) {
        await fs.writeFile(options.env.SWARM_CONFIG, JSON.stringify({ lanes: { [agent]: { paused: true } } }));
        return json({ done: true, done_reason: 'stop', prompt_eval_count: 60, eval_count: 40, message: { content: text } });
      }
      paidFetches++;
      return json(agent === 'anthropic'
        ? { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } }
        : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 10 } });
    };
    const state = await runManifest(options.root, { version: 1, concurrency: 1,
      jobs: [job('first', 'ollama'), job('second', agent, { after: ['first'] })] }, { ...options, fetchImpl });
    assert.equal(state.status, 'paused', state.error);
    assert.equal(state.jobs[0].status, 'complete');
    assert.equal(state.jobs[1].status, 'held');
    assert.equal(state.jobs[1].heldReason, 'lane-paused');
    assert.equal(state.jobs[1].code, `${agent}-lane-paused`);
    assert.equal(state.jobs[1].attempts.length, 0);
    assert.equal(paidFetches, 0);
    const saved = path.join(options.root, '.swarm/runs', state.id, 'state.json');
    await assert.rejects(resumeRun(options.root, state.id, { ...options, fetchImpl }), { code: `${agent}-lane-paused` });
    assert.equal(paidFetches, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(saved, 'utf8')).jobs, state.jobs);
    await fs.writeFile(options.env.SWARM_CONFIG, '{}');
    const resumed = await resumeRun(options.root, state.id, { ...options, fetchImpl });
    assert.equal(resumed.status, 'complete', resumed.error);
    assert.equal(resumed.jobs[1].status, 'complete', resumed.jobs[1].error);
    assert.deepEqual(resumed.jobs[0], state.jobs[0]);
    assert.equal(paidFetches, 1);
  });
}

test('an auto job with every lane capped refuses resume with resume-over-cap', async t => {
  const options = await fixture(t);
  const lanes = Object.keys(resolveBudget().lanes);
  const state = await runManifest(options.root, { version: 1, concurrency: 1,
    budget: { lanes: Object.fromEntries(lanes.map(lane => [lane, { dailyTokens: 10000, ...(lane === 'openai' ? { dailyUsd: 0.0001 } : {}) }])) },
    jobs: [job('second', 'openai')] }, { ...options,
    fetchImpl: () => assert.fail('held job must not send') });
  assert.equal(state.status, 'paused', JSON.stringify(state.jobs));
  assert.equal(state.jobs[0].heldReason, 'lane-cap');
  // Build a persisted auto-held fixture from the runner's real paused state.
  const manifestFile = path.join(options.root, '.swarm/runs', state.id, 'manifest.json');
  const savedManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  savedManifest.jobs[0].agent = 'auto';
  delete savedManifest.jobs[0].model;
  await fs.writeFile(manifestFile, JSON.stringify(savedManifest));
  const savedState = JSON.parse(await fs.readFile(path.join(options.root, '.swarm/runs', state.id, 'state.json'), 'utf8'));
  const budget = resolveBudget({ ...savedState.budgetInputs, manifest: savedManifest });
  await withSpendStore(store => {
    for (const lane of lanes) store.entries[`earlier-${lane}`] = { day: new Date().toISOString().slice(0, 10),
      lane, root: options.root, kind: 'actual', usd: 0, tokens: 10000, pid: process.pid, host: os.hostname() };
    const totals = laneDayTotals(store);
    for (const agent of lanes) assert.ok(capDecision({ budget, run: {}, laneToday: totals, agent }), agent);
  }, { dir: options.env.SWARM_SPEND_DIR });
  // Resume must report the refusal consistently when routing has no lane left.
  await assert.rejects(resumeRun(options.root, state.id, options), error => {
    assert.equal(error.code, 'resume-over-cap');
    assert.match(error.message, /no lane can take job second/);
    return true;
  });
});
