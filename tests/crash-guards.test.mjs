// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstJobOrError, waitResultCost } from '../tools/go.mjs';
import { waitResultCost as goalWaitResultCost } from '../tools/goal.mjs';
import { finalCost } from '../tools/spend.mjs';
import { warnUntrackedContext } from '../tools/context-warn.mjs';

const reservation = { usd: 0.42, tokens: 1000 };

test('finalCost treats missing record as empty on flat lane', () => {
  for (const record of [undefined, null, {}]) {
    const result = finalCost({ lane: 'claude', record, reservation, rates: null });
    assert.equal(result.usd, 0);
    assert.equal(result.kind, 'actual');
  }
});

test('finalCost treats missing record as empty on metered lane', () => {
  for (const record of [undefined, null, {}]) {
    const result = finalCost({ lane: 'openrouter', record, reservation, rates: null });
    assert.equal(result.usd, reservation.usd);
    assert.equal(result.kind, 'reserved-as-cost');
    assert.equal(result.costSource, 'reservation');
  }
});

test('firstJobOrError surfaces state.error when jobs are empty', () => {
  const out = firstJobOrError({ jobs: [], error: 'context file not tracked', status: 'failed' });
  assert.equal(out.error, 'context file not tracked');
  assert.equal(out.record, undefined);
});

test('firstJobOrError returns first job record', () => {
  const record = { id: 'j1', costUsd: 1.25 };
  const out = firstJobOrError({ jobs: [record], status: 'complete' });
  assert.deepEqual(out, { record });
  assert.equal(out.error, undefined);
});

test('waitResultCost does not throw when waited is undefined', () => {
  assert.equal(waitResultCost(undefined), null);
  assert.equal(waitResultCost(null), null);
  assert.equal(goalWaitResultCost(undefined), null);
});

test('waitResultCost reads cost from first job when present', () => {
  assert.equal(waitResultCost({ jobs: [{ costUsd: 2.5 }] }), 2.5);
  assert.equal(waitResultCost({ costUsd: 1, jobs: [{ costUsd: 2.5 }] }), 2.5);
});

test('warnUntrackedContext lists only untracked paths', () => {
  const tracked = ['a.mjs', 'b.mjs'];
  const warnings = warnUntrackedContext(['a.mjs', 'secret.mjs'], tracked);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /secret\.mjs/);
  assert.match(warnings[0], /committed files only/i);
  assert.deepEqual(warnUntrackedContext(['a.mjs'], tracked), []);
});
