// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuUp, gpuDown, gpuStatus, formatStatus, validateUpOptions, remoteStartScript, sessionHours, parseGpuCount, readSessionFile } from '../tools/gpu.mjs';
import { runBakeoff, measureThroughput, agentsPerGpu, renderBakeoff, selectCandidates } from '../tools/gpu-bakeoff.mjs';
import { createBalancer, balancedFetch, loadRentedConfig, readGpuSession } from '../tools/rented.mjs';
import { routeJob, rentedContractProblem } from '../tools/router.mjs';
import { resolveLanes } from '../tools/lanes.mjs';
import { runGpuCommand, parseGpuFlags } from '../tools/gpu-commands.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';
function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}
const options = (extra = {}) => ({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, hourlyUsd: 3, maxUsd: 6, pollMs: 1, ...extra });
function fakes(env, { gpus = 4, now = () => 1700000000000 } = {}) {
  const calls = [];
  return { calls, env, now, sleep: async () => {}, fetchImpl: async () => ({ ok: true }), ssh: async (argv, { input } = {}) => { calls.push({ argv, input }); return { stdout: argv.at(-1) === 'nvidia-smi -L' ? Array.from({ length: gpus }, (_, n) => `GPU ${n}: NVIDIA RTX PRO 6000`).join('\n') : '' }; }, openTunnel: async ({ ports }) => { calls.push({ tunnel: ports }); return { pid: 4242 }; }, stopTunnel: async pid => { calls.push({ stopped: pid }); } };
}

test('gpu up: one replica per GPU, tunnel ports, expiry = what the cap pays for, nothing but commands sent, no key anywhere', async t => {
  const env = envFor(t), deps = fakes(env);
  const session = await gpuUp(options(), deps);
  assert.equal(session.replicas, 4);
  assert.deepEqual(session.endpoints, [0, 1, 2, 3].map(n => `http://127.0.0.1:${18000 + n}`));
  assert.equal(session.maxHours, 2, '$6 at $3/h is two hours');
  assert.equal(Date.parse(session.expiresAt) - Date.parse(session.startedAt), 2 * 3600000);
  const script = deps.calls.find(call => call.input)?.input;
  assert.equal([...script.matchAll(/docker run -d/g)].length, 4);
  for (const n of [0, 1, 2, 3]) assert.match(script, new RegExp(`--name swarm-vllm-${n} --gpus device=${n} --ipc=host -p 127\\.0\\.0\\.1:${8000 + n}:8000`));
  assert.match(script, /sleep 7200;.*docker rm -f.*shutdown -h now/);
  assert.doesNotMatch(script, /api-key|API_KEY|\.env|scp|HF_TOKEN/i);
  assert.equal(deps.calls.filter(call => call.argv?.includes('scp')).length, 0);
  assert.deepEqual(readSessionFile(env), session);
  assert.equal(JSON.stringify(session).includes('BEGIN'), false);
  assert.ok(deps.calls.every(call => !call.argv || (call.argv.includes('--') && call.argv.includes('BatchMode=yes'))));
});

test('gpu up refuses shell metacharacters, a missing cap, a second session, and caps --gpus at what the node has', async t => {
  for (const bad of [{ model: 'a/b; rm -rf /' }, { target: '-oProxyCommand=x' }, { target: 'a b' }, { maxUsd: undefined }, { hourlyUsd: 0 }, { image: 'x;y' }, { args: ['--x;y'] }, { key: '-oFoo' }]) assert.throws(() => validateUpOptions(options(bad)), /gpu-/);
  const env = envFor(t);
  const deps = fakes(env, { gpus: 2 });
  assert.equal((await gpuUp(options({ gpus: 8 }), deps)).replicas, 2);
  await assert.rejects(gpuUp(options(), deps), /gpu-session-exists/);
});

test('hours: the owner limit and the dollar cap, whichever is shorter', () => {
  assert.equal(sessionHours({ hourlyUsd: 3, maxUsd: 6 }), 2);
  assert.equal(sessionHours({ hourlyUsd: 3, maxUsd: 60, maxHours: 1.5 }), 1.5);
  assert.equal(parseGpuCount('GPU 0: A\nGPU 1: B\nnoise'), 2);
  assert.match(remoteStartScript({ model: MODEL, image: 'vllm/vllm-openai:latest', gpus: 1, maxModelLen: 1000, perReplica: 4, args: ['--quantization', 'fp8'], seconds: 60.2, remotePortBase: 8000 }), /--quantization fp8.*\n.*sleep 61;/);
});

