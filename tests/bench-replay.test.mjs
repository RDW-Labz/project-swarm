// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateCase,
  scrubCase,
  runReplay,
  runLoadSeries,
} from '../tools/bench-replay.mjs';

const baseCase = {
  id: 'c1',
  title: 'Example',
  kind: 'test',
  prompt: 'run tests',
  files: ['src/a.mjs'],
  context: ['tools/x.mjs'],
  testCommand: ['node', '--test'],
  acceptance: ['tests pass'],
  scrubbedFrom: 'ticket-1',
  sizeBytes: 120,
};

describe('validateCase', () => {
  it('accepts a valid case', () => {
    assert.deepEqual(validateCase(baseCase), []);
  });

  it('rejects missing fields, bad argv, absolute paths, and too many files', () => {
    const errs = validateCase({
      ...baseCase,
      id: '',
      kind: 'other',
      files: [...Array(9)].map((_, i) => `f${i}.mjs`),
      context: ['/abs/path'],
      testCommand: 'npm test',
    });
    assert.ok(errs.some((e) => e.includes('kind')));
    assert.ok(errs.some((e) => e.includes('files: at most 8')));
    assert.ok(errs.some((e) => e.includes('absolute')));
    assert.ok(errs.some((e) => e.includes('testCommand: must be an argv array')));
  });

  it('rejects .. in paths', () => {
    const errs = validateCase({
      ...baseCase,
      files: ['../escape.mjs'],
    });
    assert.ok(errs.some((e) => e.includes('..')));
  });
});

describe('scrubCase', () => {
  it('removes email, phone, token, and absolute paths; dropped lists kinds only', () => {
    const fakeGh = ['gh', 'p_'].join('') + 'x'.repeat(36);
    const raw = {
      ...baseCase,
      prompt: `Contact user@example.com or 555-123-4567 token ${fakeGh} path /tmp/project/src/a.mjs`,
    };
    const { case: cleaned, dropped } = scrubCase(raw, { codeRoot: '/tmp/project' });
    assert.ok(!cleaned.prompt.includes('user@example.com'));
    assert.ok(!cleaned.prompt.includes('555-123-4567'));
    assert.ok(!cleaned.prompt.includes(fakeGh));
    assert.ok(!cleaned.prompt.includes('/tmp/project'));
    assert.ok(cleaned.prompt.includes('src/a.mjs') || cleaned.prompt.includes('a.mjs'));
    for (const d of dropped) {
      assert.equal(typeof d.field, 'string');
      assert.equal(typeof d.kind, 'string');
      assert.equal('value' in d, false);
    }
    assert.ok(dropped.some((d) => d.kind === 'email'));
    assert.ok(dropped.some((d) => d.kind === 'phone'));
  });

  it('truncates prompt to 4000 characters', () => {
    const raw = { ...baseCase, prompt: 'safe prompt chunk. '.repeat(400) };
    const { case: cleaned } = scrubCase(raw);
    assert.equal(cleaned.prompt.length, 4000);
  });
});

function makeTimedRunner(clock) {
  return async (caseObj) => {
    const ms = caseObj.durationMs ?? 10;
    const start = clock.t;
    await Promise.resolve();
    clock.t = start + ms;
    return {
      status: caseObj.fail ? 'fail' : 'pass',
      durationMs: ms,
      billedUsd: caseObj.billedUsd ?? 0,
      listUsd: caseObj.listUsd ?? 0,
      retries: caseObj.retries ?? 0,
      tokens: 0,
      flaky: !!caseObj.flaky,
    };
  };
}

describe('runReplay concurrency', () => {
  for (const parallel of [4, 8, 16]) {
    it(`never exceeds parallel=${parallel}`, async () => {
      let maxInflight = 0;
      let inflight = 0;
      const clock = { t: 0 };
      const runner = async (caseObj) => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        const out = await makeTimedRunner(clock)(caseObj);
        inflight -= 1;
        return out;
      };
      const cases = Array.from({ length: parallel * 2 }, (_, i) => ({
        id: `c${i}`,
        durationMs: 5,
      }));
      await runReplay({
        cases,
        parallel,
        runner,
        now: () => clock.t,
      });
      assert.ok(maxInflight <= parallel);
    });
  }
});

describe('runReplay errors and metrics', () => {
  it('continues when runner throws', async () => {
    const clock = { t: 0 };
    let n = 0;
    const runner = async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { status: 'pass', durationMs: 1, billedUsd: 0, listUsd: 0, retries: 0, tokens: 0 };
    };
    const out = await runReplay({
      cases: [{ id: 'a' }, { id: 'b' }],
      parallel: 2,
      runner,
      now: () => clock.t,
    });
    assert.equal(out.results.length, 2);
    assert.equal(out.results.find((r) => r.caseId === 'a').status, 'error');
    assert.equal(out.results.find((r) => r.caseId === 'b').status, 'pass');
  });

  it('computes idle_slot_pct from a known schedule', async () => {
    const clock = { t: 0 };
    const cases = [
      { id: 's1', durationMs: 90 },
      { id: 's2', durationMs: 90 },
      { id: 's3', durationMs: 90 },
      { id: 's4', durationMs: 90 },
      { id: 'last', durationMs: 10 },
    ];
    const out = await runReplay({
      cases,
      parallel: 4,
      runner: makeTimedRunner(clock),
      now: () => clock.t,
    });
    const span = out.finishedAt - out.startedAt;
    const expectedIdle = (4 - 3) * 90;
    const expectedPct = expectedIdle / (span * 4);
    assert.ok(Math.abs(out.metrics.idle_slot_pct - expectedPct) < 0.001);
  });
});

describe('runLoadSeries', () => {
  it('runs three parallel levels', async () => {
    const clock = { t: 0 };
    const series = await runLoadSeries({
      cases: [{ id: 'a', durationMs: 1 }],
      label: 'load',
      levels: [4, 8, 16],
      runner: makeTimedRunner(clock),
      now: () => clock.t,
    });
    assert.equal(series.runs.length, 3);
    assert.equal(series.table.length, 3);
    assert.deepEqual(series.runs.map((r) => r.parallel), [4, 8, 16]);
  });
});
