// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_IMAGE, GPU_DEFAULTS, remoteStartScript, containerStartScript } from '../tools/gpu.mjs';
import { measureThroughput, agentsPerGpu, runUnderLoad, runBakeoff } from '../tools/gpu-bakeoff.mjs';

const base = { model: 'o/a', gpus: 1, maxModelLen: 131072, perReplica: 192, args: [], seconds: 60, remotePortBase: 8000, apiKey: 'a'.repeat(48) };

test('PINNED_IMAGE is pinned to the v0.31.0 digest', () => {
  assert.ok(PINNED_IMAGE.endsWith('@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3'));
});

test('both start scripts carry the 0.93 memory flags and not the old 0.9 value', () => {
  const required = ['--gpu-memory-utilization 0.93', '--kv-cache-dtype fp8', '--enable-prefix-caching', '--mamba-cache-mode align', '--max-num-batched-tokens 16384'];
  const scripts = [remoteStartScript({ ...base, image: PINNED_IMAGE }), containerStartScript(base)];
  for (const script of scripts) {
    for (const flag of required) assert.ok(script.includes(flag), flag);
    assert.ok(!script.includes('--gpu-memory-utilization 0.9 '));
  }
});

test('container script puts env right after CUDA_VISIBLE_DEVICES=0', () => {
  const script = containerStartScript({ ...base, env: { VLLM_HAS_FLASHINFER_CUBIN: '1' } });
  assert.ok(script.includes('CUDA_VISIBLE_DEVICES=0 VLLM_HAS_FLASHINFER_CUBIN=1 '));
});

test('remote script passes env as docker -e flags on the run line', () => {
  const script = remoteStartScript({ ...base, image: PINNED_IMAGE, env: { VLLM_HAS_FLASHINFER_CUBIN: '1' } });
  const runLine = script.split('\n').find(line => line.startsWith('docker run'));
  assert.ok(runLine.includes('-e VLLM_HAS_FLASHINFER_CUBIN=1'));
});

test('invalid env throws gpu-env-invalid from both scripts', () => {
  const bad = [
    { lower_case: '1' },
    { A: 'x y' },
    { A: 'x;y' },
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`V${i}`, '1'])),
  ];
  for (const env of bad) {
    assert.throws(() => remoteStartScript({ ...base, image: PINNED_IMAGE, env }), /gpu-env-invalid/);
    assert.throws(() => containerStartScript({ ...base, env }), /gpu-env-invalid/);
  }
});

test('GPU_DEFAULTS.maxModelLen is 131072', () => {
  assert.equal(GPU_DEFAULTS.maxModelLen, 131072);
});

const lv = (level, msPerToken, errorRate = 0) => ({ level, msPerToken, errorRate });

test('agentsPerGpu picks the highest level under 35 ms per token', () => {
  assert.equal(agentsPerGpu([lv(32, 20), lv(64, 30), lv(96, 34), lv(128, 36), lv(192, 50)]), 96);
});

test('agentsPerGpu ignores levels with too many errors', () => {
  assert.equal(agentsPerGpu([lv(32, 20), lv(64, 10, 0.1)]), 32);
});

test('agentsPerGpu is 0 when no level is under 35 ms per token', () => {
  assert.equal(agentsPerGpu([lv(32, 40)]), 0);
});

test('agentsPerGpu works from tokPerSecPerAgent alone', () => {
  assert.equal(agentsPerGpu([{ level: 64, errorRate: 0, tokPerSecPerAgent: 30 }]), 64);
});

test('measureThroughput reports msPerToken from tokPerSecPerAgent', async () => {
  let clock = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ usage: { completion_tokens: 100 } }) });
  const r = await measureThroughput({ endpoint: 'http://x', model: 'm', level: 2, rounds: 1, fetchImpl, now: () => (clock += 1000) });
  assert.equal(r.msPerToken, Math.round((1000 / r.tokPerSecPerAgent) * 10) / 10);
  assert.ok(r.msPerToken > 0);
});