test('an unhealthy replica fails the up with the session still recorded (so down and the timer can clean it)', async t => {
  const env = envFor(t), deps = fakes(env, { gpus: 1 });
  let clock = 1700000000000;
  deps.now = () => clock; deps.sleep = async () => { clock += 600000; }; deps.fetchImpl = async () => { throw new Error('down'); };
  await assert.rejects(gpuUp(options({ healthTimeoutMs: 900000 }), deps), /gpu-unhealthy/);
  assert.ok(readSessionFile(env));
});

test('status and down: cost so far, expiry, the terminate-the-instance reminder; the session file is gone after down', async t => {
  const env = envFor(t), deps = fakes(env);
  await gpuUp(options({ gpus: 2 }), deps);
  let clock = 1700000000000 + 3600000;
  deps.now = () => clock;
  const status = await gpuStatus(deps);
  assert.equal(status.active, true); assert.equal(status.spentUsd, 3); assert.equal(status.minutesLeft, 60); assert.equal(status.replicas.length, 2);
  assert.match(formatStatus(status), /2 of 2 answering.*60 min left.*\$3\.00 of the \$6\.00/s);
  const down = await gpuDown(deps);
  assert.equal(down.stopped, true); assert.equal(down.costUsd, 3);
  assert.match(down.message, /terminate the instance/);
  assert.ok(deps.calls.some(call => call.stopped === 4242));
  assert.equal(readSessionFile(env), null);
  assert.equal((await gpuDown(deps)).stopped, false);
});

test('an expired session is not live: the rented lane is not routable and the config overlay is gone', async t => {
  const env = envFor(t), deps = fakes(env, { gpus: 1 });
  await gpuUp(options(), deps);
  assert.ok(readGpuSession(env, { now: () => 1700000000000 + 3600000 }));
  assert.equal(readGpuSession(env, { now: () => 1700000000000 + 3 * 3600000 }), null);
});

test('a live session lays its replicas over the rented config: no key, loopback only, lane model set, concurrency = replicas x per-replica', async t => {
  const env = envFor(t);
  assert.equal(loadRentedConfig(env).config, null);
  assert.equal(resolveLanes({ config: {}, env }).rented.model, null, 'without a session the lane is never routable');
  await gpuUp(options({ gpus: 3, perReplica: 16, now: undefined }), { ...fakes(env, { gpus: 3, now: () => Date.now() }) });
  const { config } = loadRentedConfig(env);
  assert.equal(config.auth, 'none');
  assert.equal(config.endpoints.length, 3);
  assert.equal(config.concurrency, 48);
  assert.equal(config.model, MODEL);
  const lanes = resolveLanes({ config: {}, env });
  assert.equal(lanes.rented.model, MODEL);
  assert.equal(lanes.rented.concurrency, 48);
});

test('balancer: least in flight, skips a failed replica for the cooldown, retries on the next one', async () => {
  let clock = 0;
  const balancer = createBalancer(['a', 'b', 'c'], { now: () => clock, cooldownMs: 1000 });
  const one = balancer.acquire(), two = balancer.acquire(), three = balancer.acquire();
  assert.deepEqual([one.url, two.url, three.url].sort(), ['a', 'b', 'c']);
  one.release(false);
  two.release(true);
  assert.notEqual(balancer.acquire().url, one.url, 'the failed one is skipped');
  clock = 2000;
  const seen = new Set();
  for (let n = 0; n < 6; n += 1) { const slot = balancer.acquire(); seen.add(slot.url); slot.release(true); }
  assert.ok(seen.has(one.url), 'back after the cooldown');
  const hits = [];
  const response = await balancedFetch(['x', 'y'], async url => { hits.push(url); if (url === 'x') throw new Error('refused'); return { status: 200 }; }, {}, { balancer: createBalancer(['x', 'y']) });
  assert.equal(response.status, 200);
  assert.deepEqual(hits, ['x', 'y']);
  await assert.rejects(balancedFetch(['x'], async () => { throw new Error('down'); }, {}, { balancer: createBalancer(['x']) }), /down/);
});

