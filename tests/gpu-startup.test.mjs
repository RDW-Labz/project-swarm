// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gpuUp, readSessionFile, GPU_DEFAULTS, SHORTLIST } from '../tools/gpu.mjs';

const MODEL = 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8';
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local, state = '0A') => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0`;
const PROC_DEFAULT = `${HEADER}\n${row('0100007F:1F40')}\n`;

function envFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  return { ...process.env, SWARM_CONFIG: file };
}

const options = (extra = {}) => ({ target: 'ubuntu@203.0.113.9', key: '/home/me/.ssh/node', model: MODEL, hourlyUsd: 3, maxUsd: 6, pollMs: 1, ...extra });

function fakes(env, { gpus = 1, vllm = '/usr/local/bin/vllm', proc = PROC_DEFAULT } = {}) {
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
      if (last.startsWith('cat /proc/net/tcp')) return { stdout: proc };
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

const scriptCalls = deps => deps.calls.filter(call => typeof call.input === 'string');

// Answers the ssh call whose last argument contains match; answer may be an Error to throw.
function overrideSsh(deps, match, answer) {
  const base = deps.ssh;
  deps.ssh = async (argv, opts) => {
    if (!String(argv.at(-1)).includes(match)) return base(argv, opts);
    deps.calls.push({ argv, input: opts?.input });
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return deps;
}

// Fake clock: each sleep advances time by 5 seconds.
function advancingClock(deps) {
  let t = 1700000000000;
  deps.now = () => t;
  deps.sleep = async () => { t += 5000; };
}

// Fetch that throws for the first failures calls, then answers 200 with the key and 401 without it.
function flakyFetch(failures) {
  const seen = { n: 0 };
  const fetchImpl = async (url, init) => {
    seen.n += 1;
    if (seen.n <= failures) throw new Error('starting');
    return init?.headers?.authorization ? { ok: true, status: 200, json: async () => ({ data: [{ id: MODEL }] }) } : { ok: false, status: 401, json: async () => ({}) };
  };
  return { fetchImpl, seen };
}

test('dead server fails fast with the server log (container mode)', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  advancingClock(deps);
  let attempts = 0;
  deps.fetchImpl = async () => { attempts += 1; throw new Error('refused'); };
  overrideSsh(deps, 'pgrep -f', 'DEAD\nValueError: Invalid prefix_match_unit=64\nsecond line');
  await assert.rejects(gpuUp(options({ mode: 'container', healthTimeoutMs: 1200000 }), deps), err => {
    assert.match(err.message, /gpu-server-died/);
    assert.ok(err.message.includes('Invalid prefix_match_unit=64'), err.message);
    assert.ok(err.message.includes('second line'), err.message);
    return true;
  });
  assert.ok(attempts > 0 && attempts < 20, String(attempts));
  assert.ok(scriptCalls(deps).some(call => call.input.includes('pkill')));
  assert.equal(readSessionFile(env), null);
});

test('an ALIVE answer keeps polling until the server answers', async t => {
  const deps = fakes(envFor(t));
  const { fetchImpl, seen } = flakyFetch(3);
  deps.fetchImpl = fetchImpl;
  overrideSsh(deps, 'pgrep -f', 'ALIVE');
  const session = await gpuUp(options({ mode: 'container' }), deps);
  assert.equal(session.state, 'up');
  assert.ok(seen.n >= 4, String(seen.n));
});

test('an empty or odd alive answer counts as alive', async t => {
  for (const answer of ['', 'odd output']) {
    const deps = fakes(envFor(t));
    deps.fetchImpl = flakyFetch(1).fetchImpl;
    overrideSsh(deps, 'pgrep -f', answer);
    const session = await gpuUp(options({ mode: 'container' }), deps);
    assert.equal(session.state, 'up', answer);
  }
});

test('a thrown error from the alive ssh call counts as alive', async t => {
  const deps = fakes(envFor(t));
  deps.fetchImpl = flakyFetch(1).fetchImpl;
  overrideSsh(deps, 'pgrep -f', new Error('ssh dropped'));
  const session = await gpuUp(options({ mode: 'container' }), deps);
  assert.equal(session.state, 'up');
});

test('docker mode: a dead swarm-vllm-0 container fails with gpu-server-died', async t => {
  const env = envFor(t);
  const deps = fakes(env);
  advancingClock(deps);
  deps.fetchImpl = async () => { throw new Error('refused'); };
  overrideSsh(deps, 'docker ps -q --filter name=swarm-vllm-0', 'DEAD\nsome docker log');
  await assert.rejects(gpuUp(options({ healthTimeoutMs: 1200000 }), deps), /gpu-server-died/);
  assert.equal(readSessionFile(env), null);
});

test('startup flags per model', () => {
  assert.equal(GPU_DEFAULTS.commonArgs.includes('--prefix-match-unit'), false);
  assert.equal(GPU_DEFAULTS.perReplica, 128);
  // The rented lane default is only the Qwen3.6-35B-A3B NVFP4 entry.
  assert.equal(SHORTLIST.length, 1);
  assert.equal(SHORTLIST[0].label, 'qwen3.6-35b-a3b-nvfp4');
  const qwen = SHORTLIST[0].args;
  const at = qwen.indexOf('--prefix-match-unit');
  assert.ok(at >= 0);
  assert.equal(qwen[at + 1], '64');
  const quant = qwen.indexOf('--quantization');
  assert.ok(quant >= 0);
  assert.equal(qwen[quant + 1], 'modelopt_fp4');
  assert.equal(qwen.includes('--moe-backend'), false);
  // The removed Lightning and Coder-Next entries must stay out of the shortlist.
  const labels = SHORTLIST.map(item => item.label);
  assert.equal(labels.includes('nemotron-3.5-lightning-nvfp4'), false);
  assert.equal(labels.includes('qwen3-coder-next-nvfp4'), false);
});
