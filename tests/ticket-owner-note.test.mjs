// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTicketsCommand } from '../tools/scope-commands.mjs';
import { createLedger, writeLedger, readLedger } from '../tools/tickets.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';

const base = { epic: 'E', scopeRefs: ['R-001'], acceptance: ['works'], files: ['src/a.mjs'], context: [], contracts: [], size: 'S', risk: 'low', sensitive: false, stage: 'S1' };
const ticket = (id, extra = {}) => ({ ...base, id, title: id, type: 'build', ...extra });

async function projectRoot(t2, tickets) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-owner-note-')));
  t2.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeLedger(root, createLedger({ scope: { name: 'S', version: 1, hash: 'a'.repeat(64) }, tickets }));
  return root;
}

test('--set ready --note saves ownerNote and keeps retryNote; prompt shows both lines', async t2 => {
  const retryNote = 'failed checks: tests; expected green';
  const guidance = 'focus on the edge case in validate()';
  const tk = ticket('T-0001', { status: 'blocked', blockReason: 'failure', retryNote, dependsOn: [] });
  const root = await projectRoot(t2, [tk]);

  const r = await runTicketsCommand(root, ['T-0001', '--set', 'ready', '--note', guidance, '--yes']);
  assert.equal(r.exitCode, 0);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.status, 'ready');
  assert.equal(after.retryNote, retryNote);
  assert.equal(after.ownerNote, guidance);
  assert.ok(after.ownerNoteAt);

  const { manifest } = ticketsToManifest([after], { ledger: { tickets: [after] }, ready: false });
  const prompt = manifest.jobs[0].prompt;
  assert.match(prompt, /Note from the owner or orchestrator for this attempt.*<<</);
  assert.match(prompt, new RegExp(guidance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /Previous attempt failed \(untrusted log text/);
  assert.match(prompt, /expected green/);
});

test('--clear-note clears ownerNote', async t2 => {
  const tk = ticket('T-0001', {
    status: 'ready',
    ownerNote: 'try the smaller diff',
    ownerNoteAt: '2026-01-01T00:00:00.000Z',
    retryNote: 'old failure',
    dependsOn: [],
  });
  const root = await projectRoot(t2, [tk]);

  assert.equal((await runTicketsCommand(root, ['T-0001', '--clear-note'])).exitCode, 0);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.retryNote, undefined);
  assert.equal(after.ownerNote, undefined);
  assert.equal(after.ownerNoteAt, undefined);
});

test('ownerNote redacts token-looking values built at runtime', async t2 => {
  const label = 'ACCESS_TOKEN';
  const value = 'v'.repeat(40);
  const raw = `${label}=${value}`;
  const root = await projectRoot(t2, [ticket('T-0001', { status: 'ready', dependsOn: [] })]);

  assert.equal((await runTicketsCommand(root, ['T-0001', '--note', raw])).exitCode, 0);
  const after = (await readLedger(root)).tickets[0];
  assert.match(after.ownerNote, new RegExp(`${label}=`));
  assert.doesNotMatch(after.ownerNote, new RegExp(value));
  assert.match(after.ownerNote, /\*\*\*/);
});

test('ownerNote is truncated to 600 characters', async t2 => {
  const long = 'n '.repeat(325);
  const root = await projectRoot(t2, [ticket('T-0001', { status: 'ready', dependsOn: [] })]);

  assert.equal((await runTicketsCommand(root, ['T-0001', '--note', long])).exitCode, 0);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.ownerNote.length, 600);
});
