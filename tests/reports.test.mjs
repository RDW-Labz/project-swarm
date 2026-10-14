// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_KEYS, REPORT_STATUSES, REPORT_PROMPT_LINE, SUMMARY_MAX, ITEM_MAX, LIST_MAX, validateReport, legacyReport, rollupRun, renderRollupText } from '../tools/reports.mjs';

const report = overrides => ({ status: 'complete', summary: 'Done.', files: ['out.txt'], risks: [], followups: [], ...overrides });
const validate = value => validateReport(value, { outputs: ['out.txt'] });

test('report constants, copied frozen reports, exact keys and trimmed summaries', () => {
  assert.deepEqual(REPORT_KEYS, ['status', 'summary', 'files', 'risks', 'followups']);
  assert.deepEqual(REPORT_STATUSES, ['complete', 'blocked', 'failed']);
  assert.ok(Object.isFrozen(REPORT_KEYS) && Object.isFrozen(REPORT_STATUSES));
  assert.deepEqual([SUMMARY_MAX, ITEM_MAX, LIST_MAX], [500, 200, 10]);
  assert.equal(REPORT_PROMPT_LINE, 'Finish with exactly one JSON line and nothing after it: {"status":"complete|blocked|failed","summary":"at most 500 characters","files":["changed declared outputs"],"risks":["short risk"],"followups":["short follow-up"]}. Use exactly these five keys. This replaces any other final-line format above.');
  for (const status of REPORT_STATUSES) {
    const original = report({ status, summary: ' Done. ', risks: ['Risk'], followups: ['Next'] });
    const checked = validate(original);
    assert.deepEqual(checked.errors, []);
    assert.deepEqual(checked.report, { ...original, summary: 'Done.' });
    for (const value of [checked.report, checked.report.files, checked.report.risks, checked.report.followups]) assert.ok(Object.isFrozen(value));
    original.files.push('new');
    assert.deepEqual(checked.report.files, ['out.txt']);
  }
  assert.deepEqual(validateReport(report({ files: [] })).errors, []);
});

test('validation rejects non-plain objects, missing/extra keys in order and caps errors at five', () => {
  for (const value of [null, undefined, 1, 'text', [], new Date(), Object.create({})]) assert.deepEqual(validate(value), { report: null, errors: ['report is not an object'] });
  for (const key of REPORT_KEYS) {
    const value = report(); delete value[key];
    assert.equal(validate(value).errors[0], `missing key ${key}`);
  }
  assert.deepEqual(validate({ ...report(), extra: true }).errors, ['unexpected key extra']);
  assert.deepEqual(validate({}).errors, REPORT_KEYS.map(key => `missing key ${key}`));
  const value = { status: 'wrong', summary: '', files: null, risks: null, followups: null, extra: 1 };
  assert.deepEqual(validate(value).errors, ['unexpected key extra', 'status must be complete, blocked or failed', 'summary must be a non-blank string of at most 500 characters', 'files must be an array of declared outputs', 'risks must be at most 10 non-blank strings of at most 200 characters']);
});

test('every report field enforces type, length, output membership and duplicates', () => {
  for (const status of ['done', null, 1]) assert.deepEqual(validate(report({ status })).errors, ['status must be complete, blocked or failed']);
  for (const summary of ['', '  ', null, 1, 'x'.repeat(501)]) assert.deepEqual(validate(report({ summary })).errors, ['summary must be a non-blank string of at most 500 characters']);
  assert.deepEqual(validate(report({ summary: 'x'.repeat(500) })).errors, []);
  for (const files of [null, 'out.txt', [1]]) assert.deepEqual(validate(report({ files })).errors, ['files must be an array of declared outputs']);
  assert.deepEqual(validate(report({ files: ['other', 'out.txt', 'out.txt'] })).errors, ['file not in outputs: other', 'duplicate file: out.txt']);
  for (const key of ['risks', 'followups']) {
    for (const value of [null, 'text', [''], [' '], [1], ['x'.repeat(201)], Array(11).fill('x')]) assert.deepEqual(validate(report({ [key]: value })).errors, [`${key} must be at most 10 non-blank strings of at most 200 characters`]);
    assert.deepEqual(validate(report({ [key]: Array(10).fill('x'.repeat(200)) })).errors, []);
  }
});

