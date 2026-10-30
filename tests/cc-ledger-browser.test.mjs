// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ledgerStats as browserLedgerStats,
  readyTickets as browserReadyTickets,
  ticketToQueueJob as browserTicketToQueueJob,
  listQueueJobsForProject as browserListQueueJobsForProject,
} from '../tools/watch-assets/cc-ledger-browser.js';
import { ledgerStats, readyTickets } from '../tools/tickets.mjs';
import { ticketToQueueJob } from '../tools/queue-commands.mjs';
import { listQueueJobsForProject } from '../tools/burst-route.mjs';

const fixtureLedger = {
  requirements: [{ id: 'R-001', text: 'Auth' }, { id: 'R-002', text: 'Burst' }],
  scope: { stages: [{ id: 'S1', name: 'One' }, { id: 'S2', name: 'Two' }] },
  tickets: [
    { id: 'T-1001', title: 'Done base', type: 'build', status: 'done', stage: 'S1', scopeRefs: ['R-001'], size: 'S', risk: 'low' },
    { id: 'T-1002', title: 'Ready next', type: 'build', status: 'ready', stage: 'S1', scopeRefs: ['R-001'], dependsOn: ['T-1001'], size: 'S', risk: 'low' },
    { id: 'T-1003', title: 'Blocked dep', type: 'build', status: 'todo', stage: 'S2', scopeRefs: ['R-002'], dependsOn: ['T-1004'], size: 'S', risk: 'low' },
    { id: 'T-1004', title: 'Still running', type: 'build', status: 'running', stage: 'S2', scopeRefs: ['R-002'], size: 'S', risk: 'low' },
    { id: 'T-1005', title: 'Proposed ext', type: 'build', status: 'proposed', stage: 'S1', origin: 'comment', scopeRefs: ['R-001'], size: 'S', risk: 'low' },
    { id: 'T-1006', title: 'Cancelled', type: 'build', status: 'cancelled', stage: 'S1', scopeRefs: ['R-001'], size: 'S', risk: 'low' },
    { id: 'T-1007', title: 'Burst cloud', type: 'build', status: 'ready', stage: 'S2', lane: 'burst', scopeRefs: ['R-002'], size: 'S', risk: 'low' },
    { id: 'T-1008', title: 'Unapproved proposal', type: 'build', status: 'todo', stage: 'S1', origin: 'handoff', scopeRefs: ['R-001'], size: 'S', risk: 'low' },
  ],
};

const projectBurstOff = { id: 'alpha', burst: 'off' };
const projectBurstOn = { id: 'alpha', burst: 'on' };

test('cc-ledger-browser ledgerStats matches server', () => {
  const server = ledgerStats(fixtureLedger);
  const browser = browserLedgerStats(fixtureLedger);
  assert.deepEqual(browser, server);
});

test('cc-ledger-browser readyTickets matches server', () => {
  const tickets = fixtureLedger.tickets;
  assert.deepEqual(browserReadyTickets(tickets), readyTickets(tickets));
});

test('cc-ledger-browser ticketToQueueJob matches server', () => {
  for (const ticket of fixtureLedger.tickets) {
    assert.deepEqual(browserTicketToQueueJob(ticket), ticketToQueueJob(ticket));
  }
  assert.equal(browserTicketToQueueJob(null), ticketToQueueJob(null));
});

test('cc-ledger-browser listQueueJobsForProject matches server', () => {
  const jobs = fixtureLedger.tickets.map(ticketToQueueJob).filter(Boolean);
  assert.deepEqual(
    browserListQueueJobsForProject(jobs, projectBurstOff),
    listQueueJobsForProject(jobs, projectBurstOff),
  );
  assert.deepEqual(
    browserListQueueJobsForProject(jobs, projectBurstOn),
    listQueueJobsForProject(jobs, projectBurstOn),
  );
});
