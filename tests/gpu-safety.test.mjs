// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PINNED_IMAGE, gpuUp, gpuStatus, validateUpOptions, readSessionFile } from '../tools/gpu.mjs';
import { loadRentedConfig, validateRentedConfig, gpuSessionPath } from '../tools/rented.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';
const KEY = 'ab'.repeat(24);

function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}

const options = (extra = {}) => ({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, hourlyUsd: 3, maxUsd: 6, pollMs: 1, ...extra });

function fakes(env, { gpus = 4, now = () => 1700000000000, sudo = 'ok', ssOutput = '' } = {}) {
  const calls = [];
  return {
    calls, env, now,
    sleep: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: MODEL }] }) }),
    ssh: async (argv, { input } = {}) => {
      calls.push({ argv, input });
      const last = String(argv.at(-1));
      if (last === 'ss -ltnH') return { stdout: ssOutput };
      return { stdout: last.startsWith('nvidia-smi -L') ? Array.from({ length: gpus }, (_, n) => `GPU ${n}: NVIDIA RTX PRO 6000`).join('\n') + `\nSUDO:${sudo}` : '' };
    },
    probePort: async () => false,
    openTunnel: async ({ ports }) => { calls.push({ tunnel: ports }); return { pid: 4242 }; },
    stopTunnel: async pid => { calls.push({ stopped: pid }); },
  };
}

test('default image is the pinned digest, every docker run uses it, and tags are refused', async t => {
  assert.match(PINNED_IMAGE, /@sha256:[0-9a-f]{64}$/);
  const env = envFor(t), deps = fakes(env, { gpus: 2 });
  await gpuUp(options(), deps);
  const script = deps.calls.find(call => call.input)?.input;
  const runs = script.split('\n').filter(line => line.includes('docker run -d'));
  assert.equal(runs.length, 2);
  for (const line of runs) assert.ok(line.includes(PINNED_IMAGE));
  for (const image of ['vllm/vllm-openai:latest', 'vllm/vllm-openai:v0.27.1', 'vllm/vllm-openai']) assert.throws(() => validateUpOptions(options({ image })), /gpu-image-invalid/);
  assert.doesNotThrow(() => validateUpOptions(options({ image: `vllm/vllm-openai@sha256:${'a'.repeat(64)}` })));
});

test('each rental gets its own key: the start script carries it once, health checks send it, a short key is refused before ssh', async t => {
  const env = envFor(t), deps = fakes(env, { gpus: 1 });
  const seen = [];
  deps.randomKey = () => KEY;
  deps.fetchImpl = async (url, init) => { seen.push(init?.headers?.authorization); return { ok: true, json: async () => ({ data: [{ id: MODEL }] }) }; };
  const session = await gpuUp(options(), deps);
  assert.equal(session.apiKey, KEY);
  const script = deps.calls.find(call => call.input)?.input;
  assert.equal(script.split('\n').filter(line => line === `VLLM_API_KEY=${KEY}`).length, 1);
  assert.equal(script.split('VLLM_API_KEY=').length - 1, 1);
  assert.doesNotMatch(script, /--api-key/);
  assert.ok(seen.length > 0);
  for (const value of seen) assert.equal(value, `Bearer ${KEY}`);
  const shortDeps = fakes(envFor(t), { gpus: 1 });
  shortDeps.randomKey = () => 'abc';
  await assert.rejects(gpuUp(options(), shortDeps), /gpu-key-invalid/);
  assert.equal(shortDeps.calls.length, 0);
  const a = fakes(envFor(t), { gpus: 1 }), b = fakes(envFor(t), { gpus: 1 });
  const ka = (await gpuUp(options(), a)).apiKey, kb = (await gpuUp(options(), b)).apiKey;
  assert.match(ka, /^[0-9a-f]{48}$/);
  assert.notEqual(ka, kb);
});

