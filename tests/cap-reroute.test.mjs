// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const auto = n => ({ id: `job-${n}`, agent: 'auto', sensitive: false, prompt: `Write out/${n}-metrics.md`, context: ['input.txt'], outputs: [`out/${n}-metrics.md`], maxOutputTokens: 1000, timeoutMs: 5000 });

async function fixture(t, config) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-cap-reroute-')));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify(config));
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend'), SWARM_ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdef', OPENROUTER_API_KEY: 'sk-or-test', SWARM_LOGS_DIR: path.join(root, '.swarm/provider-logs') }, liveDir: path.join(temp, 'live') };
}

// Both jobs pick Anthropic (neither has reserved yet); the first reservation fills the day's token cap and the second is refused at admission.
function server(seen) {
  return async (url, request) => {
    const target = String(url);
    if (!request?.body) return reply({ data: [{ id: 'test/model', pricing: { prompt: '0.000002', completion: '0.00001' } }] });
    const n = Number(/out\/(\d+)-metrics\.md/.exec(request.body)[1]);
    if (target.includes('anthropic')) {
      seen.push(['anthropic', n]);
      return reply({ type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}-metrics.md`, content: 'a' }], edits: [] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
    }
    seen.push(['openrouter', n]);
    return reply({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}-metrics.md`, content: 'o' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
}

test('an auto job refused at admission by a lane daily cap moves to the next lane instead of holding the run', async t => {
  const options = await fixture(t, { spend: { lanes: { anthropic: { dailyTokens: 500 } } } });
  const seen = [];
  const state = await runManifest(options.root, { version: 1, concurrency: 2, lanes: { anthropic: { model: 'claude-haiku-5-5' }, openrouter: { model: 'test/model' } }, jobs: [auto(0), auto(1)] }, { ...options, spawnImpl: () => { throw Error('no CLI lane here'); }, fetchImpl: server(seen) });
  assert.equal(state.status, 'complete', `${state.error} ${JSON.stringify(state.jobs.map(j => [j.status, j.heldReason, j.error]))}`);
  assert.ok(state.jobs.every(record => record.status === 'complete' && !record.heldReason));
  const agents = state.jobs.map(record => record.agent).sort();
  assert.deepEqual(agents, ['anthropic', 'openrouter'], `jobs ran on ${agents}`);
  assert.equal(seen.length, 2);
  const moved = state.jobs.find(record => record.capFallbacks);
  assert.equal(moved.capFallbacks[0].from, 'anthropic');
  assert.equal(moved.capFallbacks[0].to, 'openrouter');
  assert.ok(state.spendWarnings.some(warning => /^lane-cap-reroute: job-\d left anthropic/.test(warning)));
});

test('three jobs refused at once each move on: the lane is skipped per job, not for the whole run', async t => {
  const options = await fixture(t, { spend: { lanes: { anthropic: { dailyTokens: 500 } } } });
  const seen = [];
  const state = await runManifest(options.root, { version: 1, concurrency: 3, lanes: { anthropic: { model: 'claude-haiku-5-5' }, openrouter: { model: 'test/model' } }, jobs: [auto(0), auto(1), auto(2)] }, { ...options, spawnImpl: () => { throw Error('no CLI lane here'); }, fetchImpl: server(seen) });
  assert.equal(state.status, 'complete', JSON.stringify(state.jobs.map(j => [j.status, j.heldReason, j.error])));
  assert.equal(seen.length, 3);
  assert.ok(state.jobs.every(record => record.status === 'complete'));
  assert.ok(state.jobs.filter(record => record.agent === 'openrouter').length >= 1);
  for (const record of state.jobs.filter(r => r.capFallbacks)) assert.equal(record.capFallbacks[0].to, record.agent, 'the recorded destination is the lane the job ran on');
});

test('the run cap still holds an auto job; a sensitive auto job is never rerouted to a lane that cannot take it', async t => {
  const options = await fixture(t, { spend: { lanes: { anthropic: { dailyTokens: 500 } } } });
  const lanes = { anthropic: { model: 'claude-haiku-5-5' }, openrouter: { model: 'test/model' } };
  const capped = await runManifest(options.root, { version: 1, concurrency: 1, lanes, budget: { maxTokens: 1 }, jobs: [auto(0), auto(1)] }, { ...options, fetchImpl: server([]) });
  assert.equal(capped.status, 'paused');
  assert.ok(capped.jobs.some(record => record.heldReason === 'run-cap'), JSON.stringify(capped.jobs.map(r => [r.status, r.heldReason])));
  assert.ok(capped.jobs.every(record => record.capFallbacks === undefined), 'a run cap is never answered by moving the job');
  // Two sensitive jobs: openrouter is never a candidate, so the second one is held at the cap instead of moving.
  const seen = [];
  const sens = n => ({ ...auto(n), sensitive: true, outputs: [`out/${n}.md`], prompt: `Write out/${n}.md` });
  const held = await runManifest(options.root, { version: 1, concurrency: 2, lanes, jobs: [sens(10), sens(11)] }, { ...options, spawnImpl: () => { throw Error('no CLI lane here'); }, fetchImpl: async (url, request) => { seen.push(String(url)); return server([])(url, request); } });
  assert.ok(held.jobs.every(record => record.agent !== 'openrouter'), JSON.stringify(held.jobs.map(r => r.agent)));
  assert.ok(seen.every(url => !url.includes('openrouter')), 'no sensitive request went to openrouter');
});

test('a job that named its lane is still held at the lane cap, and so is the run cap', async t => {
  const options = await fixture(t, { spend: { lanes: { openrouter: { dailyTokens: 10 } } } });
  const named = { ...auto(0), agent: 'openrouter', model: 'test/model', maxOutputTokens: 1000 };
  const state = await runManifest(options.root, { version: 1, concurrency: 1, jobs: [named, { ...named, id: 'job-1', outputs: ['out/1-metrics.md'], prompt: 'Write out/1-metrics.md' }] }, { ...options, fetchImpl: server([]) });
  assert.equal(state.status, 'paused');
  assert.ok(state.jobs.some(record => record.heldReason === 'lane-cap'));
});
