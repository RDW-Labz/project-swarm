// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareReplays,
  formatCompareTable,
  formatCompareMarkdown,
} from '../tools/bench-compare.mjs';

function snapshot(metrics) {
  return { label: 'x', parallel: 1, startedAt: 0, finishedAt: 1000, results: [], metrics };
}

describe('compareReplays', () => {
  it('passes when target improves and others stay within tolerance', () => {
    const before = snapshot({
      pass_rate: 0.8,
      first_try_rate: 0.7,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 200,
      billed_usd_per_case: 1,
      list_usd_per_case: 1.2,
      retries_per_case: 0.5,
      flaky_rate: 0.1,
      idle_slot_pct: 0.2,
    });
    const after = snapshot({
      pass_rate: 0.9,
      first_try_rate: 0.72,
      throughput_per_min: 11,
      median_ms: 95,
      p90_ms: 198,
      billed_usd_per_case: 1.05,
      list_usd_per_case: 1.25,
      retries_per_case: 0.52,
      flaky_rate: 0.09,
      idle_slot_pct: 0.19,
    });
    const result = compareReplays(before, after, { target: 'pass_rate', tolerance: 0.1 });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.targetImproved, true);
    assert.equal(result.regressions.length, 0);
  });

  it('fails on a 12% regression', () => {
    const before = snapshot({
      pass_rate: 0.5,
      first_try_rate: 0.5,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const after = snapshot({
      pass_rate: 0.9,
      first_try_rate: 0.5,
      throughput_per_min: 10,
      median_ms: 112,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const result = compareReplays(before, after, { target: 'pass_rate' });
    assert.equal(result.verdict, 'fail');
    assert.ok(result.regressions.includes('median_ms'));
  });

  it('allows a 9% regression within tolerance', () => {
    const before = snapshot({
      pass_rate: 0.5,
      first_try_rate: 0.5,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const after = snapshot({
      pass_rate: 0.9,
      first_try_rate: 0.5,
      throughput_per_min: 10,
      median_ms: 109,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const result = compareReplays(before, after, { target: 'pass_rate', tolerance: 0.1 });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.regressions.length, 0);
  });

  it('handles zero baseline with absolute threshold', () => {
    const before = snapshot({
      pass_rate: 0.5,
      first_try_rate: 0,
      throughput_per_min: 10,
      median_ms: 0,
      p90_ms: 0,
      billed_usd_per_case: 0,
      list_usd_per_case: 0,
      retries_per_case: 0,
      flaky_rate: 0,
      idle_slot_pct: 0,
    });
    const after = snapshot({
      pass_rate: 0.9,
      first_try_rate: 0.5,
      throughput_per_min: 10,
      median_ms: 0,
      p90_ms: 0,
      billed_usd_per_case: 0.02,
      list_usd_per_case: 0,
      retries_per_case: 0,
      flaky_rate: 0,
      idle_slot_pct: 0,
    });
    const result = compareReplays(before, after, { target: 'pass_rate' });
    assert.equal(result.verdict, 'fail');
    assert.ok(result.regressions.includes('billed_usd_per_case'));
  });

  it('marks missing metrics as not comparable', () => {
    const before = snapshot({ pass_rate: 0.5 });
    const after = snapshot({ pass_rate: 0.9 });
    const result = compareReplays(before, after, { target: 'pass_rate' });
    assert.ok(result.notComparable.includes('median_ms'));
    assert.ok(result.rows.find((r) => r.metric === 'median_ms').comparable === false);
  });
});

describe('formatCompareTable', () => {
  it('stays under 30 lines and includes verdict', () => {
    const before = snapshot({
      pass_rate: 0.8,
      first_try_rate: 0.8,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const after = snapshot({
      pass_rate: 0.9,
      first_try_rate: 0.8,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const result = compareReplays(before, after, { target: 'pass_rate' });
    const table = formatCompareTable(result);
    assert.ok(table.split('\n').length <= 30);
    assert.ok(table.includes('verdict: pass'));
  });
});

describe('formatCompareMarkdown', () => {
  it('renders markdown table for PR body', () => {
    const before = snapshot({
      pass_rate: 0.8,
      first_try_rate: 0.8,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const after = snapshot({
      pass_rate: 0.9,
      first_try_rate: 0.8,
      throughput_per_min: 10,
      median_ms: 100,
      p90_ms: 100,
      billed_usd_per_case: 1,
      list_usd_per_case: 1,
      retries_per_case: 1,
      flaky_rate: 0.1,
      idle_slot_pct: 0.1,
    });
    const result = compareReplays(before, after, { target: 'pass_rate' });
    const md = formatCompareMarkdown(result);
    assert.ok(md.includes('| metric |'));
    assert.ok(md.includes('**Verdict:** pass'));
  });
});
