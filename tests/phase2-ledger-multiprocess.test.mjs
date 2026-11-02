import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { addGoal, readBacklog, removeGoal } from '../tools/backlog.mjs';
import { createLedger, readLedger, writeLedger, ledgerPath } from '../tools/tickets.mjs';
import { readLeases, leasesPath } from '../tools/ledger-lease.mjs';

const NOW = Date.parse('2025-01-02T03:04:05Z');
const AT = new Date(NOW).toISOString();
const fixture = fileURLToPath(new URL('./fixtures/phase2/ledger-writer.mjs', import.meta.url));
const settings = { timeout: 9000 };
const bug = summary => ({ ...settings, todo: `Phase 2: ${summary}` });
const project = root => path.join(root, '.swarm', 'project');
const ticket = id => ({ id, title: id, type: 'human', scopeRefs: [], size: 'S', risk: 'low', status: 'ready', steps: ['work'] });
async function tmp(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'phase2-ledger-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function seed(root) {
  const ledger = createLedger({ tickets: [ticket('T-9001'), ticket('T-9002')], now: NOW });
  await writeLedger(root, ledger);
  return ledger;
}
function child(t, root, options) {
  const proc = spawn(process.execPath, [fixture, root, JSON.stringify({ now: NOW, ...options })], {
    env: { ...process.env, NODE_ENV: 'test', PROJECT_SWARM_NO_LEDGER_BACKUP: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const queue = [];
  let waiting;
  let ended = false;
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const output = readline.createInterface({ input: proc.stdout });
  output.on('line', line => {
    const message = JSON.parse(line);
    if (waiting) { const { resolve } = waiting; waiting = null; resolve(message); }
    else queue.push(message);
  });
  const closed = new Promise(resolve => proc.once('close', (code, signal) => {
    ended = true;
    if (waiting) { waiting.reject(new Error(`child exited ${code}/${signal}: ${stderr}`)); waiting = null; }
    resolve({ code, signal });
  }));
  proc.on('error', error => { if (waiting) { waiting.reject(error); waiting = null; } });
  t.after(async () => {
    if (!ended) proc.kill('SIGKILL');
    await closed;
    output.close();
  });
  return {
    proc, closed,
    send: () => proc.stdin.write('{}\n'),
    async event(expected) {
      if (ended && !queue.length) throw new Error(`child exited: ${stderr}`);
      const value = queue.length ? queue.shift() : await new Promise((resolve, reject) => { waiting = { resolve, reject }; });
      assert.equal(value.event, expected, JSON.stringify(value));
      return value;
    },
  };
}
async function start(c) { await c.event('ready'); c.send(); }
async function finish(c) {
  const result = await c.event('result');
  assert.deepEqual(await c.closed, { code: 0, signal: null });
  return result;
}
async function run(t, root, options) { const c = child(t, root, options); await start(c); return finish(c); }
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.result; }
async function overlapping(t, root, a, b, file) {
  const first = child(t, root, { ...a, pauseRead: file });
  const second = child(t, root, { ...b, pauseRead: file });
  await start(first); await first.event('paused');
  await start(second); await second.event('paused');
  first.send(); ok(await finish(first));
  second.send(); ok(await finish(second));
}

test('backlog bytes, private mode, paths and refusal messages are stable', settings, async t => {
  const root = await tmp(t);
  assert.deepEqual(await readBacklog(root), { items: [] });
  const item = await addGoal(root, { id: 'one', goal: ' work ', paths: ['./src//app/'], maxUsd: 2 }, { now: () => NOW });
  assert.deepEqual(item, { id: 'one', goal: 'work', paths: ['src/app'], maxUsd: 2, addedAt: AT, status: 'queued' });
  const file = path.join(project(root), 'backlog.json');
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify({ items: [item] }, null, 2) + '\n');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(addGoal(root, { id: 'one', goal: 'other' }), { message: 'backlog-duplicate-id: one' });
  await assert.rejects(removeGoal(root, 'missing'), { message: 'backlog-unknown: missing' });
  assert.deepEqual(await fs.readdir(project(root)), ['backlog.json']);
  await fs.chmod(file, 0o644);
  await addGoal(root, { id: 'two', goal: 'two' }, { now: () => NOW });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644, 'truncate preserves an existing backlog mode');
});

for (const [name, a, b, fixed] of [
  ['add/add', { operation: 'add', id: 'a' }, { operation: 'add', id: 'b' }, ['base', 'a', 'b']],
  ['remove/remove', { operation: 'remove', id: 'base' }, { operation: 'remove', id: 'other' }, []],
  ['remove/add', { operation: 'remove', id: 'base' }, { operation: 'add', id: 'new' }, ['new']],
]) {
  async function race(t) {
    const root = await tmp(t);
    await addGoal(root, { id: 'base', goal: 'base' }, { now: () => NOW });
    if (name === 'remove/remove') await addGoal(root, { id: 'other', goal: 'other' }, { now: () => NOW });
    await overlapping(t, root, a, b, 'backlog.json');
    return (await readBacklog(root)).items.map(item => item.id);
  }
  test(`backlog ${name} must preserve both successful effects`, bug(`backlog lost update: preserve both successful concurrent ${name} effects`), async t => {
    const survived = await race(t);
    assert.deepEqual(survived, fixed);
  });
}

