// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../tools/tickets.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-test-'));
const scope = { name: 'Demo', version: 1, hash: 'abc' };
const ticket = (id, over = {}) => ({ id, title: `Ticket ${id}`, type: 'build', stage: 'S1', epic: 'E-01 Requests', scopeRefs: ['R-001'], acceptance: ['it works'], files: ['src/a.mjs'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', ...over });
const setup = (root, tickets) => T.writeLedger(root, T.createLedger({ scope, tickets }));

test('a well-formed build ticket validates', () => {
  assert.deepEqual(T.validateTicket(ticket('T-0001')), { ok: true, errors: [] });
});

test('an L ticket is refused with a hint to split it', () => {
  const r = T.validateTicket(ticket('T-0001', { size: 'L' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /split/.test(e)));
});

test('absolute and parent-relative file paths are refused', () => {
  assert.equal(T.validateTicket(ticket('T-0001', { files: ['/etc/passwd'] })).ok, false);
  assert.equal(T.validateTicket(ticket('T-0001', { files: ['src/../../x.mjs'] })).ok, false);
});

test('badPath refuses empty, doubled, dot, reserved and secret paths', () => {
  const bad = ['', 'src//a.mjs', 'src/./a.mjs', '.git/config', '.swarm/project/tickets.json', '.github-hooks-free/x.mjs', '.env', 'config/.ENV', '.project-swarm.json', 'deep/.Project-Swarm.JSON'];
  for (const p of bad) assert.equal(T.validateTicket(ticket('T-0001', { files: [p] })).ok, false, p);
});

test('ordinary paths still validate under badPath', () => {
  for (const p of ['src/env.mjs', 'docs/.github/x.md', 'src/a.mjs']) assert.equal(T.validateTicket(ticket('T-0001', { files: [p] })).ok, true, p);
});

test('a human ticket needs steps', () => {
  assert.equal(T.validateTicket(ticket('T-0001', { type: 'human', scopeRefs: [] })).ok, false);
  const ok = T.validateTicket(ticket('T-0002', { type: 'human', scopeRefs: [], acceptance: [], steps: ['Create the account'] }));
  assert.equal(ok.ok, true);
});

test('createLedger refuses an invalid ticket with code ticket-invalid', () => {
  assert.throws(() => T.createLedger({ scope, tickets: [ticket('T-0001', { size: 'L' })] }), { code: 'ticket-invalid' });
});

test('createLedger builds a version 1 ledger with no approval', () => {
  const l = T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 });
  assert.equal(l.version, 1);
  assert.equal(l.approved, null);
  assert.deepEqual(l.changeOrders, []);
});

test('ledger round trips with mode 600 and no temp files left behind', async () => {
  const root = tmpRoot();
  const ledger = T.createLedger({ scope, tickets: [ticket('T-0001')] });
  await T.writeLedger(root, ledger);
  assert.deepEqual(await T.readLedger(root), ledger);
  const file = T.ledgerPath(root);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tickets.json']);
});

test('readLedger returns null when no ledger exists', async () => {
  assert.equal(await T.readLedger(tmpRoot()), null);
});

test('appendLog writes one JSON line per event with a timestamp', async () => {
  const root = tmpRoot();
  await T.appendLog(root, { event: 'a', id: 'T-0001' });
  await T.appendLog(root, { event: 'b' });
  const lines = fs.readFileSync(T.logPath(root), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'a');
  assert.ok(lines[0].at);
});

test('transition moves todo to ready and logs the move', async () => {
  const root = tmpRoot();
  await setup(root, [ticket('T-0001')]);
  const t = await T.transition(root, 'T-0001', 'ready', { by: 'owner' });
  assert.equal(t.status, 'ready');
  assert.equal((await T.readLedger(root)).tickets[0].status, 'ready');
  const last = fs.readFileSync(T.logPath(root), 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
  assert.equal(last.id, 'T-0001');
  assert.equal(last.to, 'ready');
});

test('an illegal move is refused and done cannot change', async () => {
  const root = tmpRoot();
  await setup(root, [ticket('T-0001', { status: 'done' })]);
  await assert.rejects(T.transition(root, 'T-0001', 'ready'), { code: 'ticket-transition' });
});

test('ready is refused until every dependency is done', async () => {
  const root = tmpRoot();
  await setup(root, [ticket('T-0001'), ticket('T-0002', { dependsOn: ['T-0001'] })]);
  await assert.rejects(T.transition(root, 'T-0002', 'ready'), { code: 'ticket-deps' });
});

test('readyTickets returns todo or ready tickets with done dependencies, sorted', () => {
  const tickets = [
    ticket('T-0005'),
    ticket('T-0003', { dependsOn: ['T-0001'] }),
    ticket('T-0002', { status: 'done' }),
    ticket('T-0001', { status: 'done' }),
    ticket('T-0004', { status: 'running' }),
  ];
  assert.deepEqual(T.readyTickets(tickets).map(t => t.id), ['T-0003', 'T-0005']);
});

test('wavesOf layers by dependency and skips cancelled tickets', () => {
  const tickets = [
    ticket('T-0001'),
    ticket('T-0002', { dependsOn: ['T-0001'] }),
    ticket('T-0003', { dependsOn: ['T-0002'] }),
    ticket('T-0004'),
    ticket('T-0005', { status: 'cancelled' }),
  ];
  assert.deepEqual(T.wavesOf(tickets), [['T-0001', 'T-0004'], ['T-0002'], ['T-0003']]);
});

test('wavesOf throws ticket-cycle on a dependency cycle', () => {
  const tickets = [ticket('T-0001', { dependsOn: ['T-0002'] }), ticket('T-0002', { dependsOn: ['T-0001'] })];
  assert.throws(() => T.wavesOf(tickets), { code: 'ticket-cycle' });
});

test('filterTickets narrows by stage, requirement and file', () => {
  const tickets = [
    ticket('T-0001', { stage: 'S1' }),
    ticket('T-0002', { stage: 'S2', scopeRefs: ['R-002'], files: ['src/b.mjs'] }),
    ticket('T-0003', { stage: 'S2', scopeRefs: ['R-002'], status: 'done' }),
  ];
  assert.deepEqual(T.filterTickets(tickets, { stage: 'S2' }).map(t => t.id), ['T-0002', 'T-0003']);
  assert.deepEqual(T.filterTickets(tickets, { requirement: 'R-002', status: 'done' }).map(t => t.id), ['T-0003']);
  assert.deepEqual(T.filterTickets(tickets, { file: 'src/b.mjs' }).map(t => t.id), ['T-0002']);
});

test('ledgerStats reports percent done over live tickets and per-stage counts', () => {
  const ledger = { tickets: [ticket('T-0001', { status: 'done' }), ticket('T-0002', { status: 'done' }), ticket('T-0003'), ticket('T-0004', { status: 'cancelled' })] };
  const s = T.ledgerStats(ledger);
  assert.equal(s.total, 4);
  assert.equal(s.byStatus.done, 2);
  assert.deepEqual(s.byStage.S1, { total: 4, done: 2 });
  assert.equal(s.percentDone, 67);
  assert.equal(s.coveragePct, null);
});

test('renderBuildPlan shows percent done and the requirement table', () => {
  const ledger = T.createLedger({ scope, tickets: [ticket('T-0001', { status: 'done' }), ticket('T-0002')] });
  const plan = { name: 'Demo', version: 1, stages: [{ id: 'S1', title: 'Foundations' }], requirements: [{ id: 'R-001', text: 'A user signs in.' }] };
  const md = T.renderBuildPlan(ledger, plan);
  assert.ok(md.includes('50% done'));
  assert.ok(md.includes('| R | Text | Tickets | State |'));
  assert.ok(md.includes('| R-001 | A user signs in. | T-0001, T-0002 | partial |'));
});

test('approveLedger records approval without mutating the input', () => {
  const ledger = T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 });
  assert.equal(T.isApproved(ledger), false);
  const approved = T.approveLedger(ledger, { by: 'owner', now: 0 });
  assert.equal(T.isApproved(approved), true);
  assert.equal(approved.approved.scopeHash, 'abc');
  assert.equal(T.isApproved(ledger), false);
});

test('approval survives a status change', () => {
  const approved = T.approveLedger(T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 }), { by: 'owner', now: 0 });
  const moved = { ...approved, tickets: approved.tickets.map(t => ({ ...t, status: 'ready' })) };
  assert.equal(T.isApproved(moved), true);
});

