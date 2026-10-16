// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuUp, gpuDown, readSessionFile, validateUpOptions, listeningFromProc, hostFromProcAddr, containerStartScript, containerStopScript } from '../tools/gpu.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local, state = '0A') => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0`;
const PROC_DEFAULT = `${HEADER}\n${row('0100007F:1F40')}\n`;

function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-container-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}

const options = (extra = {}) => ({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, hourlyUsd: 3, maxUsd: 6, pollMs: 1, ...extra });

function fakes(env, { gpus = 1, vllm = '/usr/local/bin/vllm', proc = PROC_DEFAULT, procThrows = false } = {}) {
  const calls = [];
  return {
    calls, env,
    now: () => 1700000000000,
    sleep: async () => {},
    fetchImpl: async (url, init) => (init?.headers?.authorization ? { ok: true, status: 200, json: async () => ({ data: [{ id: MODEL }] }) } : { ok: false, status: 401, json: async () => ({}) }),
    ssh: async (argv, { input } = {}) => {
      calls.push({ argv, input });
      const last = String(argv.at(-1));
      if (last === 'ss -ltnH') return { stdout: '' };
      if (last.startsWith('cat /proc/net/tcp')) {
        if (procThrows) throw new Error('ssh failed');
        return { stdout: proc };
      }
      if (last.startsWith('nvidia-smi -L')) {
        const list = Array.from({ length: gpus }, (_, n) => `GPU ${n}: NVIDIA RTX PRO 6000`).join('\n');
        return { stdout: `${list}\nVLLM:${vllm}\nROOT:0\nSUDO:ok\nDOCKER:28.0.1` };
      }
      return { stdout: '' };
    },
    probePort: async () => false,
    openTunnel: async arg => { calls.push({ tunnel: arg.ports, sshOptions: arg.sshOptions }); return { pid: 4242 }; },
    stopTunnel: async pid => { calls.push({ stopped: pid }); },
  };
}

const sshCalls = deps => deps.calls.filter(call => Array.isArray(call.argv));
const scriptCalls = deps => deps.calls.filter(call => typeof call.input === 'string');

test('listeningFromProc and hostFromProcAddr decode /proc addresses', () => {
  assert.deepEqual(listeningFromProc(PROC_DEFAULT), [{ host: '127.0.0.1', port: 8000 }]);
  assert.equal(hostFromProcAddr('0100007F'), '127.0.0.1');
  assert.equal(hostFromProcAddr('00000000'), '0.0.0.0');
  assert.equal(hostFromProcAddr('00000000000000000000000000000000'), '::');
  assert.equal(hostFromProcAddr('00000000000000000000000001000000'), '::1');
  assert.equal(hostFromProcAddr('0000000000000000FFFF00000100007F'), '::ffff:127.0.0.1');
  const text = [HEADER, row('00000000:1F40'), row('0100007F:1F40', '01')].join('\n');
  assert.deepEqual(listeningFromProc(text), [{ host: '0.0.0.0', port: 8000 }]);
});

test('containerStartScript builds the timer, key handling and one vllm serve per GPU', () => {
  const apiKey = 'a'.repeat(48);
  const script = containerStartScript({ model: MODEL, gpus: 2, maxModelLen: 4096, perReplica: 8, args: ['--quantization', 'fp8'], seconds: 120.4, remotePortBase: 8000, apiKey });
  const lines = script.split('\n');
  assert.ok(lines[0].startsWith('setsid nohup sh -c \'sleep 121; pkill -f "[v]llm serve"'), lines[0]);
  assert.equal(lines[1], 'set -e');
  const launches = lines.filter(line => line.startsWith('CUDA_VISIBLE_DEVICES='));
  assert.equal(launches.length, 2);
  assert.ok(launches[0].startsWith('CUDA_VISIBLE_DEVICES=0 '));
  assert.ok(launches[1].startsWith('CUDA_VISIBLE_DEVICES=1 '));
  assert.ok(launches[0].includes('--port 8000'));
  assert.ok(launches[1].includes('--port 8001'));
  for (const line of launches) {
    assert.ok(line.includes('--host 127.0.0.1'));
    assert.ok(line.includes('--enable-prefix-caching'));
    assert.ok(line.includes('--quantization fp8'));
  }
  assert.equal(script.split(apiKey).length - 1, 1);
  assert.ok(lines.includes(`VLLM_API_KEY=${apiKey}`));
  assert.equal(script.includes('--api-key'), false);
  const body = lines.filter(line => line.trim());
  assert.equal(body.at(-1), 'unset VLLM_API_KEY');
  assert.equal(body.at(-2), 'rm -f "$HOME/.swarm-vllm.env"');
  const exportAt = lines.findIndex(line => line.startsWith('export VLLM_API_KEY='));
  assert.ok(exportAt > 0 && exportAt < lines.findIndex(line => line.startsWith('CUDA_VISIBLE_DEVICES=')), 'the key is read once, before the servers start');
  assert.ok(launches.every(line => !line.includes('VLLM_API_KEY')), 'no per-server key substitution (it raced the env-file removal)');
  assert.equal(script.includes('docker'), false);
  assert.throws(() => containerStartScript({ model: MODEL, gpus: 1, maxModelLen: 4096, perReplica: 8, seconds: 60, remotePortBase: 8000, apiKey: 'xyz' }), /gpu-key-invalid/);
});