test('ticket bytes and private mode; raw writer and transition ignore scope-go.lock', settings, async t => {
  const root = await tmp(t);
  const ledger = await seed(root);
  assert.equal(ledgerPath(root), path.join(project(root), 'tickets.json'));
  assert.equal(await fs.readFile(ledgerPath(root), 'utf8'), JSON.stringify({ version: 1, tickets: ledger.tickets, changeOrders: [], approved: null, createdAt: AT, updatedAt: AT }, null, 2) + '\n');
  assert.equal((await fs.stat(ledgerPath(root))).mode & 0o777, 0o600);
  await fs.chmod(ledgerPath(root), 0o644);
  // The scope lock name is supplied by the task; this tests the ticket-side boundary.
  const scopeLock = path.join(project(root), 'scope-go.lock');
  await fs.writeFile(scopeLock, 'held by test\n');
  for (const options of [
    { operation: 'write', id: 'T-9001', title: 'changed' },
    { operation: 'transition', id: 'T-9002', to: 'running' },
  ]) {
    const result = await run(t, root, options);
    ok(result);
    assert.deepEqual(result.trace.filter(entry => entry.path.endsWith('.lock')), []);
  }
  assert.equal(await fs.readFile(scopeLock, 'utf8'), 'held by test\n');
  assert.equal((await fs.stat(ledgerPath(root))).mode & 0o777, 0o600, 'atomic replacement restores private mode');
  const refused = await run(t, root, { operation: 'transition', id: 'T-9002', to: 'todo' });
  assert.equal(refused.code, 'ticket-transition');
  assert.equal(refused.message, 'T-9002: running -> todo is not allowed; legal next statuses: review, ready, blocked, cancelled, done');
});

for (const operation of ['write', 'transition']) {
  test(`two ticket ${operation} children must preserve different ticket edits`, bug('B7: tickets.json gets exactly one lock; concurrent writers preserve both ticket edits'), async t => {
    const root = await tmp(t);
    await seed(root);
    await overlapping(t, root,
      { operation, id: 'T-9001', title: 'first', to: 'running' },
      { operation, id: 'T-9002', title: 'second', to: 'running' }, 'tickets.json');
    const tickets = (await readLedger(root)).tickets;
    if (operation === 'write') assert.deepEqual(tickets.map(item => item.title), ['first', 'second']);
    else assert.deepEqual(tickets.map(item => item.status), ['running', 'running']);
  });
}

test('SIGKILL before ticket rename retains old bytes; next writer leaves the orphan temp alone', settings, async t => {
  const root = await tmp(t);
  await seed(root);
  const before = await fs.readFile(ledgerPath(root), 'utf8');
  const writer = child(t, root, { operation: 'write', id: 'T-9001', title: 'killed', pauseTicketRename: true });
  await start(writer);
  const paused = await writer.event('paused');
  assert.match(paused.temporary, /^\.swarm\/project\/\.tickets\.\d+\.[a-f0-9]{12}\.tmp$/);
  assert.equal((await fs.stat(path.join(root, paused.temporary))).mode & 0o777, 0o600);
  writer.proc.kill('SIGKILL');
  assert.deepEqual(await writer.closed, { code: null, signal: 'SIGKILL' });
  assert.equal(await fs.readFile(ledgerPath(root), 'utf8'), before);
  ok(await run(t, root, { operation: 'write', id: 'T-9002', title: 'next' }));
  assert.deepEqual((await readLedger(root)).tickets.map(item => item.title), ['T-9001', 'next']);
  assert.equal((await fs.stat(path.join(root, paused.temporary))).isFile(), true);
});

