// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCacheStats, fetchCacheStats, combineCacheStats } from '../tools/gpu-cache.mjs';

test('parseCacheStats reads unlabelled counters and computes hit rate', () => {
  const text = 'vllm:prefix_cache_hits_total 30\nvllm:prefix_cache_queries_total 120\n';
  assert.deepEqual(parseCacheStats(text), { hits: 30, queries: 120, hitRate: 0.25 });
});

test('parseCacheStats handles labelled series and accepts gpu_ prefixed names', () => {
  const text = [
    'vllm:gpu_prefix_cache_hits_total{model="a"} 10',
    'vllm:gpu_prefix_cache_queries_total{model="a"} 40',
  ].join('\n');
  assert.deepEqual(parseCacheStats(text), { hits: 10, queries: 40, hitRate: 0.25 });
});

test('parseCacheStats ignores comment lines', () => {
  const text = [
    '# HELP vllm:prefix_cache_hits_total hits',
    '# TYPE vllm:prefix_cache_hits_total counter',
    'vllm:prefix_cache_hits_total 5',
    '# HELP vllm:prefix_cache_queries_total queries',
    'vllm:prefix_cache_queries_total 10',
  ].join('\n');
  assert.deepEqual(parseCacheStats(text), { hits: 5, queries: 10, hitRate: 0.5 });
});

test('parseCacheStats parses exponent values', () => {
  const text = 'vllm:prefix_cache_hits_total 1.2e+03\nvllm:prefix_cache_queries_total 2.4e+03\n';
  assert.deepEqual(parseCacheStats(text), { hits: 1200, queries: 2400, hitRate: 0.5 });
});

test('parseCacheStats sums two labelled series of the same counter', () => {
  const text = [
    'vllm:prefix_cache_hits_total{engine="0"} 3',
    'vllm:prefix_cache_hits_total{engine="1"} 7',
    'vllm:prefix_cache_queries_total{engine="0"} 10',
    'vllm:prefix_cache_queries_total{engine="1"} 10',
  ].join('\n');
  assert.deepEqual(parseCacheStats(text), { hits: 10, queries: 20, hitRate: 0.5 });
});

test('parseCacheStats uses a gauge when no counters exist', () => {
  const text = 'vllm:gpu_prefix_cache_hit_rate 0.4321\n';
  assert.deepEqual(parseCacheStats(text), { hits: null, queries: null, hitRate: 0.4321 });
});

test('parseCacheStats returns nulls for empty text', () => {
  assert.deepEqual(parseCacheStats(''), { hits: null, queries: null, hitRate: null });
});

test('fetchCacheStats parses an ok response and requests /metrics', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      text: async () => 'vllm:prefix_cache_hits_total 1\nvllm:prefix_cache_queries_total 4\n',
    };
  };
  const stats = await fetchCacheStats('http://localhost:8000', fakeFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'http://localhost:8000/metrics');
  assert.deepEqual(stats, { hits: 1, queries: 4, hitRate: 0.25 });
});

test('fetchCacheStats returns nulls for a not-ok response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const stats = await fetchCacheStats('http://localhost:8000', fakeFetch);
  assert.deepEqual(stats, { hits: null, queries: null, hitRate: null });
});

test('fetchCacheStats returns nulls when fetch throws', async () => {
  const fakeFetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const stats = await fetchCacheStats('http://localhost:8000', fakeFetch);
  assert.deepEqual(stats, { hits: null, queries: null, hitRate: null });
});

test('combineCacheStats sums hits and queries and derives hit rate', () => {
  const combined = combineCacheStats([
    { hits: 1, queries: 4, hitRate: 0.25 },
    { hits: 3, queries: 4, hitRate: 0.75 },
    { hits: null, queries: null, hitRate: null },
  ]);
  assert.deepEqual(combined, { hits: 4, queries: 8, hitRate: 0.5 });
});

test('combineCacheStats averages gauge-only entries', () => {
  const combined = combineCacheStats([
    { hits: null, queries: null, hitRate: 0.2 },
    { hits: null, queries: null, hitRate: 0.4 },
  ]);
  assert.deepEqual(combined, { hits: null, queries: null, hitRate: 0.3 });
});

test('combineCacheStats returns nulls when nothing is known', () => {
  assert.deepEqual(combineCacheStats([]), { hits: null, queries: null, hitRate: null });
  assert.deepEqual(
    combineCacheStats([{ hits: null, queries: null, hitRate: null }]),
    { hits: null, queries: null, hitRate: null },
  );
});

test('temp directory helper is usable without filesystem injection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-cache-'));
  try {
    assert.ok(fs.statSync(dir).isDirectory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