test('legacy reports select summary, notes, error and status, map status and filter files', () => {
  for (const status of ['complete', 'blocked', 'failed', 'timeout', 'cancelled']) {
    const r = legacyReport({ status, error: 'error', result: { summary: ' summary ', notes: ['notes'], files_changed: ['out.txt', 'out.txt', 'other'] }, outputs: ['out.txt'] });
    assert.deepEqual(r, { status: ['complete', 'blocked'].includes(status) ? status : 'failed', summary: 'summary', files: ['out.txt'], risks: [], followups: [], legacy: true });
  }
  for (const notes of [['one', 'two'], 'one; two']) assert.equal(legacyReport({ status: 'failed', error: 'error', result: { summary: ' ', notes } }).summary, 'one; two');
  assert.equal(legacyReport({ status: 'failed', error: 'error' }).summary, 'error');
  assert.equal(legacyReport({ status: 'blocked' }).summary, 'blocked');
  const long = legacyReport({ status: 'complete', result: { summary: 'x'.repeat(501), filesChanged: ['out.txt'] }, outputs: ['out.txt'] });
  assert.equal(long.summary, 'x'.repeat(497) + '...');
  assert.deepEqual(long.files, ['out.txt']);
});

test('rollup aggregates statuses, assigned lanes, costs, tokens, files and report kinds', () => {
  const statuses = ['complete', 'failed', 'blocked', 'timeout', 'cancelled', 'skipped', 'queued', 'running'];
  const jobs = statuses.map((status, i) => ({ id: `j${i}`, status, agent: i % 2 ? 'cursor' : 'codex', ...(i < 2 ? { report: report({ legacy: i === 1, risks: [' risk ', 'tie'], followups: ['next'] }), costUsd: 0.014, usage: i === 0 ? { total_tokens: 9, input_tokens: 99 } : { input_tokens: 2, output_tokens: 3 } } : {}), ...(i === 0 ? { reportErrors: ['bad'] } : {}) }));
  const r = rollupRun({ id: 'demo', status: 'failed', createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:20Z', jobs }, { top: 3 });
  assert.equal(r.id, 'demo'); assert.equal(r.total, 8); assert.equal(r.status, 'failed');
  assert.deepEqual(r.counts, Object.fromEntries(statuses.map(key => [key, 1])));
  assert.deepEqual(r.lanes, { codex: 4, cursor: 4 });
  assert.deepEqual(r.spend, { costUsd: 0.03, costReportedJobs: 2, tokens: 14 });
  assert.deepEqual(r.files, { changed: 1, jobs: 2 });
  assert.deepEqual(r.reports, { short: 1, legacy: 1, invalid: 1, missing: 6 });
  assert.deepEqual(r.attention.map(job => job.id), ['j1', 'j3', 'j2']);
  assert.equal(r.attentionMore, 5);
  assert.deepEqual(r.risks, [{ text: 'risk', count: 2 }, { text: 'tie', count: 2 }]);
  assert.deepEqual(r.followups, [{ text: 'next', count: 2 }]);
  assert.equal(r.elapsedMs, 80000);
  const text = renderRollupText(r);
  for (const line of ['Run demo - failed - 8 jobs - elapsed 1m20s', 'lanes  codex 4 - cursor 4', 'spend  $0.03 (2 jobs reported cost) - tokens 14', 'files  1 changed across 2 jobs', 'reports  1 short - 1 legacy - 1 invalid - 6 missing', 'attention (3 of 8):', '  +5 more: swarm inspect demo', 'risks:', '  2x risk', 'followups:']) assert.ok(text.includes(line), line);
});

test('rollup handles empty runs, summary fallback, elapsed fallback and optional text blocks', () => {
  const empty = rollupRun({ id: 'empty', status: 'complete', jobs: [] });
  assert.equal(empty.elapsedMs, null);
  assert.equal(renderRollupText(empty).split('\n').length, 6);
  assert.doesNotMatch(renderRollupText(empty), /attention|risks:|followups:/);
  const r = rollupRun({ jobs: [{ id: 'a', status: 'failed', error: 'e'.repeat(200), startedAt: '2026-01-01T00:00:00Z' }, { id: 'b', status: 'queued' }], finishedAt: '2026-01-01T00:00:01Z' });
  assert.equal(r.elapsedMs, 1000);
  assert.equal(r.attention[0].summary.length, 160);
  assert.equal(r.attention[1].summary, 'queued');
});

test('300 long reports stay below JSON and text size budgets', () => {
  const jobs = Array.from({ length: 300 }, (_, i) => ({ id: `job-${i}`, agent: 'codex', status: 'failed', report: report({ summary: 's'.repeat(500), risks: [`${i} ` + 'r'.repeat(195)], followups: [`${i} ` + 'f'.repeat(195)] }) }));
  for (const top of [10, 50]) {
    const r = rollupRun({ id: 'large', status: 'failed', jobs }, { top });
    assert.ok(Buffer.byteLength(JSON.stringify(r)) < 4096);
    assert.ok(renderRollupText(r).split('\n').length < 40);
    assert.equal(r.attention.length + r.attentionMore, 300);
    assert.ok(r.risks.length <= 5 && r.followups.length <= 5);
  }
});
