// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { parseScope, scopeHash } from '../tools/scope.mjs';
import { createLedger, writeLedger, readLedger, isApproved } from '../tools/tickets.mjs';

const SCOPE_MD = [
  '# Scope: Gate list', 'Version: 1', '', '## Overview', 'Test.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 Works.', 'Acceptance:', '- ok.', '', '## Protected', '- .env', '',
].join('\n');
const SCOPE = {
  ...parseScope(SCOPE_MD),
  hash: scopeHash(SCOPE_MD),
  file: 'docs/scope/scope.md',
};

function tk(id, extra = {}) {
  return {
    id,
    title: `Ticket ${id}`,
    type: 'build',
    stage: 'S1',
    scopeRefs: ['R-001'],
    acceptance: ['ok'],
    files: [],
    size: 'S',
    risk: 'low',
    status: 'todo',
    ...extra,
  };
}

async function rootWithLedger(tickets) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-gate-list-')));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE_MD);
  await writeLedger(root, createLedger({ scope: SCOPE, tickets }));
  return root;
}

test('scope gate --list prints findings grouped with totals and --json returns the array', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['src/shared.mjs'] }),
    tk('T-0003', { files: ['src/aux.mjs'] }),
    tk('T-0002', { files: ['src/shared.mjs'], dependsOn: ['T-0003'] }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const listed = await runScopeCommand(root, 'scope', ['gate', '--list']);
  assert.equal(listed.exitCode, 0);
  assert.match(listed.stdout, /duplicate-file-owner/);
  assert.match(listed.stdout, /totals: needs_you 1/);
  const needsYouPos = listed.stdout.indexOf('duplicate-file-owner');
  const warnPos = listed.stdout.indexOf('ready-pool');
  if (warnPos >= 0) assert.ok(needsYouPos < warnPos || !listed.stdout.includes('warn'));
  const json = await runScopeCommand(root, 'scope', ['gate', '--list', '--json']);
  assert.equal(json.exitCode, 0);
  const findings = JSON.parse(json.stdout.trim());
  assert.ok(findings.some((f) => f.code === 'duplicate-file-owner' && f.severity === 'needs_you'));
});

test('scope approve prints finding lines after a manager gate warning', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['src/shared.mjs'], status: 'ready' }),
    tk('T-0003', { files: ['src/aux.mjs'], status: 'ready' }),
    tk('T-0002', { files: ['src/shared.mjs'], dependsOn: ['T-0003'], status: 'ready' }),
    tk('T-0004', { type: 'human', steps: ['do'], scopeRefs: [], status: 'todo' }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.swarm', 'project', 'scope.snapshot.md'), SCOPE_MD);
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes'], {
    runManagersScopeGate: async () => ({ run: { status: 'error', error: 'ticket-manager-scope-gate: ticket tree has blocking errors; 2 finding(s) need the owner' } }),
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /warning: manager scope gate failed/);
  assert.match(result.stdout, /finding: duplicate-file-owner T-0001/);
  assert.match(result.stdout, /swarm scope gate --list shows all/);
});

test('one ticket listing the same path in files and tests is not a duplicate owner', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['tests/a.test.mjs'], tests: ['tests/a.test.mjs'], type: 'test' }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const listed = await runScopeCommand(root, 'scope', ['gate', '--list', '--json']);
  const findings = JSON.parse(listed.stdout.trim());
  assert.equal(findings.filter((f) => f.code === 'duplicate-file-owner').length, 0);
});

test('claimers ordered by dependsOn are not reported as duplicate file owners', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['src/shared.mjs'] }),
    tk('T-0002', { files: ['src/shared.mjs'], dependsOn: ['T-0001'] }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const listed = await runScopeCommand(root, 'scope', ['gate', '--list', '--json']);
  const findings = JSON.parse(listed.stdout.trim());
  assert.equal(findings.filter((f) => f.code === 'duplicate-file-owner').length, 0);
});

test('scope gate --fix-owners previews and applies dependsOn chains', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['src/dup.mjs'] }),
    tk('T-0002', { files: ['src/dup.mjs'] }),
    tk('T-0003', { files: ['src/dup.mjs'] }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preview = await runScopeCommand(root, 'scope', ['gate', '--fix-owners']);
  assert.equal(preview.exitCode, 0);
  assert.match(preview.stdout, /T-0002: add dependsOn T-0001/);
  assert.match(preview.stdout, /Rerun with --yes/);
  const applied = await runScopeCommand(root, 'scope', ['gate', '--fix-owners', '--yes']);
  assert.equal(applied.exitCode, 0, applied.stdout);
  const ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets.find((t) => t.id === 'T-0002').dependsOn, ['T-0001']);
  assert.deepEqual(ledger.tickets.find((t) => t.id === 'T-0003').dependsOn, ['T-0002']);
});

test('scope gate --fix-owners refuses an edge that would cycle', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['src/cycle.mjs'], dependsOn: ['T-0003'] }),
    tk('T-0002', { files: ['src/cycle.mjs'] }),
    tk('T-0003', { files: ['src/cycle.mjs', 'src/aux.mjs'] }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preview = await runScopeCommand(root, 'scope', ['gate', '--fix-owners']);
  assert.match(preview.stdout, /needs the owner/);
  const applied = await runScopeCommand(root, 'scope', ['gate', '--fix-owners', '--yes']);
  assert.equal(applied.exitCode, 1);
  assert.match(applied.stdout, /still needs the owner/);
  const ledger = await readLedger(root);
  assert.ok(ledger.tickets.find((t) => t.id === 'T-0002').dependsOn?.includes('T-0001'));
  assert.equal(ledger.tickets.find((t) => t.id === 'T-0003').dependsOn?.includes('T-0002'), undefined);
});

test('fix-owners re-seals an approved ledger', async t => {
  const root = await rootWithLedger([
    tk('T-0001', { files: ['src/seal.mjs'] }),
    tk('T-0002', { files: ['src/seal.mjs'] }),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let ledger = await readLedger(root);
  const { approveLedger } = await import('../tools/tickets.mjs');
  ledger = approveLedger(ledger, { by: 'owner' });
  await writeLedger(root, ledger);
  assert.ok(isApproved(await readLedger(root)));
  assert.equal((await runScopeCommand(root, 'scope', ['gate', '--fix-owners', '--yes'])).exitCode, 0);
  assert.ok(isApproved(await readLedger(root)));
});
