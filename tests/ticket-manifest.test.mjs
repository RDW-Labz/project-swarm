// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketsToManifest, ticketOutcome } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';
import { validateManifest } from '../tools/swarm.mjs';

const SCOPE_MD = `# Scope: Parts Request App
Version: 1

## Overview
Engineers request spare parts.

## Stages
- S1: Foundations
- S2: Requests

## S1 Foundations
### R-001 A signed-in user can create a parts request.
Acceptance:
- The form needs a part name and a quantity of at least 1.
- A saved request appears in the list within one second.

## S2 Requests
### R-002 A user can pay for an expedited request with Stripe payments.
Acceptance:
- A paid request is marked paid within 5 seconds.

### R-003 The system sends a confirmation through the email provider.
Acceptance:
- A confirmation email is sent within 60 seconds of payment.

### R-004 An admin can export all requests as CSV.
Acceptance:
- The export contains one row per request.

## External
- Stripe: payments
- Email provider: confirmations

## Sensitive
- payments

## Protected
- .env
`;

const scope = parseScope(SCOPE_MD);

function ticket(over = {}) {
  return {
    id: 'T-0001', title: 'Create request form', type: 'build', stage: 'S1', epic: 'E-01 Requests',
    scopeRefs: ['R-001'], acceptance: ['form validates quantity'], files: ['src/form.mjs'],
    context: ['docs/plan.md'], contracts: [], dependsOn: [], size: 'S', risk: 'low',
    sensitive: false, status: 'ready', ...over,
  };
}

test('emits only todo and ready tickets', () => {
  const tickets = [ticket({ id: 'T-0001' }), ticket({ id: 'T-0002', status: 'running' }), ticket({ id: 'T-0003', status: 'todo' })];
  const { manifest } = ticketsToManifest(tickets, { scope });
  assert.deepEqual(manifest.jobs.map(j => j.id), ['T-0001', 'T-0003']);
});

test('build job carries the ticket fields', () => {
  const { manifest } = ticketsToManifest([ticket()], { scope });
  const job = manifest.jobs[0];
  assert.equal(manifest.version, 1);
  assert.equal(job.type, 'build');
  assert.equal(job.agent, 'auto');
  assert.equal(job.sensitive, false);
  assert.deepEqual(job.outputs, ['src/form.mjs']);
  assert.deepEqual(job.acceptance, ['form validates quantity']);
  assert.equal(job.timeoutMs, 600000);
  assert.equal('hard' in job, false);
});

test('high risk tickets get hard true and others do not', () => {
  const { manifest } = ticketsToManifest([ticket({ id: 'T-0001', risk: 'high' }), ticket({ id: 'T-0002' })], { scope });
  assert.equal(manifest.jobs[0].hard, true);
  assert.equal('hard' in manifest.jobs[1], false);
});

test('prompt includes referenced requirement text and acceptance and the rule', () => {
  const { manifest } = ticketsToManifest([ticket({ scopeRefs: ['R-002'] })], { scope });
  const prompt = manifest.jobs[0].prompt;
  assert.ok(prompt.includes('Stripe payments'));
  assert.ok(prompt.includes('marked paid within 5 seconds'));
  assert.ok(prompt.includes('Work only on the files you own; report the ticket id.'));
});

test('after lists only dependencies inside the manifest', () => {
  const ledger = { tickets: [ticket({ id: 'T-0000', status: 'done' })] };
  const tickets = [
    ticket({ id: 'T-0001', dependsOn: ['T-0000'] }),
    ticket({ id: 'T-0002', dependsOn: ['T-0001', 'T-0000'], status: 'todo' }),
  ];
  const { manifest } = ticketsToManifest(tickets, { ledger, scope, ready: false });
  assert.equal(manifest.jobs[0].after, undefined);
  assert.deepEqual(manifest.jobs[1].after, ['T-0001']);
});

test('folder outputs are skipped with a warning', () => {
  const { manifest, warnings } = ticketsToManifest([ticket({ files: ['src/form.mjs', 'src/parts/'] })], { scope });
  assert.deepEqual(manifest.jobs[0].outputs, ['src/form.mjs']);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('src/parts/'));
});

test('design tickets are skipped and reported', () => {
  const r = ticketsToManifest([ticket({ id: 'T-0001', type: 'design' }), ticket({ id: 'T-0002' })], { scope });
  assert.deepEqual(r.skipped, ['T-0001']);
  assert.deepEqual(r.manifest.jobs.map(j => j.id), ['T-0002']);
});

