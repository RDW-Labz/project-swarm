// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  billedMeteredTodayUsd,
  resolveBudget,
  reserveSpend,
  withSpendStore,
} from '../tools/spend.mjs';
import { centralDayKey } from '../tools/daily-limit.mjs';

const ms = iso => Date.parse(iso);

async function tempSpendDir() {
  return await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'daily-limit-admit-'));
}

async function seedBilled({ dir, lane, usd, at, now = () => at }) {
  const key = `seed/${lane}/${crypto.randomUUID()}`;
  await withSpendStore(store => {
    store.entries[key] = {
      day: new Date(at).toISOString().slice(0, 10),
      lane,
      runId: 'seed',
      root: '/fixture',
      jobId: key,
      usd,
      tokens: 0,
      kind: 'actual',
      pid: process.pid,
      host: os.hostname(),
      at: new Date(at).toISOString(),
      flagged: false,
    };
  }, { dir, now });
}

function reserveInput({ dir, lane, key, now, dailyLimit, usd = 0.5 }) {
  return {
    dir,
    key,
    lane,
    runId: 'r',
    root: '/fixture',
    jobId: key,
    usd,
    tokens: 10,
    budget: resolveBudget({
      cli: { maxUsd: 1000 },
      config: {
        spend: {
          lanes: {
            openrouter: { dailyUsd: 1000 },
            openai: { dailyUsd: 1000 },
            gemini: { dailyUsd: 1000 },
            cursor: { dailyUsd: 1000 },
          },
        },
      },
    }),
    runTotals: { usd: 0, tokens: 0 },
    now,
    dailyLimit,
  };
}

describe('reserveSpend daily limit admission', () => {
  it('stop mode refuses a paid lane over the limit and lets Cursor through', async () => {
    const dir = await tempSpendDir();
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await seedBilled({ dir, lane: 'openrouter', usd: 5, at: now(), now });
    const blocked = await reserveSpend(reserveInput({
      dir,
      lane: 'openrouter',
      key: 'paid/blocked',
      now,
      dailyLimit: { settings: { project: { usd: 5, mode: 'stop' } }, project: 'demo' },
    }));
    assert.equal(blocked.decision?.reason, 'daily-limit');
    assert.equal(blocked.decision?.action, 'stop');
    assert.match(blocked.decision?.message, /\$5\.00/);
    assert.match(blocked.decision?.message, /billed \$5\.00 today/);
    assert.match(blocked.decision?.message, /resets /);

    const cursor = await reserveSpend(reserveInput({
      dir,
      lane: 'cursor',
      key: 'free/ok',
      now,
      usd: 0,
      dailyLimit: { settings: { project: { usd: 5, mode: 'stop' } }, project: 'demo' },
    }));
    assert.equal(cursor.decision, null);
  });

  it('notify mode continues and reports 1x, 2x and 3x exactly once each', async () => {
    const dir = await tempSpendDir();
    const now = () => ms('2024-06-15T15:00:00.000Z');
    const dailyLimit = { settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 100 } }, project: 'demo' };

    await seedBilled({ dir, lane: 'openrouter', usd: 5, at: now(), now });
    const first = await reserveSpend(reserveInput({ dir, lane: 'openrouter', key: 'n/1', now, dailyLimit }));
    assert.equal(first.decision, null);
    assert.deepEqual(first.dailyLimit?.notices?.map(n => n.level), [1]);

    const again = await reserveSpend(reserveInput({ dir, lane: 'openrouter', key: 'n/2', now, dailyLimit }));
    assert.equal(again.decision, null);
    assert.deepEqual(again.dailyLimit?.notices ?? [], []);

    await seedBilled({ dir, lane: 'openrouter', usd: 6, at: now(), now });
    const second = await reserveSpend(reserveInput({ dir, lane: 'openrouter', key: 'n/3', now, dailyLimit }));
    assert.deepEqual(second.dailyLimit?.notices?.map(n => n.level), [2]);

    await seedBilled({ dir, lane: 'openrouter', usd: 5, at: now(), now });
    const third = await reserveSpend(reserveInput({ dir, lane: 'openrouter', key: 'n/4', now, dailyLimit }));
    assert.deepEqual(third.dailyLimit?.notices?.map(n => n.level), [3]);

    const fourth = await reserveSpend(reserveInput({ dir, lane: 'openrouter', key: 'n/5', now, dailyLimit }));
    assert.deepEqual(fourth.dailyLimit?.notices ?? [], []);
  });

  it('hard ceiling refuses in notify mode', async () => {
    const dir = await tempSpendDir();
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await seedBilled({ dir, lane: 'gemini', usd: 30, at: now(), now });
    const result = await reserveSpend(reserveInput({
      dir,
      lane: 'gemini',
      key: 'ceiling',
      now,
      dailyLimit: { settings: { project: { usd: 10, mode: 'notify' } }, project: 'demo' },
    }));
    assert.equal(result.decision?.reason, 'daily-limit');
    assert.equal(result.decision?.action, 'ceiling');
    assert.match(result.decision?.message, /hard ceiling \$30\.00/);
  });

  it('project setting overrides machine default', async () => {
    const dir = await tempSpendDir();
    const now = () => ms('2024-06-15T15:00:00.000Z');
    await seedBilled({ dir, lane: 'openai', usd: 6, at: now(), now });
    const settings = { machine: { usd: 5, mode: 'stop' }, project: { usd: 10, mode: 'notify', ceilingUsd: 100 } };
    const allowed = await reserveSpend(reserveInput({
      dir,
      lane: 'openai',
      key: 'override',
      now,
      dailyLimit: { settings, project: 'demo' },
    }));
    assert.equal(allowed.decision, null);
  });

  it('midnight Central rollover resets the billed day', async () => {
    const dir = await tempSpendDir();
    const late = ms('2024-06-15T04:59:00.000Z'); // Jun 14 Central
    const early = ms('2024-06-15T05:01:00.000Z'); // Jun 15 Central
    await seedBilled({ dir, lane: 'openrouter', usd: 6, at: late, now: () => late });
    await withSpendStore(store => {
      assert.equal(billedMeteredTodayUsd(store, { now: () => late }), 6);
      assert.equal(billedMeteredTodayUsd(store, { now: () => early }), 0);
      assert.equal(centralDayKey(() => late), '2024-06-14');
      assert.equal(centralDayKey(() => early), '2024-06-15');
    }, { dir, now: () => early });

    const admitted = await reserveSpend(reserveInput({
      dir,
      lane: 'openrouter',
      key: 'after-midnight',
      now: () => early,
      dailyLimit: { settings: { project: { usd: 5, mode: 'stop' } }, project: 'demo' },
    }));
    assert.equal(admitted.decision, null);
  });
});
