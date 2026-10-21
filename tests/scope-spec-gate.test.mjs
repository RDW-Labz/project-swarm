// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand, argvForTicketSpec, ticketSpecPaths } from '../tools/scope-commands.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';

const SCOPE_HASH = { name: 'P', version: 1, hash: 'a'.repeat(64) };
const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-spec-gate-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const put = async (root, file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };

const tk = (id, extra = {}) => ({
  id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['AC1: ok'], files: [`src/${id}.ts`],
  context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', runId: 'r9', ...extra,
});

async function profiled(root, tickets, profileExtra = {}) {
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets }));
  await put(root, '.project-swarm.json', JSON.stringify({
    version: 1,
    profile: {
      sensitive: true,
      acceptance: { enforce: true },
      protectedPaths: [],
      budget: { maxUsd: 5 },
      baseCheck: { status: 'none', ranAt: null, head: null, checks: [] },
      verify: { command: ['npm', 'test', '--', '{tests}'], agent: 'claude', model: 'sonnet-shell', timeoutSec: 120 },
      ...profileExtra,
    },
  }));
}

const queuePassed = (ids = ['T-0001']) => ({
  state: 'done',
  integrated: ids,
  integratedIn: Object.fromEntries(ids.map(id => [id, 1])),
  checkFailed: [],
  batches: [{ id: 1, jobs: ids, checks: 'passed', checkResults: [{ name: 'tests', status: 'passed', mode: 'full' }] }],
});

async function writeRun(root, tickets, mq) {
  for (const t of tickets) await put(root, t.files[0], 'export const x = 1;\n');
  await put(root, '.swarm/runs/r9/state.json', JSON.stringify({
    id: 'r9',
    integratedAt: new Date().toISOString(),
    integratedFiles: tickets.flatMap(t => t.files),
    jobs: tickets.map(t => ({ id: t.id, status: 'complete', outputs: t.files })),
    mergeQueue: mq,
  }));
}

test('a failing owned spec retries even when the generic suite passed; no security review and not done', async t => {
  const root = await tmp(t);
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
  const ticket = tk('T-0001', { files: ['src/T-0001.ts', 'e2e/login.spec.ts'], tests: ['e2e/login.spec.ts'] });
  await profiled(root, [ticket]);
  await put(root, 'e2e/login.spec.ts', 'test("x", () => {});\n');
  await writeRun(root, [ticket], queuePassed());
  await put(root, '.swarm/security-reviews/records.json', JSON.stringify({ tickets: { 'T-0001': { verdict: 'pass', filesHash: 'old', at: new Date().toISOString(), findings: [] } } }));

  const calls = [];
  const res = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async (r, file) => { calls.push(file); return { ok: false, failed: true, tail: 'expected ok got fail' }; },
  });
  assert.deepEqual(calls, ['e2e/login.spec.ts']);
  assert.match(res.stdout, /back to ready/);
  assert.doesNotMatch(res.stdout, /stay in review until an Opus security review/);
  assert.doesNotMatch(res.stdout, /1 ticket\(s\) marked done/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
  assert.match(ledger.tickets[0].retryNote, /ticket spec e2e\/login\.spec\.ts/);
});

test('a passing spec runs before security review is requested', async t => {
  const root = await tmp(t);
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  const ticket = tk('T-0001', { files: ['src/app/api/T-0001/route.ts', 'tests/T-0001.test.ts'], tests: ['tests/T-0001.test.ts'] });
  await profiled(root, [ticket]);
  await put(root, 'tests/T-0001.test.ts', 'test("AC1: ok", () => {});\n');
  await writeRun(root, [ticket], queuePassed());

  const order = [];
  const res = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async (r, file) => { order.push(`spec:${file}`); return { ok: true }; },
  });
  assert.deepEqual(order, ['spec:tests/T-0001.test.ts']);
  assert.match(res.stdout, /stay in review until an Opus security review passes/);
  assert.doesNotMatch(res.stdout, /1 ticket\(s\) marked done/);
});

test('a ticket with no spec files does not invoke the runner and can reach done when checks pass', async t => {
  const root = await tmp(t);
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  const ticket = tk('T-0001', { files: ['docs/readme.md'], type: 'docs', acceptance: [], tests: [] });
  await profiled(root, [ticket], { verify: undefined });
  await writeRun(root, [ticket], queuePassed());

  let called = false;
  const res = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async () => { called = true; return { ok: true }; },
  });
  assert.equal(called, false);
  assert.match(res.stdout, /1 ticket\(s\) marked done/);
});

test('timeout and zero-test spec outcomes fail the gate', async t => {
  const root = await tmp(t);
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  const ticket = tk('T-0001', { files: ['src/T-0001.ts', 'tests/a.test.ts'], tests: ['tests/a.test.ts'] });
  await profiled(root, [ticket]);
  await put(root, 'tests/a.test.ts', 'test("x", () => {});\n');
  await writeRun(root, [ticket], queuePassed());

  const timeout = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async () => ({ ok: false, failed: true, tail: 'timed out after 120000 ms' }),
  });
  assert.match(timeout.stdout, /back to ready/);

  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { files: ['src/T-0001.ts', 'tests/a.test.ts'], tests: ['tests/a.test.ts'], status: 'review', runId: 'r9' })] }));
  const zero = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async () => ({ ok: false, failed: true, tail: 'no-tests: the check passed but ran 0 tests' }),
  });
  assert.match(zero.stdout, /back to ready/);
});

test('a spec owned by a later ticket is excluded from sync runs', async t => {
  const root = await tmp(t);
  const later = tk('T-0002', { type: 'test', files: ['tests/owned.spec.ts'], tests: ['tests/owned.spec.ts'], dependsOn: ['T-0001'], status: 'todo' });
  const earlier = tk('T-0001', { tests: ['tests/owned.spec.ts'], dependsOn: [] });
  const ledger = createLedger({ scope: SCOPE_HASH, tickets: [earlier, later] });
  const laterIds = new Set(['T-0002']);
  assert.deepEqual(ticketSpecPaths(earlier, ledger, laterIds), []);

  await profiled(root, [earlier, later]);
  await put(root, 'tests/owned.spec.ts', 'test("x", () => {});\n');
  await writeRun(root, [earlier], queuePassed(['T-0001']));

  const ran = [];
  await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async (r, file) => { ran.push(file); return { ok: true }; },
  });
  assert.deepEqual(ran, []);
});

test('deletions exclude a named spec from the gate', async t => {
  const root = await tmp(t);
  const ticket = tk('T-0001', { tests: ['tests/remove.spec.ts'], deletes: ['tests/remove.spec.ts'] });
  const ledger = createLedger({ scope: SCOPE_HASH, tickets: [ticket] });
  assert.deepEqual(ticketSpecPaths(ticket, ledger, new Set()), []);
});

test('argvForTicketSpec uses verify for unit tests and checks for e2e', () => {
  const verify = { command: ['npm', 'test', '--', '{tests}'] };
  assert.deepEqual(argvForTicketSpec('tests/a.test.ts', { profile: { verify }, checks: [] }), ['npm', 'test', '--', './tests/a.test.ts']);
  const checks = [{ name: 'e2e', argv: ['npx', 'playwright', 'test'] }];
  assert.deepEqual(argvForTicketSpec('e2e/login.spec.ts', { profile: { verify }, checks }), ['npx', 'playwright', 'test', './e2e/login.spec.ts']);
});
