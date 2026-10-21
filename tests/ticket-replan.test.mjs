// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../tools/tickets.mjs';
import {
  applyReplanToTicket,
  gatesCountForTicket,
  persistReplans,
  replanLedger,
  replanPlanForTicket,
  replanTickets,
  ticketQualifiesForReplan,
} from '../tools/ticket-replan.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-replan-test-'));
const scope = { name: 'Demo', version: 1, hash: 'abc' };
const ticket = (id, over = {}) => ({
  id,
  title: `Ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-013'],
  acceptance: ['it works'],
  files: ['src/a.mjs'],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'todo',
  ...over,
});

test('AC1: a blocked ticket is rerouted to ready without a scope manifest', () => {
  const blocked = ticket('T-0001', { status: 'blocked', blockReason: 'failure', attempts: 1 });
  const plan = replanPlanForTicket(blocked, 0);
  assert.ok(plan);
  assert.equal(plan.action, 'reroute-lane');
  assert.match(plan.reason, /without orchestrator manifest/);
  const applied = applyReplanToTicket(blocked, 0);
  assert.equal(applied.ticket.status, 'ready');
  assert.equal(applied.ticket.lane, undefined);
  assert.equal(applied.ticket.blockReason, undefined);
});

test('AC1: two failures trigger a re-split plan without a scope manifest', () => {
  const blocked = ticket('T-0002', { status: 'blocked', blockReason: 'failure', attempts: 2 });
  const plan = replanPlanForTicket(blocked, 0);
  assert.equal(plan?.action, 'split-ticket');
  assert.match(plan?.reason ?? '', /re-split without a new scope manifest/);
  const applied = applyReplanToTicket(blocked, 0);
  assert.equal(applied.ticket.status, 'ready');
  assert.match(applied.ticket.replanNote, /re-split/);
});

test('AC1: dependency blocks are not replanned', () => {
  const blocked = ticket('T-0003', { status: 'blocked', blockReason: 'deps', dependsOn: ['T-0099'] });
  assert.equal(ticketQualifiesForReplan(blocked), false);
  assert.equal(replanPlanForTicket(blocked), null);
});

test('AC1: a blocked ticket that gates others is re-split', () => {
  const tickets = [
    ticket('T-0010', { status: 'blocked', blockReason: 'failure', attempts: 1 }),
    ticket('T-0011', { status: 'todo', dependsOn: ['T-0010'] }),
  ];
  assert.equal(gatesCountForTicket(tickets, 'T-0010'), 1);
  const plan = replanPlanForTicket(tickets[0], 1);
  assert.equal(plan?.action, 'split-ticket');
  const { tickets: next, replans } = replanTickets(tickets);
  assert.equal(replans.length, 1);
  assert.equal(next[0].status, 'ready');
  assert.equal(next[1].status, 'todo');
});

test('AC2: persistReplans logs each replan with its reason', async () => {
  const root = tmpRoot();
  const ledger = T.createLedger({
    scope,
    tickets: [ticket('T-0020', { status: 'blocked', blockReason: 'failure', attempts: 2 })],
  });
  await T.writeLedger(root, ledger);
  const { replans, changed } = await persistReplans(root, ledger);
  assert.equal(changed, true);
  assert.equal(replans.length, 1);
  assert.match(replans[0].reason, /failed attempts/);
  const saved = await T.readLedger(root);
  assert.equal(saved.tickets[0].status, 'ready');
  const lines = fs.readFileSync(T.logPath(root), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const replanLine = lines.find((l) => l.event === 'replan');
  assert.ok(replanLine);
  assert.equal(replanLine.id, 'T-0020');
  assert.equal(replanLine.action, 'split-ticket');
  assert.equal(replanLine.reason, replans[0].reason);
});

test('replanLedger leaves tickets unchanged when nothing qualifies', () => {
  const ledger = T.createLedger({
    scope,
    tickets: [ticket('T-0030', { status: 'ready' })],
  });
  const { replans } = replanLedger(ledger);
  assert.deepEqual(replans, []);
});
