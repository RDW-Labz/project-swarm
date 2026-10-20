// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseScope, scopeHash } from '../tools/scope.mjs';
import { checkTicketTree } from '../tools/scope-integrity.mjs';
import {
  buildSplitManifest,
  existingSplitContext,
  runScopeCommand,
  ticketsFromStageLists,
} from '../tools/scope-commands.mjs';
import { createLedger, readLedger, writeLedger, approveLedger } from '../tools/tickets.mjs';

const SCOPE = `# Scope: Parts Request App
Version: 1

## Overview
Signed-in users create parts requests.

## Stages
- S1: Foundations
- S2: Requests

## S1 Foundations
### R-001 A signed-in user can create a parts request.
Acceptance:
- The form needs a part name and a quantity of at least 1.

### R-002 A signed-in user can pay for a request with Stripe payments.
Acceptance:
- A Stripe test payment of 10 dollars completes.

## S2 Requests
### R-003 The app sends a confirmation email through an email provider.
Acceptance:
- The email provider accepts the message within 5 seconds.

### R-004 A user can see the status of each request.
Acceptance:
- The status column shows one of 3 values.

## External
- Stripe: payments

## Sensitive
- payments

## Protected
- .env
`;

const scope = parseScope(SCOPE);

const ticket = (over) => ({
  id: 'T-0001',
  title: 'Build it',
  type: 'build',
  stage: 'S1',
  epic: 'E-01',
  scopeRefs: ['R-001'],
  acceptance: ['It works'],
  files: ['src/x.mjs'],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'todo',
  ...over,
});

const clean = () => [
  ticket({ id: 'T-0001', scopeRefs: ['R-001'], stage: 'S1', files: ['src/form.mjs'] }),
  ticket({ id: 'T-0002', scopeRefs: ['R-002'], stage: 'S1', files: ['src/pay.mjs'], dependsOn: ['T-0001'] }),
  ticket({ id: 'T-0003', scopeRefs: ['R-003'], stage: 'S2', files: ['src/mail.mjs'] }),
  ticket({ id: 'T-0004', scopeRefs: ['R-004'], stage: 'S2', files: ['src/status.mjs'] }),
];

const edit = (tickets, id, over) => tickets.map((t) => (t.id === id ? { ...t, ...over } : t));

test('done and new todo tickets sharing a file pass the tree check', () => {
  const tickets = [
    ...clean(),
    ticket({ id: 'T-0010', status: 'done', files: ['src/shared.mjs'], scopeRefs: ['R-001'] }),
    ticket({ id: 'T-0011', status: 'todo', files: ['src/shared.mjs'], scopeRefs: ['R-003'] }),
  ];
  const r = checkTicketTree({ scope, tickets });
  assert.equal(r.ok, true);
  assert.deepEqual(r.conflicts, []);
});

test('two open tickets sharing a file still conflict', () => {
  const tickets = edit(edit(clean(), 'T-0001', { files: ['src/shared.mjs'] }), 'T-0003', { files: ['src/shared.mjs'] });
  const r = checkTicketTree({ scope, tickets });
  assert.ok(r.errors.some((e) => e.code === 'conflict'));
});

test('ordered open tickets sharing a file pass the tree check', () => {
  const tickets = edit(edit(clean(), 'T-0001', { files: ['src/shared.mjs'] }), 'T-0003', { files: ['src/shared.mjs'], dependsOn: ['T-0001'] });
  const r = checkTicketTree({ scope, tickets });
  assert.deepEqual(r.conflicts, []);
});

test('split prompt lists open tickets as candidates and done tickets as context', () => {
  const existing = {
    files: ['- src/app/page.tsx'],
    ...existingSplitContext([
      ticket({ id: 'T-0100', status: 'ready', files: ['src/open.mjs'], title: 'Open work' }),
      ticket({ id: 'T-0101', status: 'done', files: ['src/done.mjs'], title: 'Finished' }),
      ticket({ id: 'T-0102', type: 'human', status: 'todo', steps: ['Do it'], files: [], title: 'Human gate' }),
    ]),
  };
  const prompt = buildSplitManifest(scope, { stage: 'S1', existing }).jobs[0].prompt;
  assert.match(prompt, /Existing open tickets/);
  assert.match(prompt, /T-0100 \[ready\]/);
  assert.match(prompt, /T-0102 \[todo\].*human prerequisite/);
  assert.match(prompt, /Done tickets \(context only/);
  assert.match(prompt, /T-0101 \[done\]/);
  assert.doesNotMatch(prompt, /depend on them by writing their id in context, not dependsOn/);
});

test('ticketsFromStageLists resolves dependsOn on an existing open ticket id', () => {
  const ledger = { tickets: [ticket({ id: 'T-0050', status: 'running', files: ['src/base.mjs'] })] };
  const built = ticketsFromStageLists(
    [{ stage: 'S2', items: [{ key: 'follow', title: 'Follow up', type: 'build', scopeRefs: ['R-004'], acceptance: ['ok'], files: ['src/status.mjs'], dependsOn: ['T-0050'], size: 'S', risk: 'low' }] }],
    scope,
    { startAt: 10, ledger },
  );
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.tickets[0].dependsOn, ['T-0050']);
});

