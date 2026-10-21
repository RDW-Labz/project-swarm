// SPDX-License-Identifier: Apache-2.0
// Ticket-owned specs run before review only when the project can run a single file (E4); otherwise sync skips that step.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';

const SCOPE_HASH = { name: 'P', version: 1, hash: 'a'.repeat(64) };
const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-spec-no-runner-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const put = async (root, file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };

const tk = (id, extra = {}) => ({
  id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['AC1: ok'], files: [`src/${id}.ts`],
  tests: [`tests/${id}.test.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false,
  status: 'review', runId: 'r9', ...extra,
});

const queuePassed = (ids = ['T-0001']) => ({
  state: 'done',
  integrated: ids,
  integratedIn: Object.fromEntries(ids.map(id => [id, 1])),
  checkFailed: [],
  batches: [{ id: 1, jobs: ids, checks: 'passed', checkResults: [{ name: 'tests', status: 'passed', mode: 'full' }] }],
});

async function writeRun(root, tickets, mq, testSource = 'test("smoke", () => {});\n') {
  for (const t of tickets) await put(root, t.files[0], 'export const x = 1;\n');
  await put(root, `tests/${tickets[0].id}.test.ts`, testSource);
  await put(root, '.swarm/runs/r9/state.json', JSON.stringify({
    id: 'r9',
    integratedAt: new Date().toISOString(),
    integratedFiles: tickets.flatMap(t => t.files),
    jobs: tickets.map(t => ({ id: t.id, status: 'complete', outputs: [...t.files, `tests/${t.id}.test.ts`] })),
    mergeQueue: mq,
  }));
}

test('without a per-file spec runner the ticket reaches acceptance; with a runner a failing spec is retried', async t => {
  const root = await tmp(t);
  const ticket = tk('T-0001', { acceptance: ['needs human review'] });
  await put(root, 'package.json', JSON.stringify({ name: 'app', scripts: {} }));
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: [ticket] }));
  await put(root, '.project-swarm.json', JSON.stringify({
    version: 1,
    profile: {
      sensitive: true,
      acceptance: { enforce: true },
      protectedPaths: [],
      budget: { maxUsd: 5 },
      baseCheck: { status: 'none', ranAt: null, head: null, checks: [] },
      verify: { command: ['npm', 'test'] },
    },
  }));
  await writeRun(root, [ticket], queuePassed());

  let called = false;
  const noRunner = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async () => { called = true; return { ok: false, failed: true, tail: 'should not run' }; },
  });
  assert.equal(called, false);
  assert.match(noRunner.stdout, /stay in review: acceptance lines no passing test covers[^\n]*T-0001 \(line 1\)/);
  assert.match(noRunner.stdout, /swarm scope acceptance-review/);
  assert.doesNotMatch(noRunner.stdout, /ticket spec/);
  assert.doesNotMatch(noRunner.stdout, /back to ready/);

  await put(root, '.project-swarm.json', JSON.stringify({
    version: 1,
    profile: {
      sensitive: true,
      acceptance: { enforce: true },
      protectedPaths: [],
      budget: { maxUsd: 5 },
      baseCheck: { status: 'none', ranAt: null, head: null, checks: [] },
      verify: { command: ['npm', 'test', '--', '{tests}'], agent: 'claude', model: 'sonnet-shell', timeoutSec: 120 },
    },
  }));
  await writeLedger(root, createLedger({ scope: SCOPE_HASH, tickets: [tk('T-0001', { status: 'review' })] }));
  await writeRun(root, [ticket], queuePassed());

  const withRunner = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'], {
    runTicketSpec: async () => ({ ok: false, failed: true, tail: 'spec failed' }),
  });
  assert.match(withRunner.stdout, /back to ready/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].status, 'ready');
  assert.match(ledger.tickets[0].retryNote, /ticket spec tests\/T-0001\.test\.ts/);
});
