// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { boardPools, stubPools } from '../tools/pools-board.mjs';

const at = Date.parse('2026-10-20T12:00:00.000Z');

test('stub reports machine full, project shares, and borrowing', () => {
  const result = stubPools({
    now: at,
    workers: {
      total: 5, max: 6, free: 1,
      byProject: { alpha: { total: 3 }, beta: { total: 1 }, gamma: { total: 1 } },
    },
  });
  const machine = result.pools.find(pool => pool.id === 'machine');
  assert.deepEqual(machine, {
    id: 'machine', name: 'Machine', kind: 'machine', limit: 6, inUse: 5,
    unit: 'slots', capped: false, why: null, until: null,
  });
  const alpha = result.pools.find(pool => pool.id === 'project:alpha');
  assert.equal(alpha.limit, 2);
  assert.equal(alpha.why, 'over its share, borrowing idle slots');
});

test('stub reports machine not full and invalid limits', () => {
  assert.equal(stubPools({ workers: { total: 1, max: 4 } }).pools[0].capped, false);
  const noLimit = stubPools({ workers: { total: 1, max: null } }).pools[0];
  assert.equal(noLimit.limit, null);
  assert.equal(noLimit.why, null);
  const invalid = stubPools({ workers: { total: 1, max: null, invalid: true } }).pools[0];
  assert.equal(invalid.capped, false);
  assert.equal(invalid.why, 'limit invalid: fix machineConcurrency');
});

test('stub reports a lane cap and a rate-limit pause', () => {
  const result = stubPools({
    now: at,
    laneRows: [
      { lane: 'codex', label: 'Codex', todayUsd: 0, dailyCapUsd: null, limited: null },
      { lane: 'openai', label: 'OpenAI', todayUsd: 5, dailyCapUsd: 5, capResetsAt: '2026-10-21T00:00:00.000Z', limited: null },
      { lane: 'anthropic', label: 'Anthropic API', todayUsd: 0, dailyCapUsd: null, limited: { state: 'backoff', until: '2026-10-20T12:05:00.000Z' } },
      { lane: 'cursor', label: 'Cursor', todayUsd: 1, dailyCapUsd: null, limited: { state: 'backoff', until: '2026-10-20T11:00:00.000Z' } },
    ],
  });
  assert.equal(result.pools.some(pool => pool.id === 'lane:codex'), false, 'no cap and no active pause');
  const openai = result.pools.find(pool => pool.id === 'lane:openai');
  const anthropic = result.pools.find(pool => pool.id === 'lane:anthropic');
  assert.equal(openai.why, 'daily cap reached, resets 2026-10-21T00:00:00.000Z');
  assert.equal(anthropic.why, 'rate limited until 2026-10-20T12:05:00.000Z');
  assert.equal(result.pools.some(pool => pool.id === 'lane:cursor'), false, 'expired pause alone does not emit');
});

test('stub disambiguates duplicate lane labels and keeps lane ids unique', () => {
  const result = stubPools({
    now: at,
    laneRows: [
      { lane: 'rented', label: 'GPU', todayUsd: 1, dailyCapUsd: 10, capResetsAt: '2026-10-21T00:00:00.000Z', limited: null },
      { lane: 'ollama', label: 'GPU', todayUsd: 0, dailyCapUsd: 5, capResetsAt: '2026-10-21T00:00:00.000Z', limited: null },
      { lane: 'lambda', label: 'GPU', todayUsd: 0, dailyCapUsd: 3, capResetsAt: '2026-10-21T00:00:00.000Z', limited: null },
    ],
  });
  const lanePools = result.pools.filter(pool => pool.kind === 'lane');
  assert.equal(lanePools.length, 3);
  assert.deepEqual(lanePools.map(pool => pool.id).sort(), ['lane:lambda', 'lane:ollama', 'lane:rented']);
  assert.deepEqual(
    lanePools.map(pool => pool.name).sort(),
    ['GPU (lambda)', 'GPU (ollama)', 'GPU (rented)'],
  );
});

test('stub reports enabled hosts and skips disabled hosts', () => {
  const result = stubPools({ hosts: [
    { id: 'dev2', kind: 'ssh', capacity: 2, enabled: true },
    { id: 'off', kind: 'ssh', capacity: 4, enabled: false },
  ] });
  assert.deepEqual(result.pools.find(pool => pool.id === 'host:dev2'), {
    id: 'host:dev2', name: 'dev2', kind: 'host', limit: 2, inUse: 0,
    unit: 'jobs', capped: false, why: null, until: null,
  });
  assert.equal(result.pools.some(pool => pool.id === 'host:off'), false);
});

test('adapter uses an injected loader result', async () => {
  const result = await boardPools({
    now: at,
    loadPools: async ({ now }) => ({ at: now, pools: [{ id: 'x', name: 'Pool', kind: 'host', limit: 2, inUse: 1, unit: 'jobs', capped: false, why: null, until: null }] }),
  });
  assert.equal(result.source, 'pools.mjs');
  assert.equal(result.pools[0].id, 'x');
  assert.equal(result.at, at);
});

test('adapter falls back to the stub when loading throws or the module is missing', async () => {
  const stubInput = { workers: { total: 2, max: 2 }, laneRows: [], hosts: [] };
  const throwing = await boardPools({ now: at, loadPools: async () => { throw new Error('not ready'); }, stubInput });
  assert.equal(throwing.source, 'stub');
  assert.equal(throwing.pools[0].why, 'machine limit reached (2 of 2 slots)');

  const missing = await boardPools({ now: at, stubInput });
  assert.equal(missing.source, 'stub');
  assert.equal(missing.pools[0].inUse, 2);
});

test('adapter cleans bad pool entries without throwing', async () => {
  const long = 'x'.repeat(200);
  const result = await boardPools({
    now: at,
    loadPools: async () => ({ pools: [
      { id: long, name: long, kind: 'bogus', limit: Infinity, inUse: 'bad', unit: 'jobs', capped: 1, why: long, until: 'not a date' },
      null,
    ] }),
  });
  assert.equal(result.pools.length, 1);
  const [clean] = result.pools;
  assert.equal(clean.id.length, 120);
  assert.equal(clean.name.length, 120);
  assert.equal(clean.kind, 'other');
  assert.equal(clean.limit, null);
  assert.equal(clean.inUse, 0);
  assert.equal(clean.capped, true);
  assert.equal(clean.why.length, 120);
  assert.equal(clean.until, null);
});