test('containerStopScript stops vllm and removes the env file', () => {
  const stop = containerStopScript();
  assert.ok(stop.includes('pkill'));
  assert.ok(stop.includes('rm -f'));
});

test('gpuUp in container mode sends the container script and checks /proc', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  const session = await gpuUp(options({ mode: 'container' }), deps);
  const start = scriptCalls(deps).find(call => call.input.includes('vllm serve'));
  assert.ok(start, 'start script was sent');
  assert.equal(start.input.includes('docker'), false);
  for (const call of sshCalls(deps)) {
    const joined = call.argv.join(' ');
    assert.equal(joined.includes('docker version'), false);
    assert.equal(joined.includes('sudo'), false);
  }
  assert.equal(session.mode, 'container');
  assert.equal(session.powerOff, false);
  assert.ok(sshCalls(deps).some(call => String(call.argv.at(-1)).startsWith('cat /proc/net/tcp')));
  const stored = readSessionFile(env);
  assert.equal(stored.mode, 'container');
  assert.equal(stored.powerOff, false);
});

test('container mode refuses a node without vllm before starting anything', async t => {
  const env = envFor(t);
  const deps = fakes(env, { vllm: '' });
  await assert.rejects(gpuUp(options({ mode: 'container' }), deps), /gpu-no-vllm/);
  assert.equal(scriptCalls(deps).length, 0);
  assert.equal(readSessionFile(env), null);
});

for (const [name, local] of [['0.0.0.0', '00000000:1F40'], ['[::]', '00000000000000000000000000000000:1F40']]) {
  test(`a ${name}:8000 listener makes gpuUp reject and stop the servers`, async t => {
    const env = envFor(t);
    const deps = fakes(env, { proc: `${HEADER}\n${row(local)}\n` });
    await assert.rejects(gpuUp(options({ mode: 'container' }), deps), /gpu-exposed/);
    assert.equal(scriptCalls(deps).at(-1).input, containerStopScript());
    assert.equal(readSessionFile(env), null);
  });
}

test('a listener on 0.0.0.0:22 is fine', async t => {
  const env = envFor(t);
  const deps = fakes(env, { proc: `${HEADER}\n${row('00000000:0016')}\n${row('0100007F:1F40')}\n` });
  const session = await gpuUp(options({ mode: 'container' }), deps);
  assert.equal(session.state, 'up');
});

test('an unreadable /proc listing makes gpuUp reject with gpu-exposure-unknown', async t => {
  const env = envFor(t);
  const deps = fakes(env, { procThrows: true });
  await assert.rejects(gpuUp(options({ mode: 'container' }), deps), /gpu-exposure-unknown/);
  assert.equal(readSessionFile(env), null);
});

test('probePorts are probed on the resolved address and an open one rejects', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  const probed = [];
  deps.probePort = async (address, port) => { probed.push([address, port]); return port === 31337; };
  await assert.rejects(gpuUp(options({ mode: 'container', probePorts: [31337] }), deps), /gpu-exposed/);
  assert.ok(probed.some(([address, port]) => port === 31337 && address === '203.0.113.9'));
});

test('gpuDown for a container session sends the container stop script', async t => {
  const env = envFor(t);
  const up = fakes(env);
  await gpuUp(options({ mode: 'container' }), up);
  const result = await gpuDown({ ssh: up.ssh, stopTunnel: up.stopTunnel, env, now: up.now });
  const stop = scriptCalls(up).at(-1).input;
  assert.ok(stop.includes('pkill'));
  assert.equal(stop.includes('docker'), false);
  assert.ok(result.message.includes('destroy the instance'), result.message);
});

test('gpuDown for a vm session still says terminate the instance', async t => {
  const env = envFor(t);
  const up = fakes(env);
  await gpuUp(options(), up);
  const result = await gpuDown({ ssh: up.ssh, stopTunnel: up.stopTunnel, env, now: up.now });
  assert.ok(result.message.includes('terminate the instance'), result.message);
});

test('validateUpOptions refuses a bad mode and bad probePorts', () => {
  assert.throws(() => validateUpOptions(options({ mode: 'weird' })), /gpu-option-invalid/);
  assert.throws(() => validateUpOptions(options({ probePorts: [70000] })), /gpu-option-invalid/);
  assert.throws(() => validateUpOptions(options({ probePorts: Array.from({ length: 9 }, () => 22) })), /gpu-option-invalid/);
});
