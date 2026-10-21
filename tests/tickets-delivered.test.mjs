// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runTicketsCommand } from '../tools/scope-commands.mjs';
import { createLedger, writeLedger, readLedger, logPath, ledgerStats, setViewPullRequest, resetViewPullRequest } from '../tools/tickets.mjs';

const baseTicket = (id, status, extra = {}) => ({
  id,
  title: `ticket ${id}`,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['it works'],
  files: [`src/${id}.ts`],
  size: 'S',
  risk: 'low',
  status,
  ...extra,
});

async function setupRoot(tickets, extraLedger = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-delivered-'));
  const ledger = createLedger({ scope: { name: 'test', version: 1, hash: 'abc' }, tickets });
  Object.assign(ledger, extraLedger);
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await writeLedger(root, ledger);
  await fs.writeFile(path.join(root, '.project-swarm.json'), '{}');
  return root;
}

async function readLog(root) {
  try {
    const text = await fs.readFile(logPath(root), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

afterEach(() => {
  resetViewPullRequest();
});

test('merged PR marks ticket done with delivered event', async () => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: `https://example/pr/${n}` }));
  const root = await setupRoot([baseTicket('T-0001', 'blocked')]);
  const res = await runTicketsCommand(root, ['T-0001', '--delivered', '42', '--yes']);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /T-0001 is now done/);
  assert.match(res.stdout, /delivered by PR #42 \(sha42\)/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'done');
  const events = await readLog(root);
  const delivered = events.find(e => e.event === 'delivered');
  assert.ok(delivered);
  assert.equal(delivered.id, 'T-0001');
  assert.equal(delivered.from, 'blocked');
  assert.equal(delivered.by, 'owner');
  assert.deepEqual(delivered.prs, [42]);
  assert.deepEqual(delivered.mergeCommits, ['sha42']);
  assert.equal(delivered.note, 'delivered by PR #42 (sha42)');
});

test('open PR is refused', async () => {
  setViewPullRequest(async () => ({ state: 'OPEN', mergeCommit: null, url: null }));
  const root = await setupRoot([baseTicket('T-0001', 'todo')]);
  const res = await runTicketsCommand(root, ['T-0001', '--delivered', '7', '--yes']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /PR #7 is OPEN, not merged/);
  assert.equal((await readLedger(root)).tickets[0].status, 'todo');
});

test('sensitive ticket without security review is refused', async () => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const root = await setupRoot([baseTicket('T-0001', 'ready', { sensitive: true, lane: 'claude' })]);
  const res = await runTicketsCommand(root, ['T-0001', '--delivered', '1', '--yes']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /cannot deliver T-0001 without required reviews/);
  assert.match(res.stdout, /Opus security review/);
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
});

test('cancelled and done tickets are refused', async () => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const root = await setupRoot([
    baseTicket('T-0001', 'cancelled'),
    baseTicket('T-0002', 'done'),
  ]);
  const cancelled = await runTicketsCommand(root, ['T-0001', '--delivered', '1', '--yes']);
  assert.equal(cancelled.exitCode, 1);
  assert.match(cancelled.stdout, /T-0001 is cancelled/);
  const done = await runTicketsCommand(root, ['T-0002', '--delivered', '1', '--yes']);
  assert.equal(done.exitCode, 1);
  assert.match(done.stdout, /T-0002 is done/);
});

test('dry-run changes nothing', async () => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const root = await setupRoot([baseTicket('T-0001', 'running')]);
  const before = JSON.stringify(await readLedger(root));
  const res = await runTicketsCommand(root, ['T-0001', '--delivered', '3', '--dry-run']);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /dry-run: nothing changed/);
  assert.equal(JSON.stringify(await readLedger(root)), before);
  assert.equal((await readLog(root)).length, 0);
});

test('multiple tickets are all-or-nothing', async () => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const root = await setupRoot([
    baseTicket('T-0001', 'todo'),
    baseTicket('T-0002', 'done'),
  ]);
  const res = await runTicketsCommand(root, ['T-0001', 'T-0002', '--delivered', '9', '--yes']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /T-0002 is done/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'todo');
  assert.equal(ledger.tickets[1].status, 'done');
  const ok = await runTicketsCommand(root, ['T-0001', 'T-0003', '--delivered', '9', '--yes']);
  assert.equal(ok.exitCode, 1);
  assert.match(ok.stdout, /no ticket T-0003/);
  assert.equal((await readLedger(root)).tickets[0].status, 'todo');
});

test('requirement coverage counts delivered ticket as done', async () => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const root = await setupRoot([baseTicket('T-0001', 'blocked')], { requirements: ['R-001'] });
  assert.equal(ledgerStats(await readLedger(root)).coveragePct, 0);
  const res = await runTicketsCommand(root, ['T-0001', '--delivered', '55', '--yes']);
  assert.equal(res.exitCode, 0);
  assert.equal(ledgerStats(await readLedger(root)).coveragePct, 100);
});
