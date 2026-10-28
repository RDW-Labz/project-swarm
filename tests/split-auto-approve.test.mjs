// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateAutoApprove } from '../tools/split-auto-approve.mjs';
import { swarmSubcommandAlwaysAllowed } from '../tools/orchestrator-allow.mjs';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger } from '../tools/tickets.mjs';

const baseTicket = (id, extra = {}) => ({
  id,
  title: 'Work',
  type: 'build',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: ['src/a.mjs'],
  size: 'S',
  risk: 'low',
  status: 'todo',
  stage: 'S1',
  ...extra,
});

const baseSnapshot = (tickets, changeOrderIds = []) => ({
  at: '2024-01-01T00:00:00.000Z',
  by: 'owner',
  ticketsHash: 'abc',
  changeOrderIds,
  tickets,
});

const passingLedger = (snapshot, { extraTickets = [], changeOrders = [{ id: 'CO-001' }] } = {}) => ({
  tickets: [...snapshot.tickets, ...extraTickets],
  changeOrders,
});

test('evaluateAutoApprove: all conditions pass', () => {
  const snap = baseSnapshot([baseTicket('T-0001', { status: 'done' })], []);
  const ledger = passingLedger(snap, {
    extraTickets: [baseTicket('T-0002')],
    changeOrders: [{ id: 'CO-001' }],
  });
  const result = evaluateAutoApprove({ ledger, snapshot: snap, profile: {} });
  assert.equal(result.ok, true);
  assert.equal(result.conditions.every(c => c.ok), true);
});

test('evaluateAutoApprove: each condition fails alone', () => {
  const snap = baseSnapshot([baseTicket('T-0001', { status: 'done' })], ['CO-001']);
  const ledger = passingLedger(snap, {
    extraTickets: [baseTicket('T-0002')],
    changeOrders: [{ id: 'CO-001' }],
  });
  assert.equal(evaluateAutoApprove({ ledger, snapshot: null, profile: {} }).conditions.find(c => c.name === 'snapshot').ok, false);
  assert.equal(evaluateAutoApprove({ ledger, snapshot: snap, profile: {} }).conditions.find(c => c.name === 'change-order').ok, false);

  const snap2 = baseSnapshot([baseTicket('T-0001', { status: 'done' })], []);
  const ledgerCancelled = {
    tickets: [baseTicket('T-0001', { status: 'cancelled' }), baseTicket('T-0002')],
    changeOrders: [{ id: 'CO-001' }],
  };
  assert.equal(evaluateAutoApprove({ ledger: ledgerCancelled, snapshot: snap2, profile: {} }).conditions.find(c => c.name === 'no-done-cancelled').ok, false);

  const snap3 = baseSnapshot([baseTicket('T-0001')], []);
  const ledgerPaid = {
    tickets: [baseTicket('T-0001'), baseTicket('T-0002', { lane: 'anthropic:haiku' })],
    changeOrders: [{ id: 'CO-001' }],
  };
  assert.equal(evaluateAutoApprove({ ledger: ledgerPaid, snapshot: snap3, profile: {} }).conditions.find(c => c.name === 'no-paid-lanes').ok, false);

  const snap4 = baseSnapshot([baseTicket('T-0001')], []);
  const ledgerMigration = {
    tickets: [baseTicket('T-0001'), baseTicket('T-0002', { type: 'migration', files: ['db/migrations/001.sql'] })],
    changeOrders: [{ id: 'CO-001' }],
  };
  assert.equal(evaluateAutoApprove({ ledger: ledgerMigration, snapshot: snap4, profile: {} }).conditions.find(c => c.name === 'no-migrations').ok, false);

  const snap5 = baseSnapshot([baseTicket('T-0001')], []);
  const ledgerDeploy = {
    tickets: [baseTicket('T-0001'), baseTicket('T-0002', { files: ['vercel.json'] })],
    changeOrders: [{ id: 'CO-001' }],
  };
  assert.equal(evaluateAutoApprove({ ledger: ledgerDeploy, snapshot: snap5, profile: {} }).conditions.find(c => c.name === 'no-deploy-or-main-merge').ok, false);
});

