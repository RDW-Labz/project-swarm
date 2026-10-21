// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS,
  gradeMetric,
  metricTrend,
  isoWeekString,
  buildScorecard,
  formatScorecard,
  scorecardForBoard,
  mergeThresholds,
} from '../tools/bench-scorecard.mjs';

const HOUR_MS = 60 * 60 * 1000;

test('gradeMetric at threshold edges for higher-is-better', () => {
  assert.equal(gradeMetric('first_try_pass_rate', 0.8, 'measured'), 'green');
  assert.equal(gradeMetric('first_try_pass_rate', 0.799, 'measured'), 'amber');
  assert.equal(gradeMetric('first_try_pass_rate', 0.6, 'measured'), 'amber');
  assert.equal(gradeMetric('first_try_pass_rate', 0.59, 'measured'), 'red');
});

test('gradeMetric at threshold edges for lower-is-better', () => {
  assert.equal(gradeMetric('ready_to_merged_ms', 4 * HOUR_MS, 'measured'), 'green');
  assert.equal(gradeMetric('ready_to_merged_ms', 4 * HOUR_MS + 1, 'measured'), 'amber');
  assert.equal(gradeMetric('ready_to_merged_ms', 12 * HOUR_MS, 'measured'), 'amber');
  assert.equal(gradeMetric('ready_to_merged_ms', 12 * HOUR_MS + 1, 'measured'), 'red');
  assert.equal(gradeMetric('flaky_failures', 0, 'measured'), 'green');
  assert.equal(gradeMetric('flaky_failures', 1, 'measured'), 'amber');
  assert.equal(gradeMetric('flaky_failures', 2, 'measured'), 'amber');
  assert.equal(gradeMetric('flaky_failures', 3, 'measured'), 'red');
  assert.equal(gradeMetric('billed_usd', 0.5, 'measured'), 'green');
  assert.equal(gradeMetric('orchestrator_tokens_per_merged_ticket', 200_000, 'measured'), 'green');
  assert.equal(gradeMetric('orchestrator_tokens_per_merged_ticket', 200_001, 'measured'), 'amber');
});

test('missing metric is unknown not green', () => {
  assert.equal(gradeMetric('first_try_pass_rate', null, 'missing'), 'unknown');
  assert.equal(gradeMetric('first_try_pass_rate', 0.95, 'missing'), 'unknown');
  const card = buildScorecard({
    baselines: [{ project: 'demo', metrics: { first_try_pass_rate: { value: null, status: 'missing' } } }],
  });
  const m = card.projects[0].metrics.find(x => x.name === 'first_try_pass_rate');
  assert.equal(m.grade, 'unknown');
});

test('metricTrend uses five percent dead band', () => {
  assert.equal(metricTrend(100, undefined), 'new');
  assert.equal(metricTrend(100, 100), 'flat');
  assert.equal(metricTrend(104, 100), 'flat');
  assert.equal(metricTrend(106, 100), 'up');
  assert.equal(metricTrend(95, 100), 'flat');
  assert.equal(metricTrend(94, 100), 'down');
});

test('iso week string for a known date', () => {
  const week = isoWeekString(Date.parse('2026-10-20T12:00:00Z'));
  assert.match(week, /^2026-W\d{2}$/);
});

test('buildScorecard headline mentions grade counts and improvement', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const previous = buildScorecard({
    baselines: [{
      project: 'demo',
      metrics: { first_try_pass_rate: { value: 0.62, status: 'measured' } },
    }],
    now,
  });
  const card = buildScorecard({
    baselines: [{
      project: 'demo',
      metrics: { first_try_pass_rate: { value: 0.71, status: 'measured' } },
    }],
    previous,
    now,
  });
  assert.match(card.headline, /green/);
  assert.match(card.headline, /first-try pass rate improved from 62 to 71 percent/);
  assert.equal(card.week, isoWeekString(now));
});

test('scorecardForBoard has grades only in metric map', () => {
  const card = buildScorecard({
    baselines: [{
      project: 'demo',
      metrics: {
        first_try_pass_rate: { value: 0.9, status: 'measured' },
        billed_usd: { value: 0.1, status: 'measured' },
      },
    }],
  });
  const board = scorecardForBoard(card);
  assert.equal(board.projects[0].project, 'demo');
  assert.equal(board.projects[0].metrics.first_try_pass_rate, 'green');
  for (const grade of Object.values(board.projects[0].metrics)) {
    assert.ok(['green', 'amber', 'red', 'unknown'].includes(grade));
  }
  assert.equal(typeof board.headline, 'string');
});

test('formatScorecard stays under forty lines', () => {
  const card = buildScorecard({
    baselines: [{ project: 'alpha', metrics: { billed_usd: { value: 0.2, status: 'measured' } } }],
  });
  const text = formatScorecard(card);
  assert.ok(text.split('\n').length <= 40);
  assert.match(text, /Weekly scorecard/);
});

test('mergeThresholds overrides defaults', () => {
  const t = mergeThresholds({ first_try_pass_rate: { green: 0.9, amber: 0.7 } });
  assert.equal(gradeMetric('first_try_pass_rate', 0.85, 'measured', t), 'amber');
  assert.equal(THRESHOLDS.first_try_pass_rate.green, 0.8);
});
