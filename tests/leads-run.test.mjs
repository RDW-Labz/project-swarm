// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, readState, resumeRun, integrateRun, validateManifest } from '../tools/swarm.mjs';
import { rollupRun, renderRollupText } from '../tools/reports.mjs';
import { renderMonitorView } from '../tools/monitor-view.mjs';

const exec = promisify(execFile);
const lead = (letter, area = {}) => ({ id: `lead-${letter}`, agent: 'ollama', model: 'test-model', type: 'lead', prompt: `Plan area ${letter}`, context: ['input.txt'], outputs: [`plans/${letter}.json`], area: { goal: `Build area ${letter}`, scope: [`app/${letter}/`], agents: ['ollama'], concurrency: 4, ...area } });
const worker = (letter, n, extra = {}) => ({ id: `worker-${n}`, agent: 'ollama', model: 'test-model', prompt: `Write app/${letter}/${n}.txt`, context: ['input.txt'], outputs: [`app/${letter}/${n}.txt`], ...extra });
const manifest = jobs => ({ version: 1, concurrency: 5, jobs });
const reply = (file, content) => new Response(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 60, eval_count: 40, message: { content: JSON.stringify({ summary: 'done', files: [{ path: file, content }] }) } }), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-leads-run-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(temp, 'config.json'), '{}');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
}

function workers({ count = 1, mutate = child => child, calls = [], onWorker } = {}) {
  return async (_url, request) => {
    const body = JSON.parse(request.body);
    const text = JSON.stringify(body);
    const plan = /Plan area ([a-e])/.exec(text);
    if (plan) {
      const letter = plan[1];
      calls.push(`lead-${letter}`);
      assert.match(text, /concurrency cap/);
      return reply(`plans/${letter}.json`, JSON.stringify(mutate({ version: 1, jobs: Array.from({ length: count }, (_, n) => worker(letter, n)) }, letter)));
    }
    const file = /Write (app\/[a-e]\/\d+\.txt)/.exec(text)?.[1];
    assert.ok(file, text);
    calls.push(file);
    if (onWorker) return onWorker(file, request);
    return reply(file, `output ${file}\n`);
  };
}

test('five leads run 105 workers and integrate child files without plan artifacts', async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest('abcde'.split('').map(letter => lead(letter))), { ...options, fetchImpl: workers({ count: 21 }) });
  assert.equal(state.status, 'complete', JSON.stringify(state));
  assert.equal(state.children.length, 5);
  for (const child of state.children) {
    const childState = await readState(options.root, child.run);
    assert.equal(childState.status, 'complete');
    assert.equal(childState.parentRun, state.id);
    assert.equal(childState.leadJob, child.job);
    assert.equal(childState.jobs.length, 21);
  }
  const rollup = rollupRun(state);
  assert.equal(rollup.leads.length, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(rollup)) < 4096);
  assert.match(renderRollupText(rollup), /lead lead-a -> .* complete 21\/21 \$0.00/);
  assert.match(renderMonitorView({ ...state, leads: rollup.leads }), /leads  5 \(5 complete, 0 running\)/);
  const result = await integrateRun(options.root, state.id, options);
  assert.equal(result.children.length, 5);
  assert.equal(result.children.flatMap(child => child.files).length, 105);
  for (const letter of 'abcde') {
    for (let n = 0; n < 21; n++) assert.equal(await fs.readFile(path.join(options.root, `app/${letter}/${n}.txt`), 'utf8'), `output app/${letter}/${n}.txt\n`);
    await assert.rejects(fs.stat(path.join(options.root, `plans/${letter}.json`)), { code: 'ENOENT' });
  }
  await assert.rejects(integrateRun(options.root, state.id, options), /already integrated/);
});

for (const [name, mutate, reason] of [
  ['outside output', child => ({ ...child, jobs: [worker('b', 0)] }), 'outside scope'],
  ['nested lead', child => ({ ...child, jobs: [worker('a', 0, { type: 'lead' })] }), 'depth limit 2'],
  ['child checks', child => ({ ...child, checks: [] }), 'checks'],
]) test(`invalid ${name} fails the lead while a sibling completes`, async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest([lead('a'), lead('b')]), { ...options, fetchImpl: workers({ mutate: (child, letter) => letter === 'a' ? mutate(child) : child }) });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /lead-child-invalid/);
  assert.ok(state.jobs[0].error.includes(reason));
  assert.equal(state.jobs[0].childRun, undefined);
  assert.equal(state.jobs[1].status, 'complete', JSON.stringify(state));
  assert.deepEqual(state.children.map(child => child.job), ['lead-b']);
});