test('the key never reaches log lines or error messages, and status sends it as a Bearer header', async t => {
  const logs = [];
  const env = envFor(t);
  const deps = { ...fakes(env, { gpus: 1 }), randomKey: () => KEY, log: m => logs.push(String(m)) };
  await gpuUp(options(), deps);
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('\n').includes(KEY));
  let clock = 1700000000000;
  const bad = { ...fakes(envFor(t), { gpus: 1 }), randomKey: () => KEY, log: m => logs.push(String(m)), now: () => clock, sleep: async () => { clock += 600000; }, fetchImpl: async () => { throw new Error('down'); } };
  const error = await gpuUp(options({ healthTimeoutMs: 900000 }), bad).then(() => null, e => e);
  assert.match(error.message, /gpu-unhealthy/);
  assert.ok(!error.message.includes(KEY));
  assert.ok(!logs.join('\n').includes(KEY));
  const seen = [];
  await gpuStatus({ env, now: () => clock, fetchImpl: async (url, init) => { seen.push(init?.headers?.authorization); return { ok: false }; } });
  assert.ok(seen.length > 0);
  for (const value of seen) assert.equal(value, `Bearer ${KEY}`);
});

test('exposure: probePort is asked about each replica port; a reachable one stops the servers and fails the up', async t => {
  const env = envFor(t), deps = fakes(env, { gpus: 2 });
  const probed = [];
  deps.probePort = async (host, port) => { probed.push([host, port]); return port === 8001; };
  const error = await gpuUp(options(), deps).then(() => null, e => e);
  assert.match(error.message, /gpu-exposed/);
  assert.deepEqual(probed, [['203.0.113.9', 8000], ['203.0.113.9', 8001]]);
  const startIdx = deps.calls.findIndex(call => call.input?.includes('docker run'));
  const stopIdx = deps.calls.findIndex((call, i) => i > startIdx && call.input?.includes('docker rm -f'));
  assert.ok(startIdx >= 0 && stopIdx > startIdx);
  assert.ok(error.session);
  assert.equal(error.session.apiKey, undefined, 'the error never carries the key');
  assert.equal(readSessionFile(env), null, 'the session is removed so the lane cannot use it');
  const ok = fakes(envFor(t), { gpus: 2 });
  const probedAll = [];
  ok.probePort = async (host, port) => { probedAll.push(port); return false; };
  assert.equal((await gpuUp(options(), ok)).replicas, 2);
  assert.deepEqual(probedAll, [8000, 8001, 8000, 8001], 'checked right after the start and again once the servers answer');
});

test('node-side ss check: a non-loopback listener on a replica port fails the up; loopback and port 22 pass', async t => {
  const exposed = ['LISTEN 0 4096 0.0.0.0:8001 0.0.0.0:*', 'LISTEN 0 4096 *:8001 *:*', 'LISTEN 0 4096 [::]:8001 [::]:*'];
  for (const ss of exposed) {
    const deps = fakes(envFor(t), { gpus: 2, ssOutput: ss });
    await assert.rejects(gpuUp(options(), deps), /gpu-exposed/);
  }
  for (const ss of ['LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:*', 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*']) {
    const deps = fakes(envFor(t), { gpus: 2, ssOutput: ss });
    assert.equal((await gpuUp(options(), deps)).replicas, 2);
  }
});

test('config: a live session reads as session auth with its key; a session without a key reads as auth none', async t => {
  const env = envFor(t);
  const deps = { ...fakes(env, { gpus: 1, now: () => Date.now() }), randomKey: () => KEY };
  const session = await gpuUp(options(), deps);
  const { config } = loadRentedConfig(env);
  assert.equal(config.auth, 'session');
  assert.equal(config.sessionKey, session.apiKey);
  const copy = readSessionFile(env);
  delete copy.apiKey;
  fs.writeFileSync(gpuSessionPath(env), JSON.stringify(copy));
  assert.equal(loadRentedConfig(env).config.auth, 'none');
  const { errors } = validateRentedConfig({ endpoint: 'http://127.0.0.1:18000', model: MODEL, hourlyUsd: 3, auth: 'session' });
  assert.ok(errors.some(e => /sessionKey/.test(e)));
});
