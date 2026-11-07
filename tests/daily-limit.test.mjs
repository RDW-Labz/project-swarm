// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DAILY_LIMIT_USD,
  resolveDailyLimit,
  validateDailyLimit,
  centralDayKey,
  centralMidnightAfter,
  isPaidLane,
  evaluateDailyLimit,
  dailyLimitNotice,
} from '../tools/daily-limit.mjs';

describe('validateDailyLimit', () => {
  it('rejects bad usd, mode, and ceiling', () => {
    assert.deepEqual(validateDailyLimit({ usd: 0 }), ['usd must be a positive finite number']);
    assert.deepEqual(validateDailyLimit({ mode: 'halt' }), ['mode must be stop or notify']);
    assert.deepEqual(validateDailyLimit({ usd: 10, ceilingUsd: 5 }), ['ceilingUsd must be at least usd']);
  });
});

describe('resolveDailyLimit', () => {
  it('defaults then machine then project', () => {
    const d = resolveDailyLimit({});
    assert.equal(d.dailyLimitUsd, DEFAULT_DAILY_LIMIT_USD);
    assert.equal(d.dailyLimitMode, 'stop');
    assert.equal(d.hardCeilingUsd, 7.5);
    assert.equal(d.source, 'default');

    const m = resolveDailyLimit({ machine: { usd: 8, mode: 'notify' } });
    assert.equal(m.dailyLimitUsd, 8);
    assert.equal(m.dailyLimitMode, 'notify');
    assert.equal(m.hardCeilingUsd, 24);
    assert.equal(m.source, 'machine');

    const p = resolveDailyLimit({ machine: { usd: 8 }, project: { usd: 12, ceilingUsd: 40 } });
    assert.equal(p.dailyLimitUsd, 12);
    assert.equal(p.hardCeilingUsd, 40);
    assert.equal(p.source, 'project');
  });

  it('explicit ceiling wins over triple limit', () => {
    const r = resolveDailyLimit({ project: { usd: 10, ceilingUsd: 30 } });
    assert.equal(r.hardCeilingUsd, 30);
  });
});

describe('isPaidLane', () => {
  it('treats subscription lanes as free', () => {
    assert.equal(isPaidLane('openrouter'), true);
    assert.equal(isPaidLane('codex'), false);
    assert.equal(isPaidLane('claude'), false);
    assert.equal(isPaidLane('cursor'), false);
    assert.equal(isPaidLane('hermes'), false);
    assert.equal(isPaidLane('qwen'), false);
  });
});

describe('central time', () => {
  const ms = (iso) => Date.parse(iso);

  it('centralDayKey at 23:59 and 00:01 Central', () => {
    const late = ms('2024-06-15T04:59:00.000Z'); // Jun 14 23:59 CDT
    const early = ms('2024-06-15T05:01:00.000Z'); // Jun 15 00:01 CDT
    assert.equal(centralDayKey(() => late), '2024-06-14');
    assert.equal(centralDayKey(() => early), '2024-06-15');
  });

  it('centralMidnightAfter across spring DST', () => {
    const before = ms('2024-03-10T05:30:00.000Z'); // Mar 9 23:30 CST
    const after = centralMidnightAfter(() => before);
    assert.equal(centralDayKey(() => after), '2024-03-10');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(after));
    const hour = parts.find(p => p.type === 'hour')?.value;
    assert.equal(hour, '00');
  });

  it('centralMidnightAfter across fall DST', () => {
    const before = ms('2024-11-03T05:30:00.000Z'); // Nov 3 00:30 CDT
    const after = centralMidnightAfter(() => before);
    assert.equal(centralDayKey(() => after), '2024-11-04');
  });
});