test('human tickets become human jobs with steps', () => {
  const h = ticket({ id: 'T-0009', type: 'human', title: 'Day 0: Stripe', scopeRefs: [], acceptance: [], steps: ['Create the Stripe account'] });
  const { manifest } = ticketsToManifest([h], { scope });
  assert.deepEqual(manifest.jobs[0], { id: 'T-0009', type: 'human', title: 'Day 0: Stripe', steps: ['Create the Stripe account'] });
});

test('context merges contracts without duplicates', () => {
  const t = ticket({
    context: ['docs/plan.md', 'contracts/types.d.ts'],
    contracts: ['contracts/types.d.ts', 'contracts/validators.mjs'],
  });
  const { manifest } = ticketsToManifest([t], { scope });
  assert.deepEqual(manifest.jobs[0].context, ['docs/plan.md', 'contracts/types.d.ts', 'contracts/validators.mjs']);
});

test('contract option sets manifest contract and adds it to context once', () => {
  const { manifest } = ticketsToManifest([ticket({ context: ['docs/plan.md'] })], { scope, contract: 'contracts/types.d.ts' });
  assert.equal(manifest.contract, 'contracts/types.d.ts');
  assert.equal(manifest.jobs[0].context.filter(p => p === 'contracts/types.d.ts').length, 1);
});

test('test, docs and migration tickets map to test, docs and build', () => {
  const tickets = [
    ticket({ id: 'T-0001', type: 'test' }),
    ticket({ id: 'T-0002', type: 'docs' }),
    ticket({ id: 'T-0003', type: 'migration' }),
  ];
  const { manifest } = ticketsToManifest(tickets, { scope });
  assert.deepEqual(manifest.jobs.map(j => j.type), ['test', 'docs', 'build']);
});

test('maxJobs caps the jobs and warns about the rest', () => {
  const tickets = [ticket({ id: 'T-0001' }), ticket({ id: 'T-0002' }), ticket({ id: 'T-0003' })];
  const r = ticketsToManifest(tickets, { scope, maxJobs: 2 });
  assert.equal(r.manifest.jobs.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.ok(r.warnings.some(w => w.includes('over maxJobs')));
});

test('maxJobs must be a positive safe integer', () => {
  for (const v of [0, -1, 1.5, NaN]) {
    assert.throws(() => ticketsToManifest([ticket()], { scope, maxJobs: v }), e => e.code === 'ticket-max-jobs');
  }
});

test('a ticket marked not sensitive becomes sensitive when its requirement names a sensitive entry', () => {
  const { manifest } = ticketsToManifest([ticket({ scopeRefs: ['R-002'], sensitive: false })], { scope });
  assert.equal(manifest.jobs[0].sensitive, true);
});

test('ready false includes tickets in any status', () => {
  const tickets = [ticket({ id: 'T-0001' }), ticket({ id: 'T-0002', status: 'running' })];
  const { manifest } = ticketsToManifest(tickets, { scope, ready: false });
  assert.equal(manifest.jobs.length, 2);
});

test('tickets with unfinished dependencies are not ready', () => {
  const tickets = [ticket({ id: 'T-0001', status: 'todo' }), ticket({ id: 'T-0002', dependsOn: ['T-0001'], status: 'todo' })];
  const { manifest } = ticketsToManifest(tickets, { scope });
  assert.deepEqual(manifest.jobs.map(j => j.id), ['T-0001']);
});

test('a plain build manifest passes validateManifest', () => {
  const { manifest } = ticketsToManifest([ticket()], { scope });
  const result = validateManifest(manifest);
  assert.ok(!result || result.ok !== false);
});

test('ticketOutcome maps complete, failed and timeout and leaves held alone', () => {
  const ledger = { tickets: [ticket({ id: 'T-0001' }), ticket({ id: 'T-0002' }), ticket({ id: 'T-0003' }), ticket({ id: 'T-0004' })] };
  const state = {
    'T-0001': { state: 'complete' },
    'T-0002': { state: 'failed', error: 'boom' },
    'T-0003': { state: 'held' },
    'T-0004': { state: 'timeout', error: 'slow' },
  };
  assert.deepEqual(ticketOutcome(state, ledger), [
    { id: 'T-0001', to: 'review', note: 'run complete' },
    { id: 'T-0002', to: 'blocked', note: 'boom' },
    { id: 'T-0004', to: 'blocked', note: 'slow' },
  ]);
});

test('ticketOutcome ignores ids that are not in the ledger', () => {
  assert.deepEqual(ticketOutcome({ 'T-9999': { state: 'complete' } }, { tickets: [] }), []);
});