const lanes = { rented: { model: 'm' }, anthropic: { model: 'claude-haiku-5-5' }, codex: { model: 'c' }, cursor: { model: 'cu' } };
const full = { id: 'j', agent: 'auto', sensitive: false, type: 'build', outputs: ['a.js'], context: ['a.js', 'contract.md'], contract: 'contract.md', acceptance: ['tests/a.test.js passes'] };
test('routing: a complete non-sensitive job goes to rented first; one failure escalates to Haiku, then Codex', () => {
  assert.equal(routeJob(full, { lanes }).agent, 'rented');
  assert.equal(routeJob(full, { lanes, failures: { rented: 1 } }).agent, 'anthropic');
  assert.match(routeJob(full, { lanes, failures: { rented: 1 } }).reason, /Haiku, then Codex/);
  assert.equal(routeJob(full, { lanes, failures: { rented: 1, anthropic: 2 } }).agent, 'codex');
});
test('routing: sensitive jobs, jobs missing files/contract/acceptance, and a lane with no live session never go to rented', () => {
  assert.notEqual(routeJob({ ...full, sensitive: true }, { lanes }).agent, 'rented');
  assert.notEqual(routeJob({ ...full, sensitive: undefined }, { lanes }).agent, 'rented');
  for (const missing of [{ acceptance: undefined }, { contract: undefined }, { outputs: [] }, { context: ['a.js'] }]) assert.notEqual(routeJob({ ...full, ...missing }, { lanes }).agent, 'rented');
  assert.notEqual(routeJob(full, { lanes: { ...lanes, rented: { model: null } } }).agent, 'rented');
  assert.match(rentedContractProblem({ ...full, acceptance: [] }), /acceptance/);
  assert.equal(rentedContractProblem(full), null);
});

test('measureThroughput counts the server\'s tokens and errors; agentsPerGpu picks the highest level that stays healthy', async () => {
  let clock = 0;
  const fetchImpl = async () => { clock += 100; return { ok: true, json: async () => ({ usage: { completion_tokens: 100 } }) }; };
  const result = await measureThroughput({ endpoint: 'http://x', model: 'm', level: 4, rounds: 2, fetchImpl, now: () => clock });
  assert.equal(result.requests, 8); assert.equal(result.tokens, 800); assert.equal(result.errors, 0);
  const failing = await measureThroughput({ endpoint: 'http://x', model: 'm', level: 2, rounds: 1, fetchImpl: async () => ({ ok: false }), now: () => 0 });
  assert.equal(failing.errorRate, 1);
  assert.equal(agentsPerGpu([{ level: 1, errorRate: 0, tokPerSecPerAgent: 90 }, { level: 50, errorRate: 0.01, tokPerSecPerAgent: 25 }, { level: 200, errorRate: 0.2, tokPerSecPerAgent: 4 }]), 50);
  assert.equal(agentsPerGpu([{ level: 1, errorRate: 0.5, tokPerSecPerAgent: 1 }]), 0);
});