test('runUnderLoad runs the requested loops during fn and stops them after', async () => {
  let inflight = 0, maxInflight = 0, calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inflight -= 1;
    return { ok: true, text: async () => '{}' };
  };
  const result = await runUnderLoad({ endpoint: 'http://x', model: 'm', agents: 3, fetchImpl }, async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(maxInflight, 3);
  const after = calls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, after);
});

test('runUnderLoad with agents 0 just returns the fn result', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true }; };
  assert.equal(await runUnderLoad({ endpoint: 'http://x', model: 'm', agents: 0, fetchImpl }, async () => 'x'), 'x');
  assert.equal(calls, 0);
});

test('runUnderLoad stops its loops and rethrows when fn throws', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 2));
    return { ok: true, text: async () => '{}' };
  };
  await assert.rejects(runUnderLoad({ endpoint: 'http://x', model: 'm', agents: 2, fetchImpl }, async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('boom');
  }), /boom/);
  const after = calls;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, after);
});

const one = [{ label: 'a', model: 'o/a', quant: 'fp8' }];

const sweepThroughput = async ({ level }) => {
  const ms = { 32: 20, 64: 30, 96: 40 }[level];
  return { level, errorRate: 0, tokPerSec: 1, tokPerSecPerAgent: 1000 / ms, msPerToken: ms };
};

test('runBakeoff chooses 64 agents, runs best-of under that load, and calls cacheStats once per level', async () => {
  const contexts = [];
  const seen = [];
  let cacheCalls = 0;
  const { ranked } = await runBakeoff({ candidates: one, hourlyUsd: 1, capUsd: 100, levels: [32, 64, 96], bestOf: [3] }, {
    start: async () => ({ endpoint: 'http://e', stop: async () => {} }),
    throughput: sweepThroughput,
    cacheStats: async () => { cacheCalls += 1; return { hitRate: 0.5 }; },
    benchmark: async ({ bestOf }) => { seen.push(bestOf); return { passed: 5, total: 10 }; },
    withLoad: async (context, fn) => { contexts.push(context); return fn(); },
  });
  assert.deepEqual(seen, [1, 3]);
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every(context => context.agents === 64));
  assert.equal(cacheCalls, 3);
  assert.equal(ranked[0].chosenAgents, 64);
  assert.equal(ranked[0].agentsPerGpu, 64);
  assert.equal(ranked[0].cacheHitRate, 0.5);
});

function clockDeps() {
  let clock = 0;
  return {
    now: () => clock,
    start: async () => ({ endpoint: 'http://e', stop: async () => {} }),
    throughput: async ({ level }) => ({ level, errorRate: 0, tokPerSec: 1, tokPerSecPerAgent: 50, msPerToken: 20 }),
    benchmark: async ({ candidate }) => {
      clock += (candidate.hours ?? 0) * 3600000;
      return { passed: 5, total: 10 };
    },
  };
}

test('runBakeoff ranks the lower cost per passing task first', async () => {
  const candidates = [
    { label: 'slow', model: 'o/slow', quant: 'fp8', hours: 2 },
    { label: 'fast', model: 'o/fast', quant: 'fp8', hours: 1 },
  ];
  const { ranked } = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 100, levels: [32], bestOf: [1] }, clockDeps());
  assert.deepEqual(ranked.map(item => item.label), ['fast', 'slow']);
});

test('optional candidate is skipped when under an hour of cap is left', async () => {
  const candidates = [
    { label: 'big', model: 'o/big', quant: 'fp8', hours: 9.5 },
    { label: 'opt', model: 'o/opt', quant: 'fp8', optional: true },
  ];
  const { ranked } = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 10, levels: [32], bestOf: [1] }, clockDeps());
  const opt = ranked.find(item => item.label === 'opt');
  assert.match(opt.error, /skipped/);
});

test('optional candidate runs when plenty of cap is left', async () => {
  const candidates = [
    { label: 'big', model: 'o/big', quant: 'fp8', hours: 0 },
    { label: 'opt', model: 'o/opt', quant: 'fp8', optional: true },
  ];
  const { ranked } = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 10, levels: [32], bestOf: [1] }, clockDeps());
  const opt = ranked.find(item => item.label === 'opt');
  assert.equal(opt.error, undefined);
  assert.equal(opt.passed, 5);
});