test('manifest rejects overlapping lead areas and area on a worker', () => {
  assert.throws(() => validateManifest(manifest([lead('a'), lead('b', { scope: ['app/a/nested/'] })])), { code: 'lead-scope-overlap' });
  assert.throws(() => validateManifest(manifest([worker('a', 0, { area: lead('a').area })])), { code: 'lead-area-invalid' });
  const job = lead('a'); delete job.area;
  assert.throws(() => validateManifest(manifest([job])), { code: 'lead-area-invalid' });
});

test('parent resume raises a child cap without repeating its lead call', async t => {
  const options = await fixture(t), calls = [];
  const state = await runManifest(options.root, manifest([lead('a', { concurrency: 1, budget: { maxTokens: 100 } })]), { ...options, fetchImpl: workers({ count: 3, calls }) });
  assert.equal(state.status, 'paused', JSON.stringify(state));
  assert.equal(state.jobs[0].heldReason, 'child-paused');
  const resumed = await resumeRun(options.root, state.id, { ...options, fetchImpl: workers({ count: 3, calls }), raises: [{ key: 'maxTokens', value: 1000 }], reason: 'finish approved work' });
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed));
  assert.equal(calls.filter(call => call === 'lead-a').length, 1);
  assert.equal(calls.length, 4);
  assert.equal((await readState(options.root, resumed.jobs[0].childRun)).status, 'complete');
});

test('a larger parent cap does not lift a child area budget', async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest([lead('a', { concurrency: 1, budget: { maxTokens: 100 } })]), { ...options, maxTokens: 1000000, fetchImpl: workers({ count: 3 }) });
  assert.equal(state.status, 'paused', JSON.stringify(state));
  assert.equal((await readState(options.root, state.jobs[0].childRun)).budget.maxTokens, 100);
});

test('parent AbortSignal cancels running children', async t => {
  const options = await fixture(t), controller = new AbortController();
  const state = await runManifest(options.root, manifest([lead('a')]), { ...options, signal: controller.signal, fetchImpl: workers({ onWorker: async (_file, request) => {
    controller.abort();
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } }) });
  const child = await readState(options.root, state.jobs[0].childRun);
  assert.equal(child.status, 'cancelled', JSON.stringify(child));
  assert.match(state.jobs[0].error, /lead-child-cancelled/);
});

