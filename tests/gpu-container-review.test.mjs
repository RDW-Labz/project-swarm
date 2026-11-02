// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuUp, readSessionFile, validateUpOptions, containerStartScript, containerStopScript, remoteStopScript } from '../tools/gpu.mjs';
import { runGpuCommand } from '../tools/gpu-commands.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local, state = '0A') => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0`;
const PROC_DEFAULT = `${HEADER}\n${row('0100007F:1F40')}\n`;
const UP_FLAGS = ['--target', 'ubuntu@203.0.113.9', '--key', '/home/me/.ssh/node', '--model', MODEL, '--hourly-usd', '3', '--max-usd', '6'];
const DESTROY = 'Destroy the instance now (node bench/gpu-bakeoff/vast.mjs destroy).';

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
    openTunnel: async arg => { calls.push({ tunnel: arg.ports }); return { pid: 4242 }; },
    stopTunnel: async pid => { calls.push({ stopped: pid }); },
  };
}

const sshCalls = deps => deps.calls.filter(call => Array.isArray(call.argv));
const scriptCalls = deps => deps.calls.filter(call => typeof call.input === 'string');
const noAuthFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: MODEL }] }) });

for (const mode of ['container', 'vm']) {
  test(`${mode} gpuUp rejects a server that answers without the key`, async t => {
    const env = envFor(t);
    const deps = fakes(env);
    const stopped = [];
    deps.fetchImpl = noAuthFetch;
    deps.openTunnel = async () => ({ pid: 777 });
    deps.stopTunnel = async pid => { stopped.push(pid); };
    await assert.rejects(gpuUp(options({ mode }), deps), /gpu-no-auth/);
    assert.equal(scriptCalls(deps).at(-1).input, mode === 'container' ? containerStopScript() : remoteStopScript());
    assert.equal(readSessionFile(env), null);
    assert.deepEqual(stopped, [777]);
  });
}

test('a server that returns 401 without the key passes', async t => {
  const session = await gpuUp(options({ mode: 'container' }), fakes(envFor(t)));
  assert.equal(session.state, 'up');
});

test('container mode failures end with the destroy reminder', async t => {
  const deps = fakes(envFor(t), { proc: `${HEADER}\n${row('00000000:1F40')}\n` });
  await assert.rejects(gpuUp(options({ mode: 'container' }), deps), err => {
    assert.match(err.message, /gpu-exposed/);
    assert.ok(err.message.endsWith(DESTROY), err.message);
    return true;
  });
});

test('vm mode failures do not mention destroying the instance', async t => {
  const deps = fakes(envFor(t));
  deps.fetchImpl = noAuthFetch;
  await assert.rejects(gpuUp(options({ mode: 'vm' }), deps), err => {
    assert.match(err.message, /gpu-no-auth/);
    assert.equal(err.message.includes('Destroy the instance'), false, err.message);
    return true;
  });
});

test('validateUpOptions refuses server args that set host, port or key', () => {
  for (const bad of ['--host', '--port', '--api-key', '--port=9', '--host=0.0.0.0']) {
    assert.throws(() => validateUpOptions(options({ args: [bad] })), /gpu-option-invalid/, bad);
  }
  assert.doesNotThrow(() => validateUpOptions(options({ args: ['--quantization', 'fp8'] })));
});

test('container stop and timer scripts stop vllm and remove its logs', () => {
  const stop = containerStopScript();
  assert.ok(stop.includes('pgrep'));
  assert.ok(stop.includes('[v]llm serve'));
  assert.ok(stop.includes('"$HOME"/.swarm-vllm-*.log'));
  const lines = stop.split('\n').filter(line => line.trim());
  assert.equal(lines.at(-1), '! pgrep -f "[v]llm serve" >/dev/null 2>&1');
  const timer = containerStartScript({ model: MODEL, gpus: 1, maxModelLen: 4096, perReplica: 8, args: [], seconds: 60, remotePortBase: 8000, apiKey: 'a'.repeat(48) }).split('\n')[0];
  assert.ok(timer.includes('[v]llm serve'));
  assert.ok(timer.includes('.swarm-vllm-*.log'));
  assert.equal(timer.includes('pkill -f "vllm serve"'), false);
});

test('the container exposure check uses the exact /proc command', async t => {
  const deps = fakes(envFor(t));
  await gpuUp(options({ mode: 'container' }), deps);
  const call = sshCalls(deps).find(item => String(item.argv.at(-1)).startsWith('cat /proc/net/tcp'));
  assert.equal(call.argv.at(-1), 'cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null; true');
});

test('an empty /proc reply rejects with gpu-exposure-unknown', async t => {
  const env = envFor(t);
  await assert.rejects(gpuUp(options({ mode: 'container' }), fakes(env, { proc: '' })), /gpu-exposure-unknown/);
  assert.equal(readSessionFile(env), null);
});

test('up registers SIGINT and SIGTERM handlers and removes them when done', async t => {
  const events = [];
  const signalTarget = { once: name => events.push(['once', name]), off: name => events.push(['off', name]) };
  const exits = [];
  await runGpuCommand(['up', ...UP_FLAGS, '--yes', '--mode', 'container'], { out: () => {}, env: envFor(t), gpu: fakes(envFor(t)), signalTarget, exit: code => exits.push(code) });
  assert.deepEqual(events.filter(([kind]) => kind === 'once').map(([, name]) => name), ['SIGINT', 'SIGTERM']);
  for (const name of ['SIGINT', 'SIGTERM']) assert.ok(events.some(([kind, signal]) => kind === 'off' && signal === name));
  assert.deepEqual(exits, []);
});

test('SIGINT during up stops the servers, prints a notice and exits 130', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let onInt;
  const signalTarget = { once: (name, fn) => { if (name === 'SIGINT') onInt = fn; }, off: () => {} };
  deps.openTunnel = async () => { await gate; return { pid: 4242 }; };
  let exited;
  const exitCode = new Promise(resolve => { exited = resolve; });
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  const run = runGpuCommand(['up', ...UP_FLAGS, '--yes', '--mode', 'container'], { out: () => {}, env, gpu: deps, signalTarget, exit: code => exited(code) });
  try {
    onInt();
    const code = await exitCode;
    assert.equal(code, 130);
    assert.ok(scriptCalls(deps).at(-1).input.includes('pkill'));
    assert.ok(written.join('').includes('interrupted'));
  } finally {
    process.stderr.write = realWrite;
    release();
    await run.catch(() => {});
  }
});
