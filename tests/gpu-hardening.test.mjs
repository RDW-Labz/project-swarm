// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuUp, gpuDown, gpuStatus, formatStatus, validateUpOptions, readSessionFile, SSH_HARDENING } from '../tools/gpu.mjs';
import { gpuSessionPath } from '../tools/rented.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';
const T0 = 1700000000000;
function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}
const options = (extra = {}) => ({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, hourlyUsd: 3, maxUsd: 6, pollMs: 1, ...extra });
function fakes(env, { gpus = 4, now = () => T0, sudo = 'ok' } = {}) {
  const calls = [];
  return { calls, env, now, sleep: async () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: MODEL }] }) }), ssh: async (argv, { input } = {}) => { calls.push({ argv, input }); return { stdout: String(argv.at(-1)).startsWith('nvidia-smi -L') ? Array.from({ length: gpus }, (_, n) => `GPU ${n}: NVIDIA RTX PRO 6000`).join('\n') + `\nSUDO:${sudo}` : '' }; }, openTunnel: async ({ ports }) => { calls.push({ tunnel: ports }); return { pid: 4242 }; }, stopTunnel: async pid => { calls.push({ stopped: pid }); } };
}
function handSession(env, extra) {
  const file = gpuSessionPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, endpoints: [], startedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 3600000).toISOString(), hourlyUsd: 3, state: 'up', ...extra }));
}

test('every ssh call has the hardening flags, ClearAllForwardings and -- before the target', async t => {
  const deps = fakes(envFor(t));
  await gpuUp(options(), deps);
  const calls = deps.calls.filter(call => call.argv);
  assert.ok(calls.length >= 2);
  for (const { argv } of calls) {
    for (const flag of SSH_HARDENING) assert.ok(argv.includes(flag));
    assert.ok(argv.includes('ClearAllForwardings=yes'));
    const dash = argv.indexOf('--');
    assert.ok(dash >= 0);
    assert.equal(argv[dash + 1], 'ubuntu@203.0.113.9');
  }
});

test('the dead-man timer is set before set -e and the first docker run', async t => {
  const deps = fakes(envFor(t));
  await gpuUp(options(), deps);
  const script = deps.calls.find(call => call.input).input;
  const timer = script.indexOf('setsid nohup sh -c');
  assert.ok(timer >= 0);
  assert.ok(timer < script.indexOf('set -e'));
  assert.ok(timer < script.indexOf('docker run'));
});

test('no passwordless sudo: refused before anything starts, unless allowNoPowerOff', async t => {
  const env = envFor(t);
  const deps = fakes(env, { sudo: 'no' });
  await assert.rejects(gpuUp(options(), deps), /gpu-sudo/);
  assert.equal(deps.calls.filter(call => call.input).length, 0);
  assert.equal(readSessionFile(env), null);
  const session = await gpuUp(options({ allowNoPowerOff: true }), fakes(envFor(t), { sudo: 'no' }));
  assert.equal(session.powerOff, false);
  const normal = await gpuUp(options(), fakes(envFor(t)));
  assert.equal(normal.powerOff, true);
});

test('session file is mode 0600 and up; a failed start leaves starting, and down removes it', async t => {
  const env = envFor(t);
  await gpuUp(options(), fakes(env));
  assert.equal(fs.statSync(gpuSessionPath(env)).mode & 0o777, 0o600);
  assert.equal(readSessionFile(env).state, 'up');
  const env2 = envFor(t);
  const broken = fakes(env2);
  const working = broken.ssh;
  broken.ssh = async (argv, opts) => { if (opts?.input !== undefined) throw new Error('start failed'); return working(argv, opts); };
  await assert.rejects(gpuUp(options(), broken));
  assert.equal(readSessionFile(env2).state, 'starting');
  broken.ssh = working;
  await gpuDown(broken);
  assert.equal(readSessionFile(env2), null);
});

test('a second up is refused even with replace', async t => {
  const env = envFor(t);
  await gpuUp(options(), fakes(env));
  await assert.rejects(gpuUp(options({ replace: true }), fakes(env)), /gpu-session-exists/);
});

test('health requires the requested model id', async t => {
  let clock = T0;
  const deps = fakes(envFor(t), { gpus: 1 });
  deps.now = () => clock;
  deps.sleep = async () => { clock += 600000; };
  deps.fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'other/model' }] }) });
  await assert.rejects(gpuUp(options({ healthTimeoutMs: 900000 }), deps), /gpu-unhealthy/);
});

test('down stops the tunnel only for an integer pid above 1', async t => {
  for (const pid of [-1, 1, 4242]) {
    const env = envFor(t);
    handSession(env, { tunnelPid: pid });
    const stops = [];
    await gpuDown({ ssh: async () => ({ stdout: '' }), stopTunnel: async (p, s) => { stops.push([p, s.target]); }, env, now: () => T0 });
    assert.deepEqual(stops, pid === 4242 ? [[4242, 'ubuntu@203.0.113.9']] : []);
  }
});

test('down with ssh failing says so, keeps the reminder, and removes the session', async t => {
  const env = envFor(t);
  handSession(env, { tunnelPid: null });
  const result = await gpuDown({ ssh: async () => { throw new Error('no route'); }, stopTunnel: async () => {}, env, now: () => T0 });
  assert.ok(result.message.startsWith('Could not stop the servers over ssh'));
  assert.match(result.message, /terminate the instance/);
  assert.equal(readSessionFile(env), null);
});

test('after expiry: not active, spend keeps counting past the cap, reminder shown', async t => {
  const env = envFor(t);
  await gpuUp(options(), fakes(env, { gpus: 1 }));
  const late = T0 + 10 * 3600000;
  const status = await gpuStatus({ env, fetchImpl: async () => ({ ok: true }), now: () => late });
  assert.equal(status.active, false);
  assert.equal(status.expired, true);
  assert.equal(status.spentUsd, 30);
  assert.match(formatStatus(status), /terminate the instance/);
});

test('routable false is stored in the session', async t => {
  const session = await gpuUp(options({ routable: false }), fakes(envFor(t)));
  assert.equal(session.routable, false);
});

test('image digest pins are accepted; shell metacharacters are still refused', () => {
  assert.doesNotThrow(() => validateUpOptions(options({ image: 'vllm/vllm-openai@sha256:' + 'a'.repeat(64) })));
  assert.throws(() => validateUpOptions(options({ image: 'x;y' })), /gpu-image-invalid/);
});

test('at most 16 replicas even when the node has 40 GPUs', async t => {
  const deps = fakes(envFor(t), { gpus: 40 });
  const session = await gpuUp(options(), deps);
  assert.equal(session.replicas, 16);
  const script = deps.calls.find(call => call.input).input;
  assert.equal([...script.matchAll(/docker run -d/g)].length, 16);
});
