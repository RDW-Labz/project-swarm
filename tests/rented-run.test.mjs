// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, resumeRun, validateProject, doctor } from '../tools/swarm.mjs';
import { resolveLanes } from '../tools/lanes.mjs';
import { resolveBudget } from '../tools/spend.mjs';

const exec = promisify(execFile);
const KEY = 'rented-secret-key-0123456789';
const MODEL = 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8';
const rentedGpu = (extra = {}) => ({ name: 'h100-node', endpoint: 'http://127.0.0.1:8000', model: MODEL, hourlyUsd: 30, maxHoursPerRun: 3, concurrency: 16, ...extra });
const job = (n, extra = {}) => ({ id: `job-${n}`, agent: 'rented', model: MODEL, sensitive: false, prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 20000, ...extra });

async function fixture(t, gpu = rentedGpu()) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-rented-')));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify(gpu === null ? {} : { rentedGpu: gpu }));
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i']);
  return { root, temp, env: { SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend'), SWARM_RENTED_API_KEY: KEY } };
}
const reply = n => new Response(JSON.stringify({ model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: 'ok', files: [{ path: `out/${n}.txt`, content: `o${n}\n` }], edits: [] }) } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { headers: { 'content-type': 'application/json' } });
// A fake server that also moves a fake clock: each request takes `minutes`.
function server(clock, minutes) {
  const seen = { requests: [] };
  return { seen, fetchImpl: async (url, init) => { seen.requests.push({ url: String(url), init }); clock.t += minutes * 60000; return reply(/out\/(\d+)\.txt/.exec(init.body)[1]); } };
}
const clockAt = () => ({ t: Date.UTC(2030, 0, 1, 12, 0, 0) });
const options = (f, fetchImpl, clock, extra = {}) => ({ root: f.root, env: f.env, fetchImpl, now: () => clock.t, ...extra });

