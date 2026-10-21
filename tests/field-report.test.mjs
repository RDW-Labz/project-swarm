// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFieldReport, formatFieldReport } from '../tools/field-report.mjs';

const now = Date.parse('2026-01-15T12:00:00.000Z');

function exportBase(overrides = {}) {
  return {
    version: 1,
    machine: 'm1',
    project: 'alpha',
    generatedAt: '2026-01-10T00:00:00.000Z',
    tickets: [],
    jobs: [],
    waves: [],
    guard: { blocks: [], handbuildRequests: [] },
    ...overrides,
  };
}

describe('field report', () => {
  test('empty input yields empty sections', () => {
    const report = buildFieldReport([], { now });
    assert.deepEqual(report.projects, []);
    assert.deepEqual(report.topFailureCauses, []);
    assert.deepEqual(report.lanePassRate, []);
    assert.deepEqual(report.costPerDoneTicket, []);
    assert.deepEqual(report.underFilledWaves, []);
    assert.deepEqual(report.guardFalsePositives, []);
    assert.deepEqual(report.routingHints, []);
    assert.ok(formatFieldReport(report).split('\n').length < 60);
  });

  test('merges same project across machines and de-duplicates jobs', () => {
    const sharedJob = { runId: 'r1', jobId: 'j1', jobType: 'build', lane: 'cursor', model: 'm', status: 'complete', costUsd: 1, durationMs: 1, retries: 0, failureCause: null };
    const report = buildFieldReport([
      exportBase({ machine: 'a', jobs: [sharedJob, { runId: 'r1', jobId: 'j2', jobType: 'build', lane: 'cursor', model: 'm', status: 'failed', costUsd: 2, durationMs: 1, retries: 0, failureCause: 'timeout' }] }),
      exportBase({ machine: 'b', generatedAt: '2026-01-11T00:00:00.000Z', jobs: [sharedJob] }),
    ], { now });
    assert.equal(report.projects.length, 1);
    assert.deepEqual(report.projects[0].machines, ['a', 'b']);
    assert.equal(report.projects[0].jobs, 2);
    assert.equal(report.projects[0].generatedAt, '2026-01-11T00:00:00.000Z');
  });

  test('top failure causes with share and projects', () => {
    const report = buildFieldReport([
      exportBase({
        jobs: [
          { runId: 'r1', jobId: 'j1', jobType: 'build', lane: 'a', model: 'x', status: 'failed', costUsd: 0, durationMs: 1, retries: 0, failureCause: 'timeout' },
          { runId: 'r1', jobId: 'j2', jobType: 'build', lane: 'a', model: 'x', status: 'failed', costUsd: 0, durationMs: 1, retries: 0, failureCause: 'timeout' },
          { runId: 'r1', jobId: 'j3', jobType: 'build', lane: 'a', model: 'x', status: 'failed', costUsd: 0, durationMs: 1, retries: 0, failureCause: 'check-failure' },
        ],
      }),
    ], { now });
    assert.deepEqual(report.topFailureCauses[0], { cause: 'timeout', count: 2, share: 2 / 3, projects: ['alpha'] });
    assert.equal(report.topFailureCauses[1].cause, 'check-failure');
  });

  test('lane pass rate groups by job type, lane, and model', () => {
    const report = buildFieldReport([
      exportBase({
        jobs: [
          { runId: 'r1', jobId: 'j1', jobType: 'build', lane: 'cursor', model: 'cheap', status: 'complete', costUsd: 1, durationMs: 1, retries: 0, failureCause: null },
          { runId: 'r1', jobId: 'j2', jobType: 'build', lane: 'cursor', model: 'cheap', status: 'failed', costUsd: 1, durationMs: 1, retries: 0, failureCause: 'other' },
        ],
      }),
    ], { now });
    assert.deepEqual(report.lanePassRate, [{ jobType: 'build', lane: 'cursor', model: 'cheap', jobs: 2, passed: 1, rate: 0.5 }]);
  });

  test('cost per done ticket by project and lane', () => {
    const report = buildFieldReport([
      exportBase({
        tickets: [
          { id: 't1', wave: 1, lane: 'cursor', model: 'm', status: 'done', retries: 0, failureCause: null, durationMs: 1 },
          { id: 't2', wave: 1, lane: 'cursor', model: 'm', status: 'done', retries: 0, failureCause: null, durationMs: 1 },
        ],
        jobs: [
          { runId: 'r1', jobId: 'j1', jobType: 'build', lane: 'cursor', model: 'm', status: 'complete', costUsd: 4, durationMs: 1, retries: 0, failureCause: null },
        ],
      }),
    ], { now });
    assert.deepEqual(report.costPerDoneTicket, [{ project: 'alpha', lane: 'cursor', usdPerDone: 2, doneTickets: 2 }]);
  });

  test('under-filled waves when ready at start is below slots', () => {
    const report = buildFieldReport([
      exportBase({ waves: [{ id: 'w1', tickets: 1, readyAtStart: 1, slots: 3 }] }),
    ], { now });
    assert.deepEqual(report.underFilledWaves, [{ project: 'alpha', wave: 'w1', ready: 1, slots: 3 }]);
  });

  test('guard false positives grouped by rule', () => {
    const report = buildFieldReport([
      exportBase({
        guard: {
          blocks: [
            { at: 't1', kind: 'k', rule: 'no-shell', falsePositive: true },
            { at: 't2', kind: 'k', rule: 'no-shell', falsePositive: true },
            { at: 't3', kind: 'k', rule: 'other', falsePositive: false },
          ],
          handbuildRequests: [],
        },
      }),
    ], { now });
    assert.deepEqual(report.guardFalsePositives, [{ rule: 'no-shell', count: 2, projects: ['alpha'] }]);
  });

  test('routing hint ignores cheap lane with four jobs and picks lane with five at 0.8', () => {
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      jobs.push({ runId: 'r1', jobId: `cheap-${i}`, jobType: 'build', lane: 'cheap-lane', model: 'm', status: 'complete', costUsd: 0.1, durationMs: 1, retries: 0, failureCause: null });
    }
    for (let i = 0; i < 4; i++) {
      jobs.push({ runId: 'r1', jobId: `mid-${i}`, jobType: 'build', lane: 'mid-lane', model: 'm', status: 'complete', costUsd: 1, durationMs: 1, retries: 0, failureCause: null });
    }
    jobs.push({ runId: 'r1', jobId: 'mid-fail', jobType: 'build', lane: 'mid-lane', model: 'm', status: 'failed', costUsd: 1, durationMs: 1, retries: 0, failureCause: 'timeout' });
    const report = buildFieldReport([exportBase({ jobs })], { now });
    assert.deepEqual(report.routingHints, [{ jobType: 'build', cheapestLaneThatPasses: 'mid-lane', rate: 0.8, minSample: 5 }]);
  });

  test('routing hint uses zero average cost for flat-rate (zero cost) lanes', () => {
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push({ runId: 'r1', jobId: `flat-${i}`, jobType: 'scout', lane: 'flat', model: 'm', status: 'complete', costUsd: 0, durationMs: 1, retries: 0, failureCause: null });
    }
    for (let i = 0; i < 5; i++) {
      jobs.push({ runId: 'r1', jobId: `paid-${i}`, jobType: 'scout', lane: 'paid', model: 'm', status: 'complete', costUsd: 0.5, durationMs: 1, retries: 0, failureCause: null });
    }
    const report = buildFieldReport([exportBase({ jobs })], { now });
    assert.equal(report.routingHints[0].cheapestLaneThatPasses, 'flat');
  });

  test('formatFieldReport stays under 60 lines for a large fixture', () => {
    const jobs = [];
    const tickets = [];
    const waves = [];
    for (let i = 0; i < 40; i++) {
      jobs.push({
        runId: 'r-big',
        jobId: `j-${i}`,
        jobType: i % 2 ? 'build' : 'scout',
        lane: `lane-${i % 12}`,
        model: `model-${i % 5}`,
        status: i % 5 === 0 ? 'failed' : 'complete',
        costUsd: i % 3 === 0 ? 0 : 0.25 + i * 0.01,
        durationMs: 100,
        retries: 0,
        failureCause: i % 5 === 0 ? 'timeout' : null,
      });
    }
    for (let i = 0; i < 30; i++) {
      tickets.push({ id: `t-${i}`, wave: i % 4, lane: `lane-${i % 6}`, model: 'm', status: i % 2 ? 'done' : 'running', retries: 0, failureCause: null, durationMs: 1 });
    }
    for (let i = 0; i < 20; i++) {
      waves.push({ id: `w-${i}`, tickets: 1, readyAtStart: i % 3, slots: 4 });
    }
    const exports = [];
    for (let p = 0; p < 6; p++) {
      exports.push(exportBase({
        project: `proj-${p}`,
        machine: `m-${p}`,
        jobs: jobs.map(j => ({ ...j, jobId: `${j.jobId}-p${p}` })),
        tickets,
        waves,
        guard: {
          blocks: [{ at: 't', kind: 'k', rule: `rule-${p % 3}`, falsePositive: true }],
          handbuildRequests: [],
        },
      }));
    }
    const report = buildFieldReport(exports, { now });
    const text = formatFieldReport(report);
    const lineCount = text.split('\n').length;
    assert.ok(lineCount < 60, `expected < 60 lines, got ${lineCount}`);
  });

  test('missing optional fields are tolerated', () => {
    const report = buildFieldReport([{ project: 'bare' }], { now });
    assert.deepEqual(report.projects, [{ project: 'bare', machines: [], generatedAt: null, tickets: 0, jobs: 0, doneTickets: 0 }]);
  });
});
