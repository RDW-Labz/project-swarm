// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCORECARD_METRIC_NAMES } from '../tools/bench-scorecard.mjs';
import { readScorecards, scorecardHistory } from '../tools/benchmark-scorecard.mjs';

const tempRoot = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scorecard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const metric = (name, value, extra = {}) => ({ name, value, status: 'measured', grade: 'green', trend: 'flat', previous: null, ...extra });
const card = (week, generatedAt, value, extra = {}) => ({
  week,
  generatedAt,
  projects: [{ project: 'demo', metrics: [metric('billed_usd', value, extra)] }],
  overall: { green: 1, amber: 0, red: 0, unknown: 0 },
  headline: `${week} headline`,
});

test('readScorecards skips malformed cards with reasons', async t => {
  const root = await tempRoot(t);
  const directory = path.join(root, 'evals', 'scorecard');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'good.json'), JSON.stringify(card('2026-W43', '2026-10-20T15:00:00Z', 1)));
  await fs.writeFile(path.join(directory, 'bad-json.json'), '{');
  await fs.writeFile(path.join(directory, 'bad-week.json'), JSON.stringify({ week: 'not-a-week', projects: [] }));
  await fs.writeFile(path.join(directory, 'bad-projects.json'), JSON.stringify({ week: '2026-W44', projects: {} }));

  const result = await readScorecards(root);
  assert.equal(result.files, 1);
  assert.equal(result.cards.length, 1);
  assert.equal(result.skipped.length, 3);
  assert.match(result.skipped.find(item => item.file === 'bad-json.json').reason, /invalid JSON/);
  assert.match(result.skipped.find(item => item.file === 'bad-week.json').reason, /week/);
  assert.match(result.skipped.find(item => item.file === 'bad-projects.json').reason, /projects/);
});

test('duplicate week keeps the card with the newest generatedAt', () => {
  const history = scorecardHistory([
    card('2026-W43', '2026-10-20T15:00:00Z', 1),
    card('2026-W43', '2026-10-20T16:00:00Z', 2, { trend: 'up', previous: 1 }),
  ]);
  assert.equal(history.files, 2);
  assert.equal(history.week, '2026-W43');
  assert.equal(history.projects[0].metrics.find(item => item.name === 'billed_usd').value, 2);
  assert.deepEqual(history.weeks, ['2026-W43']);
});

test('history keeps weekly points across the ISO year boundary', () => {
  const history = scorecardHistory([
    card('2026-W51', '2026-12-20T12:00:00Z', 3),
    card('2026-W52', '2026-12-27T12:00:00Z', 2, { trend: 'down', previous: 3 }),
    card('2027-W01', '2027-01-04T12:00:00Z', 1, { trend: 'down', previous: 2 }),
  ], { weeks: 3 });
  const billed = history.projects[0].metrics.find(item => item.name === 'billed_usd');
  assert.deepEqual(history.weeks, ['2026-W51', '2026-W52', '2027-W01']);
  assert.deepEqual(billed.weekly.map(point => point.week), ['2026-W51', '2026-W52', '2027-W01']);
  assert.deepEqual(billed.weekly.map(point => point.value), [3, 2, 1]);
  assert.equal(billed.verdict, 'better');
});

test('metric order follows SCORECARD_METRIC_NAMES and maps trends to verdicts', () => {
  const history = scorecardHistory([{
    ...card('2026-W43', '2026-10-20T15:00:00Z', 1),
    projects: [{ project: 'demo', metrics: [
      metric('billed_usd', 1, { trend: 'down' }),
      metric('list_usd', 1, { trend: 'flat' }),
      metric('first_try_pass_rate', 0.8, { trend: 'new' }),
    ] }],
  }]);
  const metrics = history.projects[0].metrics;
  assert.deepEqual(metrics.map(item => item.name), SCORECARD_METRIC_NAMES);
  const verdict = (name, trend, value = 1, previous = null) => scorecardHistory([{
    ...card('2026-W43', '2026-10-20T15:00:00Z', value, { trend, previous }),
    projects: [{ project: 'demo', metrics: [metric(name, value, { trend, previous })] }],
  }]).projects[0].metrics.find(item => item.name === name).verdict;
  assert.equal(verdict('billed_usd', 'up'), 'worse');
  assert.equal(verdict('billed_usd', 'down'), 'better');
  assert.equal(metrics.find(item => item.name === 'list_usd').verdict, 'flat');
  assert.equal(verdict('first_try_pass_rate', 'up', 0.9, 0.8), 'better');
  assert.equal(verdict('first_try_pass_rate', 'down', 0.7, 0.8), 'worse');
  assert.equal(metrics.find(item => item.name === 'first_try_pass_rate').verdict, 'unknown');
});

test('empty folder produces an empty history', async t => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'evals', 'scorecard'), { recursive: true });
  const result = scorecardHistory(await readScorecards(root));
  assert.equal(result.week, null);
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.weeks, []);
  assert.equal(result.files, 0);
});