test('a rented job runs against the configured server with the Keychain key, no token cost, and the run records the rental', async t => {
  const f = await fixture(t), clock = clockAt(), { seen, fetchImpl } = server(clock, 6);
  const state = await runManifest(f.root, { version: 1, concurrency: 1, budget: { maxUsd: 20 }, jobs: [job(0), job(1)] }, { ...options(f, fetchImpl, clock), id: 'r1' });
  assert.equal(state.status, 'complete', state.jobs.map(entry => entry.error).join('; '));
  const first = seen.requests[0];
  assert.equal(first.url, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(first.init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(first.init.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.response_format.type, 'json_schema');
  assert.ok(!first.init.body.includes(KEY));
  assert.equal(state.jobs[0].costUsd ?? 0, 0, 'no per-request cost: the rental is the cost');
  assert.equal(state.rental.name, 'h100-node');
  assert.ok(state.rental.usd > 0 && state.rental.hours > 0, JSON.stringify(state.rental));
  assert.equal(await fs.readFile(path.join(f.root, state.jobs[1].workspace, 'out/1.txt'), 'utf8'), 'o1\n');
  const store = JSON.parse(await fs.readFile(path.join(f.env.SWARM_SPEND_DIR, 'daily.json'), 'utf8'));
  const rental = Object.values(store.entries).find(entry => entry.jobId === 'rental');
  assert.ok(rental && rental.lane === 'rented' && rental.usd > 0, 'the rental is in the machine-wide day total');
  assert.ok(!JSON.stringify(state).includes(KEY));
});

test('a sensitive job is refused on a server that is not trusted, allowed on one marked trusted; the model must match', async t => {
  const f = await fixture(t);
  const manifest = extra => ({ version: 1, budget: { maxUsd: 5 }, jobs: [job(0, { sensitive: true, ...extra })] });
  await assert.rejects(validateProject(f.root, manifest(), { env: f.env }), { code: 'sensitive-provider' });
  await assert.rejects(validateProject(f.root, { version: 1, jobs: [job(0, { sensitive: undefined })] }, { env: f.env }), { code: 'sensitive-provider' });
  await assert.rejects(validateProject(f.root, manifest({ sensitive: false, model: 'other/model' }), { env: f.env }), { code: 'rented-model' });
  await validateProject(f.root, manifest({ sensitive: false }), { env: f.env });
  const trusted = await fixture(t, rentedGpu({ trusted: true }));
  await validateProject(trusted.root, manifest(), { env: trusted.env });
  const none = await fixture(t, null);
  await assert.rejects(validateProject(none.root, manifest({ sensitive: false }), { env: none.env }), { code: 'rented-not-configured' });
});

test('the rental guard: no run cap holds the job; the 80% warning; then it stops launching at the cap and never kills what is running', async t => {
  let f = await fixture(t), clock = clockAt(), s = server(clock, 20);
  let state = await runManifest(f.root, { version: 1, concurrency: 1, jobs: [job(0)] }, { ...options(f, s.fetchImpl, clock), id: 'nocap' });
  assert.equal(state.status, 'paused');
  assert.equal(state.jobs[0].heldReason, 'run-cap');
  assert.match(state.jobs[0].error, /needs a run USD cap/);
  assert.equal(s.seen.requests.length, 0);
  f = await fixture(t); clock = clockAt(); s = server(clock, 20);
  // 30 USD an hour: a 20 minute job is 10 USD; the cap is 12
  state = await runManifest(f.root, { version: 1, concurrency: 1, budget: { maxUsd: 12 }, jobs: [job(0), job(1), job(2)] }, { ...options(f, s.fetchImpl, clock), id: 'capped' });
  assert.equal(state.status, 'paused');
  // the guard looks before each launch: $10 so far is under the cap of $12, so the second job goes out (and ends at $20); the third is stopped
  assert.deepEqual(state.jobs.map(entry => entry.status), ['complete', 'complete', 'held']);
  assert.equal(state.jobs[2].heldReason, 'run-cap');
  assert.equal(s.seen.requests.length, 2);
  assert.ok(state.warnings.some(warning => /rented lane at (8\d|9\d)% of the run cap/.test(warning)), JSON.stringify(state.warnings));
  assert.ok(state.rental.usd >= 20 && state.rental.usd < 20.5, String(state.rental.usd));
});

test('the hour limit and the lane day cap (shared with other runs) also stop launches', async t => {
  let f = await fixture(t, rentedGpu({ maxHoursPerRun: 0.5 })), clock = clockAt(), s = server(clock, 20);
  let state = await runManifest(f.root, { version: 1, concurrency: 1, budget: { maxUsd: 1000 }, jobs: [job(0), job(1), job(2)] }, { ...options(f, s.fetchImpl, clock), id: 'hours' });
  assert.deepEqual(state.jobs.map(entry => entry.status), ['complete', 'complete', 'held']);
  assert.equal(state.jobs[2].heldReason, 'rental-hours');
  await assert.rejects(resumeRun(f.root, 'hours', { ...options(f, s.fetchImpl, clock) }), { code: 'resume-over-cap' });
  f = await fixture(t, rentedGpu({ dailyUsd: 15 })); clock = clockAt(); s = server(clock, 40);
  const first = await runManifest(f.root, { version: 1, concurrency: 1, budget: { maxUsd: 1000 }, jobs: [job(0)] }, { ...options(f, s.fetchImpl, clock), id: 'day-1' });
  assert.equal(first.status, 'complete');
  const second = await runManifest(f.root, { version: 1, concurrency: 1, budget: { maxUsd: 1000 }, jobs: [job(0)] }, { ...options(f, s.fetchImpl, clock), id: 'day-2' });
  assert.equal(second.status, 'paused', 'a second run the same day starts from the first run\'s rental');
  assert.equal(second.jobs[0].heldReason, 'lane-cap');
});

test('the lane takes its ceiling and adaptive start from rentedGpu; its day cap defaults to one run\'s maximum rental', () => {
  const lanes = resolveLanes({ config: { rentedGpu: rentedGpu({ concurrency: 64 }) } });
  assert.equal(lanes.rented.concurrency, 64);
  assert.deepEqual(lanes.rented.adaptive, { min: 1, start: 4 });
  assert.equal(resolveLanes().rented.adaptive.start, 4);
  assert.equal(resolveBudget({ config: { rentedGpu: rentedGpu() } }).lanes.rented.dailyUsd, 90);
  assert.equal(resolveBudget({ config: { rentedGpu: rentedGpu({ dailyUsd: 40 }) } }).lanes.rented.dailyUsd, 40);
  assert.equal(resolveBudget({ config: { spend: { lanes: { rented: { dailyUsd: 25 } } }, rentedGpu: rentedGpu() } }).lanes.rented.dailyUsd, 25);
  assert.equal(resolveBudget().lanes.rented.dailyUsd, null);
});

test('doctor rented reports configured only with a config block and a key', async t => {
  const f = await fixture(t);
  assert.equal((await doctor({ agent: 'rented', env: f.env })).configured, true);
  assert.equal((await doctor({ agent: 'rented', env: { ...f.env, SWARM_RENTED_API_KEY: undefined, SWARM_RENTED_NO_KEYCHAIN: '1' } })).configured, false);
  const none = await fixture(t, null);
  assert.equal((await doctor({ agent: 'rented', env: none.env })).configured, false);
});

test('review fixes: the rental is split into one store entry per UTC day, so a run over midnight counts on both days', async t => {
  const f = await fixture(t), clock = { t: Date.UTC(2030, 0, 1, 23, 50, 0) }, s = server(clock, 20);
  const state = await runManifest(f.root, { version: 1, concurrency: 1, budget: { maxUsd: 1000 }, jobs: [job(0), job(1)] }, { ...options(f, s.fetchImpl, clock), id: 'midnight' });
  assert.equal(state.status, 'complete');
  const store = JSON.parse(await fs.readFile(path.join(f.env.SWARM_SPEND_DIR, 'daily.json'), 'utf8'));
  const entries = Object.entries(store.entries).filter(([, entry]) => entry.jobId === 'rental');
  const byDay = Object.fromEntries(entries.map(([key, entry]) => [key.split('/').pop(), entry.usd]));
  assert.deepEqual(Object.keys(byDay).sort(), ['2030-01-01', '2030-01-02']);
  assert.ok(byDay['2030-01-01'] > 0 && byDay['2030-01-02'] > 0);
  assert.ok(Math.abs(byDay['2030-01-01'] + byDay['2030-01-02'] - state.rental.usd) < 0.05, `${JSON.stringify(byDay)} vs ${state.rental.usd}`);
});

test('review fixes: ask never uses the rented lane; manifest lane overrides cannot lift it past the config ceiling', async t => {
  const { resolveLanes } = await import('../tools/lanes.mjs');
  const lanes = resolveLanes({ config: { rentedGpu: rentedGpu({ concurrency: 8 }) }, manifest: { lanes: { rented: { concurrency: 100 } } } });
  assert.equal(lanes.rented.concurrency, 8);
  assert.ok(lanes.rented.adaptive.start <= 8);
  assert.equal(resolveLanes({ config: { rentedGpu: rentedGpu({ concurrency: 8 }) }, manifest: { lanes: { rented: { concurrency: 3 } } } }).rented.concurrency, 3);
  const f = await fixture(t);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['tools/swarm.mjs', '--root', f.root, 'ask', '--model', MODEL, '--agent', 'rented', 'hello'], { encoding: 'utf8', env: { ...process.env, ...f.env } });
  assert.notEqual(result.status, 0);
});