test('five leads share one cursor cap of 8, and a 429 pauses cursor for the other children and another repo', async t => {
  const options = await fixture(t);
  const other = await fixture(t);
  const lanesPath = path.join(path.dirname(options.env.SWARM_CONFIG), 'lanes');
  const binDir = path.join(path.dirname(options.env.SWARM_CONFIG), 'bin');
  const versionDir = path.join(path.dirname(options.env.SWARM_CONFIG), 'cursor');
  await fs.mkdir(versionDir, { recursive: true });
  await fs.mkdir(binDir);
  const binary = path.join(versionDir, 'cursor-agent');
  await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.symlink(binary, path.join(binDir, 'cursor-agent'));
  const laneConfig = JSON.stringify({ lanes: { cursor: { concurrency: 8, backoff: { baseMs: 60000, maxMs: 60000 } } } });
  await fs.writeFile(options.env.SWARM_CONFIG, laneConfig);
  await fs.writeFile(other.env.SWARM_CONFIG, laneConfig);
  const env = { ...options.env, PATH: `${binDir}:/usr/bin:/bin`, CURSOR_API_KEY: 'crsr_FAKE_TEST_KEY_0123456789', SWARM_LANES_DIR: lanesPath };
  const otherEnv = { ...other.env, PATH: env.PATH, CURSOR_API_KEY: env.CURSOR_API_KEY, SWARM_LANES_DIR: lanesPath };
  const controller = new AbortController();
  t.after(() => controller.abort());
  let nextPid = 1_000_000;
  const byPid = new Map();
  const counts = { started: 0, active: 0, peak: 0, other: 0 };
  let slotPeak = 0;
  const watch = setInterval(() => {
    try {
      const store = JSON.parse(readFileSync(path.join(lanesPath, 'lanes.json'), 'utf8'));
      slotPeak = Math.max(slotPeak, store.slots?.cursor?.length ?? 0);
    } catch { /* the store appears with the first claim */ }
  }, 10);
  t.after(() => clearInterval(watch));
  const settle = child => {
    if (child.settled) return;
    child.settled = true;
    if (!child.other) counts.active--;
  };
  const killImpl = (pid, signal) => {
    const child = byPid.get(Math.abs(pid));
    if (!child || (child.settled && signal === 0)) throw Object.assign(new Error('no process'), { code: 'ESRCH' });
    if (signal === 0) return;
    if (child.settled) return;
    settle(child);
    setImmediate(() => child.emit('close', null));
  };
  const spawnImpl = (command, args) => {
    assert.equal(command, 'sandbox-exec');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => child.stdout;
    child.stderr.setEncoding = () => child.stderr;
    child.pid = nextPid++;
    child.unref = () => {};
    child.exitCode = null;
    child.signalCode = null;
    child.other = String(args[1] ?? '').startsWith(other.root);
    byPid.set(child.pid, child);
    if (child.other) counts.other++;
    else {
      counts.active++;
      counts.started++;
      counts.peak = Math.max(counts.peak, counts.active);
    }
    return child;
  };
  const cursorJob = (letter, n) => ({ id: `c-${n}`, agent: 'cursor', model: 'composer-2.5', prompt: `Write app/${letter}/${n}.txt`, context: ['input.txt'], outputs: [`app/${letter}/${n}.txt`] });
  const fetchImpl = async (_url, request) => {
    const letter = /Plan area ([a-e])/.exec(JSON.stringify(JSON.parse(request.body)))?.[1];
    assert.ok(letter);
    return reply(`plans/${letter}.json`, JSON.stringify({ version: 1, jobs: [0, 1, 2, 3].map(n => cursorJob(letter, n)) }));
  };
  const waitFor = async (ready, ms, label) => {
    const start = Date.now();
    while (!ready()) {
      if (Date.now() - start > ms) throw new Error(`${label}: ${JSON.stringify({ ...counts, slotPeak })}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  let parentError;
  const parent = runManifest(options.root, manifest('abcde'.split('').map(letter => lead(letter, { agents: ['cursor'], concurrency: 8 }))), {
    ...options, env, signal: controller.signal, fetchImpl, spawnImpl, killImpl,
  }).catch(error => { parentError = error; });
  await waitFor(() => parentError || counts.active >= 8, 30000, 'cursor never reached 8 in flight');
  if (parentError) throw parentError;
  assert.equal(counts.peak, 8);
  assert.ok(slotPeak <= 8, `cursor slots peaked at ${slotPeak}`);
  const victim = [...byPid.values()].find(child => !child.other && !child.settled);
  victim.exitCode = 0;
  victim.stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: '429', is_error: true, result: 'rate limited' })}\n`);
  settle(victim);
  victim.emit('close', 0);
  const pause = () => {
    try { return JSON.parse(readFileSync(path.join(lanesPath, 'lanes.json'), 'utf8')).pauses?.cursor; }
    catch { return null; }
  };
  await waitFor(() => parentError || pause()?.state === 'backoff', 5000, '429 did not pause cursor');
  if (parentError) throw parentError;
  const slotsAtPause = () => {
    try { return JSON.parse(readFileSync(path.join(lanesPath, 'lanes.json'), 'utf8')).slots?.cursor ?? []; }
    catch { return []; }
  };
  const heldIds = new Set(slotsAtPause().map(slot => slot.id));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(counts.started, 8, JSON.stringify(counts));
  assert.ok(slotPeak <= 8, `cursor slots peaked at ${slotPeak}`);
  assert.ok(pause().until > Date.now());
  let outsider;
  const outside = runManifest(other.root, { version: 1, concurrency: 1, jobs: [cursorJob('z', 0)] }, {
    ...other, env: otherEnv, signal: controller.signal, spawnImpl, killImpl, onState: state => { outsider = state; },
  }).catch(error => { parentError ??= error; });
  await waitFor(() => parentError || outsider?.jobs?.length === 1, 10000, 'second repo did not start');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(counts.other, 0, JSON.stringify(counts));
  assert.equal(outsider.jobs[0].status, 'queued');
  assert.ok(slotsAtPause().every(slot => heldIds.has(slot.id)), 'a cursor slot was claimed after the pause');
  controller.abort();
  await Promise.allSettled([parent, outside]);
});
