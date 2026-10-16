// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBakeoff, renderBakeoff } from '../tools/gpu-bakeoff.mjs';

const candidates = [{ label: 'a', model: 'o/a', quant: 'fp8' }];

function fakeDeps(extra = {}) {
  const bestOfCalls = [];
  const deps = {
    now: () => 0,
    start: async c => ({ endpoint: c.label, stop: async () => {} }),
    benchmark: async ({ bestOf }) => {
      bestOfCalls.push(bestOf);
      return bestOf === 3 ? { passed: 8, total: 10 } : { passed: 5, total: 10 };
    },
    throughput: async ({ level }) => ({ level, errorRate: 0, tokPerSec: 10, tokPerSecPerAgent: 10 }),
    ...extra,
  };
  return { bestOfCalls, deps };
}

test('default bestOf benchmarks N=1 then N=3 and reports both, ranking on N=1', async () => {
  const { bestOfCalls, deps } = fakeDeps();
  const { ranked } = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 100 }, deps);
  assert.deepEqual(bestOfCalls, [1, 3]);
  const item = ranked[0];
  assert.deepEqual(item.byBestOf.map(e => e.n), [1, 3]);
  assert.deepEqual(item.byBestOf[0], { n: 1, passed: 5, total: 10, passRate: 0.5 });
  assert.deepEqual(item.byBestOf[1], { n: 3, passed: 8, total: 10, passRate: 0.8 });
  assert.equal(item.passed, 5);
  assert.equal(item.passRate, 0.5);
});

test('bestOf [1] benchmarks once with bestOf 1', async () => {
  const { bestOfCalls, deps } = fakeDeps();
  const { ranked } = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 100, bestOf: [1] }, deps);
  assert.deepEqual(bestOfCalls, [1]);
  assert.deepEqual(ranked[0].byBestOf.map(e => e.n), [1]);
});

test('bestOf [3] alone still runs N=1 first', async () => {
  const { bestOfCalls, deps } = fakeDeps();
  const { ranked } = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 100, bestOf: [3] }, deps);
  assert.deepEqual(bestOfCalls, [1, 3]);
  assert.deepEqual(ranked[0].byBestOf.map(e => e.n), [1, 3]);
  assert.equal(ranked[0].passed, 5);
});

test('cacheStats is called once per model with its endpoint; cacheHitRate is stored, or null without cacheStats', async () => {
  const seen = [];
  const { deps } = fakeDeps({ cacheStats: async o => { seen.push(o); return { hitRate: 0.82 }; } });
  const two = [...candidates, { label: 'b', model: 'o/b', quant: 'fp8' }];
  const { ranked } = await runBakeoff({ candidates: two, hourlyUsd: 1, capUsd: 100 }, deps);
  assert.deepEqual(seen, [{ endpoint: 'a' }, { endpoint: 'b' }]);
  assert.equal(ranked.find(i => i.label === 'a').cacheHitRate, 0.82);
  const none = await runBakeoff({ candidates, hourlyUsd: 1, capUsd: 100 }, fakeDeps().deps);
  assert.equal(none.ranked[0].cacheHitRate, null);
});

test('renderBakeoff shows the N=3 pass count and cache hit, or n/a for both when absent', () => {
  const item = {
    label: 'a', model: 'o/a', quant: 'fp8', passed: 5, total: 10, passRate: 0.5,
    byBestOf: [{ n: 1, passed: 5, total: 10, passRate: 0.5 }, { n: 3, passed: 8, total: 10, passRate: 0.8 }],
    cacheHitRate: 0.82, levels: [{ level: 1, tokPerSec: 10, tokPerSecPerAgent: 10 }],
    agentsPerGpu: 1, costPerPassUsd: 0.5, costUsd: 1, minutes: 30,
  };
  const text = renderBakeoff({ ranked: [item], spentUsd: 1 }, { hourlyUsd: 1, date: '2026-01-01' });
  assert.match(text, /N=3: 8\/10/);
  assert.match(text, /\| 82% \|/);
  const { cacheHitRate, ...noCache } = item;
  const bare = renderBakeoff({ ranked: [{ ...noCache, byBestOf: [item.byBestOf[0]] }], spentUsd: 1 }, { hourlyUsd: 1, date: '2026-01-01' });
  assert.match(bare, /\| n\/a \| n\/a \|/);
  assert.doesNotMatch(bare, /N=3/);
});
