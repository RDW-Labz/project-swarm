// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { createLedger, writeLedger, readLedger, approveLedger, isApproved } from '../tools/tickets.mjs';
import {
  ticketsToManifest,
  parseCheckTimeoutMs,
  capCheckTimeoutMs,
  applyManifestCheckTimeouts,
  CHECK_TIMEOUT_MS_MAX,
} from '../tools/ticket-manifest.mjs';

const scope = parseScope('# P\n\n## Requirements\n- R-001: x\n');
const verify = { command: ['npm', 'run', 'test', '{tests}'], timeoutSec: 900 };
const contextEnv = { exists: () => true, sizes: {}, listFiles: () => [], profileContext: {} };

const tk = (id, extra = {}) => ({
  id,
  title: id,
  type: 'test',
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: [],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'ready',
  stage: 'S1',
  tests: ['tests/unit/a.test.ts'],
  ...extra,
});

async function project(t, tickets, approved = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chk-timeout-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets });
  await writeLedger(root, approved ? { ...ledger, approved: approveLedger(ledger).approved } : ledger);
  return root;
}

const run = (root, args) => runScopeCommand(root, 'tickets', args);

test('parseCheckTimeoutMs validates range and integer form', () => {
  assert.equal(parseCheckTimeoutMs('1200000').ok, true);
  assert.equal(parseCheckTimeoutMs('1200000').value, 1200000);
  assert.equal(parseCheckTimeoutMs(900000).ok, true);
  assert.equal(parseCheckTimeoutMs('59999').ok, false);
  assert.match(parseCheckTimeoutMs('59999').error, /at least/);
  assert.equal(parseCheckTimeoutMs(String(CHECK_TIMEOUT_MS_MAX + 1)).ok, false);
  assert.match(parseCheckTimeoutMs(String(CHECK_TIMEOUT_MS_MAX + 1)).error, /at most/);
  assert.equal(parseCheckTimeoutMs('not-a-number').ok, false);
  assert.match(parseCheckTimeoutMs('not-a-number').error, /integer/);
});

test('capCheckTimeoutMs enforces the manifest maximum', () => {
  assert.equal(capCheckTimeoutMs(2_000_000), CHECK_TIMEOUT_MS_MAX);
  assert.equal(capCheckTimeoutMs(1_200_000), 1_200_000);
});

test('tickets --check-timeout previews, saves, logs, and shows in --json', async t => {
  const root = await project(t, [tk('T-0001')]);
  const dry = await run(root, ['T-0001', '--check-timeout', '1200000']);
  assert.match(dry.stdout, /checkTimeoutMs: default {2}-> {2}1200000/);
  assert.equal((await readLedger(root)).tickets[0].checkTimeoutMs, undefined);
  assert.equal((await run(root, ['T-0001', '--check-timeout', '1200000', '--yes'])).exitCode ?? 0, 0);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets[0].checkTimeoutMs, 1200000);
  assert.equal(isApproved(ledger), true);
  const log = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  assert.match(log, /"fields":\["checkTimeoutMs"\]/);
  const json = await run(root, ['T-0001', '--json']);
  assert.match(json.stdout, /"checkTimeoutMs": 1200000/);
  assert.match((await run(root, ['T-0001', '--check-timeout', 'nope'])).stdout, /integer/);
  assert.match((await run(root, ['T-0001', '--check-timeout', '1000'])).stdout, /at least/);
});

test('manifest: ticket checkTimeoutMs sets the tests check; profile verify.timeoutMs is the fallback', () => {
  const ticketOnly = tk('T-0001', { checkTimeoutMs: 1_500_000 });
  const { manifest: m1 } = ticketsToManifest([ticketOnly], { scope, verify, ledger: { tickets: [] }, contextEnv });
  assert.equal(m1.checks.find(c => c.name === 'tests').timeoutMs, 1_500_000);
  const ticketDefault = tk('T-0002');
  const verifyProfile = { ...verify, timeoutMs: 1_100_000 };
  const { manifest: m2 } = ticketsToManifest([ticketDefault], { scope, verify: verifyProfile, ledger: { tickets: [] }, contextEnv });
  assert.equal(m2.checks.find(c => c.name === 'tests').timeoutMs, 1_100_000);
  const { manifest: m3 } = ticketsToManifest([ticketDefault], { scope, verify, ledger: { tickets: [] }, contextEnv });
  assert.equal(m3.checks.find(c => c.name === 'tests').timeoutMs, 900_000);
  assert.equal(m3.checks.find(c => c.name === 'typecheck'), undefined);
});

test('manifest: longer timeout applies only to the e2e or playwright check when unit tests exist too', () => {
  const ticket = tk('T-0001', {
    checkTimeoutMs: 1_400_000,
    tests: ['tests/unit/a.test.ts', 'e2e/smoke.spec.ts'],
  });
  const { manifest } = ticketsToManifest([ticket], { scope, verify, ledger: { tickets: [] }, contextEnv });
  assert.equal(manifest.checks.find(c => c.name === 'tests').timeoutMs, 900_000);
  manifest.checks.push({ name: 'e2e', argv: ['npm', 'run', 'e2e'] });
  applyManifestCheckTimeouts(manifest, [ticket], verify);
  assert.equal(manifest.checks.find(c => c.name === 'e2e').timeoutMs, 1_400_000);
  assert.equal(manifest.checks.find(c => c.name === 'tests').timeoutMs, 900_000);
});
