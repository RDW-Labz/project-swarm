// SPDX-License-Identifier: Apache-2.0
// Auto jobs go only to lanes that pass `swarm doctor` in the run's environment, and a lane whose
// launch preflight fails hands the job to the next healthy lane instead of failing the run.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROUTE_ORDER, routeJob } from '../tools/router.mjs';
import { createLaneDoctorGate, LANE_DOCTOR_PASS } from '../tools/lane-doctor.mjs';
import { runManifest } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const lanes = Object.fromEntries(ROUTE_ORDER.map(agent => [agent, { model: `${agent}-model` }]));
const job = { id: 'route-job', agent: 'auto', sensitive: false, outputs: ['src/a.js'] };

test('the router skips a lane that failed doctor and takes the next healthy one', () => {
  assert.equal(routeJob(job, { lanes }).agent, 'cursor');
  assert.equal(routeJob(job, { lanes, laneReady: agent => agent !== 'cursor' }).agent, 'codex');
  assert.equal(routeJob(job, { lanes, laneReady: agent => !['cursor', 'codex'].includes(agent) }).agent, 'anthropic');
  // Claude is gated too: with every lane failing doctor there is nothing to route to.
  assert.throws(() => routeJob(job, { lanes, laneReady: () => false, failures: { cursor: 2, codex: 2 } }), { code: 'route-exhausted' });
});

test('the gate passes doctor-ok lanes, fails the rest, and keeps a preflight failure', async () => {
  const statuses = { codex: 'compatible', anthropic: 'configured', cursor: 'not-authenticated', local: 'unconfigured' };
  const asked = [];
  const gate = createLaneDoctorGate({ doctorImpl: async ({ agent }) => {
    asked.push(agent);
    if (agent === 'hermes') throw Error('hermes not installed');
    if (agent === 'slow') return new Promise(() => {});
    return { status: statuses[agent], note: `${agent} note` };
  }, timeoutMs: 50 });
  assert.equal(gate.ready('cursor'), true, 'a lane not checked yet is not removed');
  await gate.prepare(['codex', 'anthropic', 'cursor', 'local', 'hermes', 'slow', 'codex']);
  assert.deepEqual(asked.sort(), ['anthropic', 'codex', 'cursor', 'hermes', 'local', 'slow'], 'each lane is checked once');
  assert.equal(gate.ready('codex'), true);
  assert.equal(gate.ready('anthropic'), true);
  assert.equal(gate.ready('cursor'), false);
  assert.equal(gate.ready('local'), false);
  assert.equal(gate.ready('hermes'), false);
  assert.equal(gate.ready('slow'), false);
  assert.match(gate.report().hermes.reason, /hermes not installed/);
  assert.equal(gate.report().slow.status, 'timeout');
  gate.markFailed('codex', 'codex: login expired');
  await gate.prepare(['codex']);
  assert.equal(gate.ready('codex'), false, 'a preflight failure is not undone by the cached doctor result');
  assert.deepEqual(gate.report().codex, { ok: false, status: 'preflight-failed', reason: 'codex: login expired' });
  for (const status of ['compatible', 'configured']) assert.ok(LANE_DOCTOR_PASS.includes(status));
});

const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const auto = n => ({ id: `job-${n}`, agent: 'auto', sensitive: false, prompt: `Write out/${n}-metrics.md`, context: ['input.txt'], outputs: [`out/${n}-metrics.md`], maxOutputTokens: 1000, timeoutMs: 5000 });

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lane-doctor-')));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(temp, 'config.json'), '{}');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i']);
  const env = { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend'), SWARM_ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdef', OPENROUTER_API_KEY: 'sk-or-test', SWARM_LOGS_DIR: path.join(root, '.swarm/provider-logs') };
  return { root, env, liveDir: path.join(temp, 'live') };
}

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

test('a run sends an auto job past a lane that fails doctor to the next healthy lane', async t => {
  const options = await fixture(t);
  const seen = [];
  const laneDoctor = createLaneDoctorGate({ doctorImpl: async ({ agent }) => (agent === 'anthropic' ? { status: 'unconfigured', note: 'no key in this environment' } : { status: 'configured' }) });
  const state = await runManifest(options.root, { version: 1, lanes: { anthropic: { model: 'claude-haiku-5-5' }, openrouter: { model: 'test/model' } }, jobs: [auto(0)] }, { ...options, laneDoctor, spawnImpl: () => { throw Error('no CLI lane here'); }, fetchImpl: server(seen) });
  assert.equal(state.status, 'complete', `${state.error} ${JSON.stringify(state.jobs.map(j => [j.status, j.error]))}`);
  assert.equal(state.jobs[0].agent, 'openrouter');
  assert.deepEqual(seen, [['openrouter', 0]], 'the failing lane was never called');
  assert.deepEqual(state.laneDoctor.anthropic, { ok: false, status: 'unconfigured', reason: 'no key in this environment' });
});

test('a lane whose launch preflight fails is skipped and the job runs on the next healthy lane', async t => {
  const options = await fixture(t);
  const seen = [];
  // Doctor said Cursor was fine, but at launch there is no cursor-agent on PATH (or no macOS seatbelt) and no credential.
  const laneDoctor = createLaneDoctorGate({ doctorImpl: async () => ({ status: 'compatible' }) });
  const env = { ...options.env, PATH: '/usr/bin:/bin', SWARM_CURSOR_NO_KEYCHAIN: '1' };
  delete env.CURSOR_API_KEY;
  const state = await runManifest(options.root, { version: 1, lanes: { cursor: { model: 'composer-2.5' }, anthropic: { model: 'claude-haiku-5-5' } }, jobs: [auto(0)] }, { ...options, env, laneDoctor, spawnImpl: () => { throw Error('no CLI lane here'); }, fetchImpl: server(seen) });
  assert.equal(state.status, 'complete', `${state.error} ${JSON.stringify(state.jobs.map(j => [j.status, j.error]))}`);
  assert.equal(state.jobs[0].agent, 'anthropic');
  // The run's first routing pass hits the failing preflight, so the job itself never routes to cursor.
  assert.equal(state.laneDoctor.cursor.status, 'preflight-failed');
  assert.match(state.laneDoctor.cursor.reason, /cursor/);
  assert.deepEqual(seen, [['anthropic', 0]]);
});

test('with the gate off, a failing preflight still refuses the run as before', async t => {
  const options = await fixture(t);
  const env = { ...options.env, PATH: '/usr/bin:/bin', SWARM_CURSOR_NO_KEYCHAIN: '1' };
  delete env.CURSOR_API_KEY;
  await assert.rejects(runManifest(options.root, { version: 1, lanes: { cursor: { model: 'composer-2.5' }, anthropic: { model: 'claude-haiku-5-5' } }, jobs: [auto(0)] }, { ...options, env, laneDoctor: false, spawnImpl: () => { throw Error('no CLI lane here'); }, fetchImpl: server([]) }), /cursor/);
});
