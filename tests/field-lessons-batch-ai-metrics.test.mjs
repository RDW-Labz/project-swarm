// SPDX-License-Identifier: Apache-2.0
// Swarm batch AI: field lessons 365, 366 and 369.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  idleGaps,
  idleSeatEvents,
  summarizeSessionMetrics,
} from '../tools/session-metrics.mjs';
import { renderMonitorView } from '../tools/monitor-view.mjs';
import { assertIsolatedHome, isolatedHome } from './_isolate-config.mjs';

test('365: reworkShare is primary and an empty integrate check list is n/a, not checksPassed health', () => {
  const result = summarizeSessionMetrics({
    jobs: [
      {
        root: '/fixture', runId: 'run-1', startedAt: '2026-10-01T09:00:00Z', finishedAt: '2026-10-01T10:00:00Z',
        outputs: ['report.md'], skills: [{ name: 'writer', attached: 'named' }],
      },
      {
        root: '/fixture', runId: 'run-2', startedAt: '2026-10-01T11:00:00Z', finishedAt: '2026-10-01T12:00:00Z',
        outputs: ['report.md'], skills: [],
      },
    ],
    integrates: [{ checks: [], checksPassed: true }],
  });

  assert.equal(result.reworkShare.writer.withSkill.reworkShare, 1);
  assert.equal(result.red_rate, 'n/a: no integrate checks');
  assert.equal(result.checksPassed, undefined, 'checksPassed must not be promoted into health');
});

test('366: every test home is temporary and the guard rejects the real home', () => {
  assert.equal(os.homedir(), isolatedHome);
  assert.notEqual(pathForTestHome(), process.env.SWARM_REAL_HOME);
  assert.doesNotThrow(() => assertIsolatedHome(isolatedHome));
  assert.throws(() => assertIsolatedHome(process.env.SWARM_REAL_HOME), /real home/);
});

test('369: idle seats expose runnable tasks, hand-step attribution, and monitor output', () => {
  const records = [
    { startedAt: '2026-10-01T09:00:00Z', finishedAt: '2026-10-01T09:10:00Z' },
    { startedAt: '2026-10-01T09:30:00Z', finishedAt: '2026-10-01T09:40:00Z' },
  ];
  const gaps = idleGaps(records, {
    handSteps: [{ at: '2026-10-01T09:20:00Z', step: 'merge release docs' }],
  });
  assert.deepEqual(gaps[0].handSteps, ['merge release docs']);

  const events = idleSeatEvents({
    now: '2026-10-01T09:26:00Z',
    jobs: [{ id: 'done', status: 'complete' }],
    tasks: [
      { id: 'T-ready', status: 'queued', blocked: false },
      { id: 'T-blocked', status: 'queued', blocked: true },
      { id: 'T-done', status: 'complete', blocked: false },
    ],
    lastWorkerFinishedAt: '2026-10-01T09:20:00Z',
  });
  assert.deepEqual(events[0].runnableTasks, ['T-ready']);

  const rendered = renderMonitorView({
    id: 'run-1', status: 'running', counts: { queued: 1, running: 0 }, jobs: [],
    idleSeatEvents: events,
  }, { width: 100 });
  assert.match(rendered, /idle seat/);
  assert.match(rendered, /T-ready/);
});

function pathForTestHome() {
  return isolatedHome;
}