test('lease claim during a ledger wave has one winner and monotonic tokens across renew/release', settings, async t => {
  const root = await tmp(t);
  await seed(root);
  const holder = child(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-a', pauseAfterLeases: true });
  await start(holder);
  const paused = await holder.event('paused');
  assert.deepEqual(paused.trace.filter(entry => entry.path.endsWith('.lock')), [
    { operation: 'open', path: '.swarm/project/leases.lock' },
  ]);
  const lockBytes = await fs.readFile(path.join(project(root), 'leases.lock'), 'utf8');
  const lock = JSON.parse(lockBytes);
  assert.deepEqual(Object.keys(lock), ['pid', 'startedAt']);
  assert.equal(lock.pid, holder.proc.pid);
  assert.equal(new Date(lock.startedAt).toISOString(), lock.startedAt);
  assert.equal(lockBytes, JSON.stringify(lock) + '\n');
  assert.equal((await fs.stat(path.join(project(root), 'leases.lock'))).mode & 0o777, 0o600);
  const contender = await run(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-b' });
  assert.equal(contender.ok, false);
  assert.equal(contender.code, 'leases-running');
  assert.equal(contender.message, `leases-running: pid ${holder.proc.pid} already runs leases for this project`);
  ok(await run(t, root, { operation: 'write', id: 'T-9002', title: 'T-9002' }));
  holder.send();
  const first = ok(await finish(holder));
  assert.equal(first.fencingToken, 1);
  const refused = await run(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-b' });
  assert.equal(refused.code, 'lease-held');
  assert.equal(refused.message, 'T-9001 is leased until 2025-01-02T03:05:05.000Z');
  const renewed = ok(await run(t, root, { operation: 'renew', id: 'T-9001', token: 1, now: NOW + 1000 }));
  assert.equal(renewed.fencingToken, 1);
  assert.equal(renewed.expiresAt, '2025-01-02T03:05:06.000Z');
  const stale = await run(t, root, { operation: 'release', id: 'T-9001', token: 2 });
  assert.equal(stale.code, 'lease-stale-token');
  assert.equal(stale.message, 'stale fencing token for T-9001');
  ok(await run(t, root, { operation: 'release', id: 'T-9001', token: 1, now: NOW + 2000 }));
  const second = ok(await run(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-b', now: NOW + 3000 }));
  assert.equal(second.fencingToken, 2);
  const store = { version: 1, leases: { 'T-9001': second }, maxTokenByTicket: { 'T-9001': 2 } };
  assert.equal(leasesPath(root), path.join(project(root), 'leases.json'));
  assert.equal(await fs.readFile(leasesPath(root), 'utf8'), JSON.stringify(store, null, 2) + '\n');
  assert.equal((await fs.stat(leasesPath(root))).mode & 0o777, 0o600);
  assert.deepEqual(await readLeases(root), store);
  await fs.chmod(leasesPath(root), 0o644);
  ok(await run(t, root, { operation: 'renew', id: 'T-9001', token: 2, now: NOW + 4000 }));
  assert.equal((await fs.stat(leasesPath(root))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(project(root), 'leases.lock')), { code: 'ENOENT' });
});

test('claim must preserve a different ticket edit written during its wave', bug('B7: tickets.json gets exactly one lock; lease claims and ledger writers preserve both updates'), async t => {
  const root = await tmp(t);
  await seed(root);
  const holder = child(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-a', pauseAfterLeases: true });
  await start(holder); await holder.event('paused');
  ok(await run(t, root, { operation: 'write', id: 'T-9002', title: 'wave' }));
  holder.send(); ok(await finish(holder));
  assert.equal((await readLedger(root)).tickets[1].title, 'wave');
});

test('SIGKILL after lease persistence characterizes dead lock recovery and sweep', settings, async t => {
  const root = await tmp(t);
  await seed(root);
  const holder = child(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-a', pauseAfterLeases: true });
  await start(holder);
  await holder.event('paused');
  holder.proc.kill('SIGKILL');
  assert.deepEqual(await holder.closed, { code: null, signal: 'SIGKILL' });
  assert.equal((await readLeases(root)).leases['T-9001'].fencingToken, 1);
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
  const next = await run(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-b', now: NOW + 60001 });
  ok(next);
  assert.equal(next.result.fencingToken, 2);
  ok(await run(t, root, { operation: 'sweep', now: NOW + 120002 }));
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
  assert.deepEqual(await readLeases(root), { version: 1, leases: {}, maxTokenByTicket: { 'T-9001': 2 } });
});

test('renew and release contend on leases.lock while a third child writes tickets', settings, async t => {
  const root = await tmp(t);
  await seed(root);
  ok(await run(t, root, { operation: 'claim', id: 'T-9001', holder: 'node-a' }));
  const releasing = child(t, root, { operation: 'release', id: 'T-9001', token: 1, pauseRead: 'tickets.json' });
  await start(releasing);
  const paused = await releasing.event('paused');
  assert.deepEqual(paused.trace.filter(entry => entry.path.endsWith('.lock')), [
    { operation: 'open', path: '.swarm/project/leases.lock' },
  ]);
  const renewing = await run(t, root, { operation: 'renew', id: 'T-9001', token: 1 });
  assert.equal(renewing.code, 'leases-running');
  assert.equal(renewing.message, `leases-running: pid ${releasing.proc.pid} already runs leases for this project`);
  ok(await run(t, root, { operation: 'write', id: 'T-9002', title: 'T-9002' }));
  releasing.send();
  assert.deepEqual(ok(await finish(releasing)), { ticketId: 'T-9001', released: true });
  const after = await run(t, root, { operation: 'renew', id: 'T-9001', token: 1 });
  assert.equal(after.code, 'lease-expired');
  assert.equal(after.message, 'T-9001 has no active lease');
  assert.deepEqual(await readLeases(root), { version: 1, leases: {}, maxTokenByTicket: { 'T-9001': 1 } });
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
});
