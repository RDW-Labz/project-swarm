// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READY_POOL_MIN } from '../../tools/managers/ticket-manager/ready-pool.mjs';
import {
  checkTicketManagerScopeIntegrity,
  fillReadyPool,
} from '../../tools/managers/ticket-manager/scope-integrity.mjs';

const scope = {
  stages: [{ id: 'S1', title: 'Build' }],
  requirements: [{ id: 'R-901', stage: 'S1', title: 'Requirement', acceptance: ['Accepted'] }],
  context: [],
  sections: [],
  external: [],
  sensitive: [],
  protected: [],
};

function t(id, over = {}) {
  return {
    id,
    title: `ticket ${id}`,
    type: 'build',
    stage: 'S1',
    scopeRefs: ['R-901'],
    acceptance: ['accepted'],
    files: [`src/${id}.ts`],
    context: [],
    contracts: [],
    tests: [],
    dependsOn: [],
    size: 'S',
    risk: 'low',
    status: 'todo',
    ...over,
  };
}

function readyCount(tickets) {
  return tickets.filter((x) => x.status === 'ready').length;
}

test('AC1: keeps at least 5 ready tickets per active project', () => {
  const tickets = [t('T-1'), t('T-2'), t('T-3'), t('T-4'), t('T-5'), t('T-6')];
  const { tickets: next, promoted } = fillReadyPool({ tickets });
  assert.ok(readyCount(next) >= READY_POOL_MIN);
  assert.equal(readyCount(next), READY_POOL_MIN);
  assert.equal(promoted.length, READY_POOL_MIN);
});

test('AC1: does not promote tickets that need the owner', () => {
  const tickets = [t('T-1'), t('T-2'), t('T-3'), t('T-4'), t('T-5'), t('T-6')];
  const { tickets: next, promoted } = fillReadyPool({ tickets, held: new Set(['T-1']) });
  const held = next.find((x) => x.id === 'T-1');
  assert.equal(held.status, 'todo');
  assert.ok(!promoted.some((p) => p.ticket === 'T-1'));
  assert.equal(readyCount(next), READY_POOL_MIN);
});

test('AC1: leaves an inactive project unchanged', () => {
  const tickets = [t('T-1', { status: 'done' }), t('T-2', { status: 'cancelled' })];
  const { tickets: next, promoted } = fillReadyPool({ tickets });
  assert.equal(promoted.length, 0);
  assert.equal(readyCount(next), 0);
});

test('AC2: re-plans a blocked ticket whose dependencies are done and reports it', () => {
  const tickets = [
    t('T-1', { status: 'done' }),
    t('T-2', { status: 'blocked', dependsOn: ['T-1'] }),
    t('T-3'),
    t('T-4'),
    t('T-5'),
    t('T-6'),
  ];
  const { tickets: next, promoted } = fillReadyPool({ tickets });
  assert.equal(next.find((x) => x.id === 'T-2').status, 'ready');
  assert.deepEqual(
    promoted.find((p) => p.ticket === 'T-2'),
    { ticket: 'T-2', from: 'blocked' },
  );
});

test('AC2: keeps a blocked ticket blocked while a dependency is unfinished', () => {
  const tickets = [
    t('T-1'),
    t('T-2', { status: 'blocked', dependsOn: ['T-1'] }),
    t('T-3'),
    t('T-4'),
    t('T-5'),
  ];
  const { tickets: next } = fillReadyPool({ tickets });
  assert.equal(next.find((x) => x.id === 'T-2').status, 'blocked');
});

test('AC3: logs each re-plan with a reason naming the ticket and its prior state', () => {
  const tickets = [
    t('T-1', { status: 'done' }),
    t('T-2', { status: 'blocked', dependsOn: ['T-1'] }),
    t('T-3'),
    t('T-4'),
    t('T-5'),
    t('T-6'),
  ];
  const gate = checkTicketManagerScopeIntegrity({ scope, tickets });
  const finding = gate.findings.find((f) => f.code === 'ready-pool-promote' && f.ticket === 'T-2');
  assert.ok(finding, 'expected a ready-pool-promote finding for T-2');
  assert.equal(finding.severity, 'info');
  assert.equal(finding.action, 'move-to-checklist');
  assert.match(finding.reason, /T-2/);
  assert.match(finding.reason, /moved from blocked to ready/);
});

test('AC3: logs todo promotions with a reason and no shortfall once the pool is full', () => {
  const tickets = [t('T-1'), t('T-2'), t('T-3'), t('T-4'), t('T-5'), t('T-6')];
  const gate = checkTicketManagerScopeIntegrity({ scope, tickets });
  const promotions = gate.findings.filter((f) => f.code === 'ready-pool-promote');
  assert.equal(promotions.length, READY_POOL_MIN);
  for (const f of promotions) {
    assert.match(f.reason, /moved from todo to ready/);
  }
  assert.ok(!gate.findings.some((f) => f.code === 'ready-pool-shortfall'));
});
