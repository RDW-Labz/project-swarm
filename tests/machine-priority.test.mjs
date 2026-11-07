// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { machineShareForProject, machineAllowance } from '../tools/project-priority.mjs';

const host = os.hostname();
const slots = (project, n, priority) => Array.from({ length: n }, (_, i) => ({ id: `${project}-${i}`, pid: process.pid, host, runId: `run-${project}`, project, machineSharePriority: priority }));

test('AC1: machine slots are split across active projects by priority (3:1 of 8 gives 6 and 2)', () => {
  const active = new Set(['A', 'B']);
  const priorities = { A: 3, B: 1 };
  assert.equal(machineShareForProject({ max: 8, activeProjects: active, project: 'A', priorities }), 6);
  assert.equal(machineShareForProject({ max: 8, activeProjects: active, project: 'B', priorities }), 2);
});

test('AC1: equal priorities give equal shares when no weights are set', () => {
  const active = new Set(['A', 'B', 'C']);
  assert.equal(machineShareForProject({ max: 9, activeProjects: active, project: 'A', priorities: {} }), 3);
  assert.equal(machineShareForProject({ max: 9, activeProjects: active, project: 'C', priorities: {} }), 3);
});

test('AC1: a project holding its full share cannot take the share another active project is asking for', () => {
  const store = { slots: { anthropic: slots('A', 6, 3) }, pauses: {}, demand: {} };
  const verdict = machineAllowance({ store, project: 'B', count: 5, max: 8, isAlive: () => true, priority: 1 });
  assert.equal(verdict.allowed, 2, 'B gets its guaranteed share of 2; the 2 free workers are not more than that');
});

test('AC1: a waiting higher-priority project reserves its share against a lower-priority one', () => {
  const time = 1_000_000;
  const store = {
    slots: {},
    pauses: {},
    demand: {
      'B|rb|anthropic': { project: 'B', runId: 'rb', agent: 'anthropic', count: 10, pid: 1, host, since: time, at: time, machineSharePriority: 1 },
    },
  };
  const verdict = machineAllowance({ store, project: 'A', count: 10, max: 8, isAlive: () => true, time, priority: 3 });
  assert.equal(verdict.share, 6);
  assert.equal(verdict.allowed, 6, 'A is capped at its weighted share while B is waiting');
});