test('evaluateAutoApprove: cancelling a done ticket fails no-done-cancelled', () => {
  const snap = baseSnapshot([baseTicket('T-0001', { status: 'done' })], []);
  const ledger = {
    tickets: [baseTicket('T-0001', { status: 'cancelled' }), baseTicket('T-0002')],
    changeOrders: [{ id: 'CO-001' }],
  };
  const result = evaluateAutoApprove({ ledger, snapshot: snap, profile: {} });
  assert.equal(result.ok, false);
  const cond = result.conditions.find(c => c.name === 'no-done-cancelled');
  assert.equal(cond.ok, false);
  assert.match(cond.detail, /T-0001/);
});

test('orchestrator allow: scope approve --auto-ok only', () => {
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--auto-ok']), true);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--auto-ok', '--yes']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--auto-ok', '--accept-waves']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', 'scope.md', '--auto-ok']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--auto-ok=1']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['--yes', 'approve', '--auto-ok']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['--json', 'approve', '--auto-ok']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['approve', '--auto-ok', '']), false);
  assert.equal(swarmSubcommandAlwaysAllowed('scope', ['APPROVE', '--AUTO-OK']), true);
});

const SCOPE = [
  '# Scope: Manager gate', 'Version: 1', '', '## Overview', 'A manager-gated scope.', '',
  '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A feature works.', 'Acceptance:', '- It works.', '',
  '## External', '', '## Sensitive', '', '## Protected', '- .env', '',
].join('\n');

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'split-auto-approve-cmd-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const workspace = '.swarm/workspaces/r1/split-S1';
  await fs.mkdir(path.join(root, workspace, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, workspace, 'docs/scope/split/S1.json'), JSON.stringify([
    { key: 'module', title: 'Module', type: 'build', scopeRefs: ['R-001'], acceptance: ['works'], files: ['src/module.mjs'], size: 'S', risk: 'low' },
    { key: 'mount', title: 'Mount route', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['route works'], files: ['src/routes/module.mjs'], tests: ['tests/routes.test.mjs'], size: 'S', risk: 'low' },
  ]));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', jobs: [{ id: 'split-S1', status: 'complete', workspace }] }));
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  return root;
}

const gatePass = { runManagersScopeGate: async () => ({ run: { status: 'passed' } }) };

test('cmdApprove --auto-ok refuses without a prior owner snapshot', async t => {
  const root = await project(t);
  const result = await runScopeCommand(root, 'scope', ['approve', '--auto-ok'], gatePass);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /snapshot: FAIL/);
  assert.equal((await readLedger(root)).approved, null);
});

test('cmdApprove --auto-ok approves a safe change-order split', async t => {
  const root = await project(t);
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'], gatePass)).exitCode, 0);
  const ledger = await readLedger(root);
  const nextId = 'T-0003';
  ledger.changeOrders = [...(ledger.changeOrders ?? []), { id: 'CO-001', at: new Date().toISOString(), reason: 'add' }];
  ledger.tickets = [
    ...ledger.tickets,
    {
      id: nextId,
      title: 'Extra',
      type: 'build',
      scopeRefs: ['R-001'],
      acceptance: ['more'],
      files: ['src/extra.mjs'],
      size: 'S',
      risk: 'low',
      status: 'todo',
      stage: 'S1',
    },
  ];
  ledger.approved = null;
  const { writeLedger } = await import('../tools/tickets.mjs');
  await writeLedger(root, ledger);
  const result = await runScopeCommand(root, 'scope', ['approve', '--auto-ok'], gatePass);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /snapshot: ok/);
  const saved = await readLedger(root);
  assert.equal(saved.approved?.by, 'orchestrator-auto');
  const snap = JSON.parse(await fs.readFile(path.join(root, '.swarm/project/approved-tickets.json'), 'utf8'));
  assert.ok(snap.changeOrderIds.includes('CO-001'));
});
