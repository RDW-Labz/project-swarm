// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand, runTicketsCommand } from '../tools/scope-commands.mjs';
import { createLedger, readLedger, writeLedger, setViewPullRequest, resetViewPullRequest } from '../tools/tickets.mjs';
import { filesHash, writeReviewRecords } from '../tools/security-review.mjs';

const syncBase = {
  title: 'Declared file state',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['the declared file state is correct'],
  context: [],
  contracts: [],
  tests: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'review',
};

async function syncProject(t, ticket) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'train2-review-gaps-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await writeLedger(root, createLedger({ scope: { name: 'Sync', version: 1, hash: 'scope' }, tickets: [ticket] }));
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', integratedAt: '2026-10-21T12:00:00.000Z', jobs: [{ id: ticket.id, status: 'complete' }] }));
  return root;
}

const syncIntegrated = root => runScopeCommand(root, 'scope', ['sync', 'r1', '--integrated']);

async function passSecurityReview(root, ticket) {
  const hash = await filesHash(root, [...(ticket.files ?? []), ...(ticket.deletes ?? [])]);
  await writeReviewRecords(root, {
    tickets: {
      [ticket.id]: { verdict: 'pass', filesHash: hash, at: new Date().toISOString(), findings: [] },
    },
  });
}

const deliveredTicket = (id, status, extra = {}) => ({
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

async function deliveredRoot(tickets) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'train2-delivered-'));
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await writeLedger(root, createLedger({ scope: { name: 'test', version: 1, hash: 'abc' }, tickets }));
  await fs.writeFile(path.join(root, '.project-swarm.json'), '{}');
  return root;
}

test.after(() => {
  resetViewPullRequest();
});

test('delete-only auth delete waits for security review then completes', async t => {
  const ticket = { ...syncBase, id: 'T-0001', type: 'build', files: [], deletes: ['src/auth/session.ts'] };
  const root = await syncProject(t, ticket);
  const waiting = await syncIntegrated(root);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  assert.match(waiting.stdout, /Opus security review passes/);
  assert.doesNotMatch(waiting.stdout, /1 ticket\(s\) marked done/);
  await passSecurityReview(root, ticket);
  const done = await syncIntegrated(root);
  assert.match(done.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
});

test('delete-only non-sensitive file still syncs to done', async t => {
  const ticket = { ...syncBase, id: 'T-0001', type: 'build', files: [], deletes: ['src/old.mjs'] };
  const root = await syncProject(t, ticket);
  const done = await syncIntegrated(root);
  assert.match(done.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
});

test('delivered refuses auth-path ticket without security review', async t => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const ticket = deliveredTicket('T-0001', 'ready', { files: ['src/auth/session.ts'] });
  const root = await deliveredRoot([ticket]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const refused = await runTicketsCommand(root, ['T-0001', '--delivered', '1', '--yes']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /cannot deliver T-0001 without required reviews/);
  assert.match(refused.stdout, /Opus security review/);
  assert.equal((await readLedger(root)).tickets[0].status, 'ready');
  await passSecurityReview(root, ticket);
  const ok = await runTicketsCommand(root, ['T-0001', '--delivered', '1', '--yes']);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /T-0001 is now done/);
});

test('delivered on non-sensitive unflagged ticket still works', async t => {
  setViewPullRequest(async n => ({ state: 'MERGED', mergeCommit: `sha${n}`, url: null }));
  const root = await deliveredRoot([deliveredTicket('T-0001', 'blocked')]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const res = await runTicketsCommand(root, ['T-0001', '--delivered', '42', '--yes']);
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /T-0001 is now done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
});
