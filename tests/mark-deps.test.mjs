// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTicketsCommand, runScopeCommand } from '../tools/scope-commands.mjs';
import { createLedger, writeLedger, readLedger } from '../tools/tickets.mjs';

const base = { epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', stage: 'S1' };
const ticket = over => ({ ...base, title: 'A ticket', type: 'build', ...over });

async function project(t, tickets) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mark-deps-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets }));
  return root;
}
const statusOf = async (root, id) => (await readLedger(root)).tickets.find(t => t.id === id);

test('tickets --mark-deps lists first, then marks old dependency-blocked tickets and unlocks the ready ones', async t => {
  const root = await project(t, [
    ticket({ id: 'T-0001', status: 'done' }),
    ticket({ id: 'T-0002', status: 'blocked', dependsOn: ['T-0001'] }),          // old deps block, dependency done: ready now
    ticket({ id: 'T-0003', status: 'blocked', dependsOn: ['T-0004'] }),          // old deps block, dependency open: waits
    ticket({ id: 'T-0004', status: 'todo' }),
    ticket({ id: 'T-0005', status: 'blocked', dependsOn: ['T-0001'], attempts: 2, retryNote: 'x' }), // failed before: untouched
    ticket({ id: 'T-0006', status: 'blocked', dependsOn: ['T-0001'], blockReason: 'manual' }),       // owner hold: untouched
    ticket({ id: 'T-0007', status: 'blocked' }),                                  // no dependencies: untouched
  ]);
  const dry = await runTicketsCommand(root, ['--mark-deps']);
  assert.match(dry.stdout, /2 blocked ticket\(s\)/);
  assert.match(dry.stdout, /T-0002/);
  assert.match(dry.stdout, /T-0003/);
  assert.doesNotMatch(dry.stdout, /T-0005|T-0006|T-0007/);
  assert.equal((await statusOf(root, 'T-0002')).blockReason, undefined, 'a dry run changes nothing');
  const done = await runTicketsCommand(root, ['--mark-deps', '--yes']);
  assert.equal(done.exitCode ?? 0, 0);
  assert.match(done.stdout, /2 ticket\(s\) marked as blocked by dependencies; 1 unlocked now \(T-0002\)/);
  assert.equal((await statusOf(root, 'T-0002')).status, 'ready');
  const waiting = await statusOf(root, 'T-0003');
  assert.equal(waiting.status, 'blocked');
  assert.equal(waiting.blockReason, 'deps');
  for (const id of ['T-0005', 'T-0006', 'T-0007']) assert.equal((await statusOf(root, id)).status, 'blocked');
  assert.equal((await statusOf(root, 'T-0005')).blockReason, undefined);
  // When its dependency is done it unlocks by itself.
  const ledger = await readLedger(root);
  ledger.tickets.find(x => x.id === 'T-0004').status = 'done';
  await writeLedger(root, ledger);
  const { unlockLedger } = await import('../tools/scope-commands.mjs');
  assert.deepEqual(await unlockLedger(root), ['T-0003']);
});

test('tickets --mark-deps with ids marks only those and refuses ineligible ones', async t => {
  const root = await project(t, [
    ticket({ id: 'T-0001', status: 'todo' }),
    ticket({ id: 'T-0002', status: 'blocked', dependsOn: ['T-0001'] }),
    ticket({ id: 'T-0003', status: 'blocked', dependsOn: ['T-0001'] }),
    ticket({ id: 'T-0004', status: 'ready' }),
  ]);
  const bad = await runTicketsCommand(root, ['--mark-deps', 'T-0004', '--yes']);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /not eligible.*T-0004/);
  const one = await runTicketsCommand(root, ['--mark-deps', 'T-0002', '--yes']);
  assert.match(one.stdout, /1 ticket\(s\) marked/);
  assert.equal((await statusOf(root, 'T-0002')).blockReason, 'deps');
  assert.equal((await statusOf(root, 'T-0003')).blockReason, undefined);
  const none = await runTicketsCommand(root, ['--mark-deps', '--yes']);
  assert.match(none.stdout, /marked as blocked by dependencies/);
  assert.equal((await statusOf(root, 'T-0003')).blockReason, 'deps');
  assert.match((await runTicketsCommand(root, ['--mark-deps'])).stdout, /no old blocked tickets/);
});

test('the command is reachable from the CLI entry (swarm tickets --mark-deps)', async t => {
  const root = await project(t, [ticket({ id: 'T-0001', status: 'done' }), ticket({ id: 'T-0002', status: 'blocked', dependsOn: ['T-0001'] })]);
  const res = await runScopeCommand(root, 'tickets', ['--mark-deps']);
  assert.match(res.stdout, /1 blocked ticket\(s\)/);
});