describe('evaluateDailyLimit', () => {
  const settings = { machine: null, project: null };

  it('free lanes always allow', () => {
    const r = evaluateDailyLimit({ settings, billedTodayUsd: 999, lane: 'codex', notifiedLevels: [] });
    assert.equal(r.allow, true);
    assert.equal(r.action, 'free');
  });

  it('stop mode at exact limit', () => {
    const r = evaluateDailyLimit({ settings, billedTodayUsd: 5, lane: 'openrouter', notifiedLevels: [] });
    assert.equal(r.allow, false);
    assert.equal(r.action, 'stop');
  });

  it('stop mode enforces daily stop and hard ceiling', () => {
    const s = { project: { usd: 10, mode: 'stop', ceilingUsd: 25 } };
    const atLimit = evaluateDailyLimit({ settings: s, billedTodayUsd: 10, lane: 'openai', notifiedLevels: [] });
    assert.equal(atLimit.allow, false);
    assert.equal(atLimit.action, 'stop');
    const atCeiling = evaluateDailyLimit({ settings: s, billedTodayUsd: 25, lane: 'openai', notifiedLevels: [] });
    assert.equal(atCeiling.allow, false);
    assert.equal(atCeiling.action, 'ceiling');
  });

  it('notify mode continues until ceiling', () => {
    const s = { project: { usd: 10, mode: 'notify', ceilingUsd: 30 } };
    const mid = evaluateDailyLimit({ settings: s, billedTodayUsd: 15, lane: 'gemini', notifiedLevels: [] });
    assert.equal(mid.allow, true);
    assert.equal(mid.action, 'notify');
    const cap = evaluateDailyLimit({ settings: s, billedTodayUsd: 30, lane: 'gemini', notifiedLevels: [1] });
    assert.equal(cap.allow, false);
    assert.equal(cap.action, 'ceiling');
  });

  it('default ceiling is 3x in notify mode', () => {
    const s = { project: { usd: 10, mode: 'notify' } };
    const cap = evaluateDailyLimit({ settings: s, billedTodayUsd: 30, lane: 'lambda', notifiedLevels: [] });
    assert.equal(cap.allow, false);
    assert.equal(cap.action, 'ceiling');
  });

  it('notifies levels 1 2 3 once each', () => {
    const s = { project: { usd: 5, mode: 'notify', ceilingUsd: 100 } };
    const first = evaluateDailyLimit({ settings: s, billedTodayUsd: 5, lane: 'openrouter', notifiedLevels: [] });
    assert.deepEqual(first.notify, [1]);
    const again = evaluateDailyLimit({ settings: s, billedTodayUsd: 5, lane: 'openrouter', notifiedLevels: [1] });
    assert.deepEqual(again.notify, []);
    const second = evaluateDailyLimit({ settings: s, billedTodayUsd: 11, lane: 'openrouter', notifiedLevels: [1] });
    assert.deepEqual(second.notify, [2]);
    const third = evaluateDailyLimit({ settings: s, billedTodayUsd: 16, lane: 'openrouter', notifiedLevels: [1, 2] });
    assert.deepEqual(third.notify, [3]);
  });

  it('ceiling notify fires once', () => {
    const s = { project: { usd: 5, mode: 'notify', ceilingUsd: 15 } };
    const hit = evaluateDailyLimit({ settings: s, billedTodayUsd: 15, lane: 'anthropic', notifiedLevels: [1, 2, 3] });
    assert.ok(hit.notify.includes('ceiling'));
    const again = evaluateDailyLimit({ settings: s, billedTodayUsd: 15, lane: 'anthropic', notifiedLevels: [1, 2, 3, 'ceiling'] });
    assert.deepEqual(again.notify, []);
  });

  it('free lane ignores ceiling and limit', () => {
    const s = { project: { usd: 5, mode: 'stop' } };
    const r = evaluateDailyLimit({ settings: s, billedTodayUsd: 100, lane: 'qwen', notifiedLevels: [] });
    assert.equal(r.allow, true);
    assert.equal(r.action, 'free');
  });
});

describe('dailyLimitNotice', () => {
  it('returns a short banner record', () => {
    const n = dailyLimitNotice({
      project: 'demo',
      level: 2,
      billedTodayUsd: 11,
      settings: { project: { usd: 5, mode: 'notify', ceilingUsd: 20 } },
      now: () => 0,
    });
    assert.equal(n.kind, 'daily-limit');
    assert.equal(n.project, 'demo');
    assert.ok(n.text.length < 200);
  });
});