test('bake-off: our own tasks decide the ranking; cost per passing task from the model\'s time on the node; the cap stops later models; NVFP4 only as an extra', async () => {
  let clock = 0;
  const started = [], stopped = [];
  const passes = { a: 8, b: 6, c: 8 };
  const candidates = [{ label: 'a', model: 'o/a', quant: 'fp8' }, { label: 'b', model: 'o/b', quant: 'fp8' }, { label: 'c', model: 'o/c', quant: 'fp8' }, { label: 'x', model: 'o/x', quant: 'nvfp4' }];
  const deps = {
    now: () => clock,
    start: async candidate => { started.push(candidate.label); clock += 6 * 60000; return { endpoint: `http://${candidate.label}`, stop: async () => { stopped.push(candidate.label); } }; },
    benchmark: async ({ endpoint }) => { clock += 12 * 60000; return { passed: passes[endpoint.slice(7)] ?? 1, total: 10 }; },
    throughput: async ({ level }) => { clock += 60000; return { level, errorRate: 0, tokPerSec: level * 40, tokPerSecPerAgent: 40 }; },
  };
  const { ranked, spentUsd } = await runBakeoff({ candidates, hourlyUsd: 6, capUsd: 100 }, deps);
  assert.deepEqual(started, ['a', 'b', 'c'], 'the NVFP4 candidate needs includeExtra');
  assert.deepEqual(stopped, ['a', 'b', 'c']);
  assert.deepEqual(ranked.map(item => item.label), ['a', 'c', 'b'], 'ties on pass rate break on cost per passing task, then order');
  const first = ranked[0];
  assert.equal(first.minutes, 21);
  assert.equal(first.costUsd, 2.1, '21 minutes at $6/h');
  assert.equal(first.costPerPassUsd, 0.2625);
  assert.equal(first.agentsPerGpu, 200);
  assert.equal(spentUsd, 6.3);
  clock = 0; started.length = 0;
  const capped = await runBakeoff({ candidates, hourlyUsd: 6, capUsd: 2.5, includeExtra: true }, deps);
  assert.deepEqual(started, ['a', 'b']);
  assert.ok(capped.ranked.filter(item => item.error).every(item => /cap/.test(item.error)) && capped.ranked.filter(item => item.error).length === 2);
  const text = renderBakeoff({ ranked, spentUsd }, { hourlyUsd: 6, date: '2026-10-16' });
  assert.match(text, /\| 1 \| a \| fp8 \| 8\/10 \(80%\) \| 40 \/ 2000 \/ 8000 \|/);
  assert.match(text, /lessons eval set does not exist yet/);
  assert.deepEqual(selectCandidates('qwen3-coder-30b-a3b-fp8,foo/Bar-NVFP4').map(item => item.quant), ['fp8', 'nvfp4']);
  assert.equal(selectCandidates().some(item => item.quant === 'nvfp4'), false, 'the default list is FP8 only');
});

test('a failing model is recorded, not fatal, and its server is still stopped', async () => {
  const stopped = [];
  const { ranked } = await runBakeoff({ candidates: [{ label: 'a', model: 'o/a', quant: 'fp8' }, { label: 'b', model: 'o/b', quant: 'fp8' }], hourlyUsd: 1, capUsd: 100 }, { now: () => 0, start: async c => ({ endpoint: c.label, stop: async () => { stopped.push(c.label); } }), benchmark: async ({ endpoint }) => { if (endpoint === 'a') throw new Error('out of memory'); return { passed: 1, total: 2 }; }, throughput: async ({ level }) => ({ level, errorRate: 0, tokPerSec: 1, tokPerSecPerAgent: 1 }) });
  assert.equal(ranked[0].label, 'b'); assert.match(ranked[1].error, /out of memory/);
  assert.deepEqual(stopped.sort(), ['a', 'b']);
});

test('swarm gpu: without --yes it only prints the plan; flags are strict; bake-off plans one GPU and names the models', async () => {
  const lines = [], env = {};
  const base = ['--target', 'ubuntu@203.0.113.9', '--key', '~/.ssh/k', '--hourly-usd', '3', '--max-usd', '6'];
  const touched = [];
  const gpu = { ssh: async () => { touched.push('ssh'); return { stdout: '' }; } };
  assert.equal((await runGpuCommand(['up', ...base, '--model', MODEL], { out: x => lines.push(x), env, gpu })).status, 'planned');
  assert.equal((await runGpuCommand(['bakeoff', ...base, '--extra-quant'], { out: x => lines.push(x), env, gpu })).status, 'planned');
  assert.deepEqual(touched, []);
  assert.match(lines.join('\n'), /nothing is started yet.*sent to the node: commands only; no files, keys or \.env.*only sensitive: false/s);
  assert.match(lines.join('\n'), /qwen3\.6-35b-a3b-fp8.*NVFP4 extras/s);
  assert.throws(() => parseGpuFlags(['--nope']), /gpu-usage/);
  assert.throws(() => parseGpuFlags(['--target']), /needs a value/);
  await assert.rejects(runGpuCommand(['up', ...base], { out: () => {}, env }), /gpu-model-invalid/);
  await assert.rejects(runGpuCommand(['launch'], { out: () => {}, env }), /gpu-usage/);
});
