// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { createLedger, logPath, readLedger, writeLedger } from '../tools/tickets.mjs';

const baseTicket = (id, extra = {}) => ({
  id,
  title: `Ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['works'],
  files: ['src/work.mjs', 'tests/work.test.mjs'],
  context: [],
  contracts: [],
  tests: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'blocked',
  blockReason: 'failure',
  attempts: 2,
  ...extra,
});

async function project(tickets) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-sync-replan-')));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', jobs: [] }));
  await fs.writeFile(path.join(root, '.swarm/project/scope.snapshot.md'), '# Scope: Demo\nVersion: 1\n');
  await writeLedger(root, createLedger({ scope: { name: 'Demo', version: 1, hash: 'scope' }, tickets }));
  return root;
}

test('scope sync replans a ticket that was already blocked, once, with smaller files', async () => {
  const root = await project([baseTicket('T-0001')]);
  const result = await runScopeCommand(root, 'scope', ['sync', 'r1'], { now: 1700000000000 });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /T-0001 replanned: .*failed attempts/);
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
  const events = (await fs.readFile(logPath(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const replan = events.find(entry => entry.event === 'replan');
  assert.equal(replan.id, 'T-0001');
  assert.match(replan.reason, /failed attempts/);
  assert.equal(replan.plan.action, 'split-ticket');

  const again = await readLedger(root);
  again.tickets[0].status = 'blocked';
  again.tickets[0].blockReason = 'failure';
  again.tickets[0].attempts = 3;
  await writeLedger(root, again);
  const second = await runScopeCommand(root, 'scope', ['sync', 'r1'], { now: 1700000001000 });
  assert.doesNotMatch(second.stdout, /T-0001 replanned/);
  assert.equal((await readLedger(root)).tickets[0].status, 'blocked');
  const lines = (await fs.readFile(logPath(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.filter(entry => entry.event === 'replan' && entry.id === 'T-0001').length, 1);
});

test('scope sync does not replan a ticket blocked during the current pass', async () => {
  const root = await project([baseTicket('T-0005', { status: 'running', blockReason: undefined, attempts: 3, escalation: 3 })]);
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', jobs: [{ id: 'T-0005', status: 'failed', error: 'worker failed' }] }));
  const result = await runScopeCommand(root, 'scope', ['sync', 'r1'], { now: 1700000000000 });
  assert.match(result.stdout, /blocked after every level failed: T-0005|blocked/);
  assert.equal((await readLedger(root)).tickets[0].status, 'blocked');
  const events = (await fs.readFile(logPath(root), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.some(entry => entry.event === 'replan'), false);
});

test('scope sync leaves dependency-only blocks untouched', async () => {
  const root = await project([
    baseTicket('T-0006', { blockReason: 'deps', dependsOn: ['T-0007'] }),
    baseTicket('T-0007', { status: 'todo', blockReason: undefined, attempts: 0 }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['sync', 'r1'], { now: 1700000000000 });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal((await readLedger(root)).tickets.find(ticket => ticket.id === 'T-0006').status, 'blocked');
  await assert.rejects(fs.access(logPath(root)));
});

test('scope sync does not auto-replan human-owned, review or sensitive tickets', async () => {
  const root = await project([
    baseTicket('T-0002', { type: 'human', steps: ['Owner handles it.'] }),
    baseTicket('T-0003', { status: 'review' }),
    baseTicket('T-0004', { sensitive: true }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['sync', 'r1'], { now: 1700000000000 });
  assert.equal(result.exitCode, 0, result.stdout);
  const saved = await readLedger(root);
  assert.deepEqual(saved.tickets.map(ticket => ticket.status), ['blocked', 'review', 'blocked']);
  await assert.rejects(fs.access(logPath(root)));
});