test('a changed acceptance line makes approval lapse', () => {
  const approved = T.approveLedger(T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 }), { by: 'owner', now: 0 });
  const changed = { ...approved, tickets: approved.tickets.map(t => ({ ...t, acceptance: ['it works differently'] })) };
  assert.equal(T.isApproved(changed), false);
});

test('an added ticket makes approval lapse', () => {
  const approved = T.approveLedger(T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 }), { by: 'owner', now: 0 });
  const added = { ...approved, tickets: [...approved.tickets, ticket('T-0002')] };
  assert.equal(T.isApproved(added), false);
});

test('a changed scope hash makes approval lapse', () => {
  const approved = T.approveLedger(T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 }), { by: 'owner', now: 0 });
  const rescoped = { ...approved, scope: { ...approved.scope, hash: 'xyz' } };
  assert.equal(T.isApproved(rescoped), false);
});

test('an approval from an older version without ticketsHash is not approved', () => {
  const approved = T.approveLedger(T.createLedger({ scope, tickets: [ticket('T-0001')], now: 0 }), { by: 'owner', now: 0 });
  const old = { ...approved, approved: { at: approved.approved.at, by: 'owner', scopeHash: 'abc' } };
  assert.equal(T.isApproved(old), false);
});

test('ticketSetHash is stable across key order and ignores status', () => {
  const a = [ticket('T-0001'), ticket('T-0002')];
  const b = [...a].reverse().map(t => Object.fromEntries(Object.entries(t).reverse()));
  assert.equal(T.ticketSetHash(a), T.ticketSetHash(b));
  assert.equal(T.ticketSetHash([ticket('T-0001')]), T.ticketSetHash([ticket('T-0001', { status: 'done', notes: 'x' })]));
  assert.match(T.ticketSetHash(a), /^[0-9a-f]{64}$/);
});
