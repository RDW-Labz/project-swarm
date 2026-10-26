// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLanesForRouting } from '../tools/self-manage/routing-score.mjs';

const COST_ORDER = Object.freeze(['cursor', 'codex', 'anthropic', 'openrouter', 'claude']);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function snapshotInputs(lanes, options) {
  return JSON.stringify({ lanes, options });
}

test('highest pass-rate lane wins and log line names winner with every score', () => {
  const passRates = {
    cursor: { passed: 8, failed: 2, total: 10, rate: 0.8 },
    codex: { passed: 5, failed: 5, total: 10, rate: 0.5 },
    anthropic: { passed: 2, failed: 8, total: 10, rate: 0.2 },
  };
  const result = scoreLanesForRouting(['codex', 'cursor', 'anthropic'], {
    passRates,
    costOrder: COST_ORDER,
    failures: {},
  });

  assert.equal(result.winner, 'cursor');
  assert.equal(result.decisionReason, 'score');
  assert.equal(result.candidates[0].lane, 'cursor');
  assert.equal(result.candidates[0].score, 0.8);
  assert.match(result.line, /^routing-score winner=cursor reason=score/);
  assert.match(result.line, /cursor=0\.800/);
  assert.match(result.line, /codex=0\.500/);
  assert.match(result.line, /anthropic=0\.200/);
  assert.deepEqual(result.scores, {
    cursor: 0.8,
    codex: 0.5,
    anthropic: 0.2,
  });
});

test('equal scores break on cost order deterministically across repeated calls', () => {
  const passRates = {
    cursor: { passed: 7, failed: 3, total: 10, rate: 0.7 },
    codex: { passed: 7, failed: 3, total: 10, rate: 0.7 },
  };
  const lanes = Object.freeze(['codex', 'cursor']);
  const options = deepFreeze({
    passRates: deepFreeze(passRates),
    costOrder: COST_ORDER,
    failures: deepFreeze({}),
  });

  const first = scoreLanesForRouting(lanes, options);
  const second = scoreLanesForRouting(lanes, options);
  const third = scoreLanesForRouting(lanes, options);

  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(first.winner, 'cursor', 'cursor is cheaper (earlier in cost order)');
  assert.equal(first.decisionReason, 'tie-break-cost');
  assert.equal(first.candidates[0].lane, 'cursor');
  assert.equal(first.candidates[1].lane, 'codex');
  assert.match(first.line, /winner=cursor reason=tie-break-cost/);
  assert.match(first.line, /cursor=0\.700/);
  assert.match(first.line, /codex=0\.700/);
});

test('scoreLanesForRouting does not mutate frozen inputs', () => {
  const passRates = deepFreeze({
    cursor: deepFreeze({ passed: 9, failed: 1, total: 10, rate: 0.9 }),
    anthropic: deepFreeze({ passed: 4, failed: 6, total: 10, rate: 0.4 }),
  });
  const failures = deepFreeze({ cursor: 0, anthropic: 2 });
  const lanes = deepFreeze(['anthropic', 'cursor']);
  const options = deepFreeze({
    passRates,
    costOrder: COST_ORDER,
    failures,
  });
  const before = snapshotInputs(lanes, options);

  scoreLanesForRouting(lanes, options);

  assert.equal(snapshotInputs(lanes, options), before);
  assert.ok(Object.isFrozen(lanes));
  assert.ok(Object.isFrozen(options));
  assert.ok(Object.isFrozen(passRates));
  assert.ok(Object.isFrozen(failures));
});