test('ticketsFromStageLists diagnoses an unknown existing ticket id', () => {
  const built = ticketsFromStageLists(
    [{ stage: 'S2', items: [{ key: 'bad', title: 'Bad dep', type: 'build', scopeRefs: ['R-004'], acceptance: ['ok'], files: ['src/x.mjs'], dependsOn: ['T-9999'], size: 'S', risk: 'low' }] }],
    scope,
    { startAt: 20, ledger: { tickets: clean() } },
  );
  assert.match(built.errors[0], /unknown dependsOn ticket T-9999/);
});

test('editTicketFiles over a done owner succeeds and over an open owner is refused', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-own-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = createLedger({
    scope: { name: 'P', version: 1, hash: 'a'.repeat(64) },
    tickets: [
      ticket({ id: 'T-0090', status: 'done', files: ['src/useShops.ts'] }),
      ticket({ id: 'T-0091', status: 'todo', files: ['src/T-0091.ts'] }),
      ticket({ id: 'T-0092', status: 'todo', files: ['src/blocker.ts'] }),
    ],
  });
  await writeLedger(root, { ...ledger, approved: approveLedger(ledger).approved });

  const overDone = await runScopeCommand(root, 'tickets', ['T-0091', '--files', 'src/T-0091.ts,src/useShops.ts', '--yes']);
  assert.equal(overDone.exitCode, 0, overDone.stdout);
  assert.deepEqual((await readLedger(root)).tickets.find((x) => x.id === 'T-0091').files, ['src/T-0091.ts', 'src/useShops.ts']);

  const overOpen = await runScopeCommand(root, 'tickets', ['T-0091', '--files', 'src/T-0091.ts,src/useShops.ts,src/blocker.ts', '--yes']);
  assert.equal(overOpen.exitCode, 1);
  assert.match(overOpen.stdout, /src\/blocker\.ts is already written by T-0092/);
});

test('merge ingest persists dependsOn on an existing open ticket', async (t) => {
  const SCOPE_MERGE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo.', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '### R-002 A user can list requests.', 'Acceptance:', '- Returns rows.', '', '## Protected', '- .env', ''].join('\n');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-merge-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE_MERGE);
  const base = createLedger({
    scope: { name: 'Demo', version: 1, hash: scopeHash(SCOPE_MERGE), file: 'docs/scope/scope.md' },
    tickets: [
      { id: 'T-0001', title: 'Base', type: 'build', stage: 'S1', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/base.mjs'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready' },
      { id: 'T-0002', title: 'Mount create', type: 'build', integration: true, stage: 'S1', epic: 'E', scopeRefs: ['R-001'], acceptance: ['route'], files: ['src/routes/create.mjs'], tests: ['tests/create.test.mjs'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'done' },
    ],
  });
  await writeLedger(root, { ...base, wiring: true });
  const runId = 'r-merge';
  const ws = `.swarm/workspaces/${runId}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  const items = [
    { key: 'list', title: 'List', type: 'build', scopeRefs: ['R-002'], acceptance: ['rows'], files: ['src/list.mjs'], dependsOn: ['T-0001'], size: 'S', risk: 'low' },
    { key: 'mount-list', title: 'Mount list', type: 'build', integration: true, scopeRefs: ['R-002'], acceptance: ['route'], files: ['src/routes/list.mjs'], tests: ['tests/list.test.mjs'], size: 'S', risk: 'low' },
  ];
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', runId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', runId, 'state.json'), JSON.stringify({ id: runId, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
  const ingest = await runScopeCommand(root, 'scope', ['split', '--ingest', runId, '--merge']);
  assert.equal(ingest.exitCode, 0, ingest.stdout);
  const added = (await readLedger(root)).tickets.find((x) => x.title === 'List');
  assert.deepEqual(added?.dependsOn, ['T-0001']);
});
