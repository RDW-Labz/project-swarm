// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTicketsCommand } from '../tools/scope-commands.mjs';
import { createLedger, writeLedger, readLedger, ledgerPath, logPath } from '../tools/tickets.mjs';
import { filesHash } from '../tools/security-review.mjs';

const scope = { name: 'P', version: 1, hash: 'a'.repeat(64) };
const base = {
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: ['works'],
  files: ['src/a.ts'],
  context: [],
  contracts: [],
  dependsOn: [],
  tests: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  stage: 'S1',
  type: 'build',
  title: 'A ticket',
};

const put = async (root, file, text) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
};

async function project(t, tickets, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'set-guard-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeLedger(root, createLedger({ scope, tickets }));
  if (extra.writeFile) await put(root, extra.writeFile, extra.fileContent ?? 'export const a = 1;\n');
  if (extra.profile) await put(root, '.project-swarm.json', JSON.stringify({ version: 1, profile: extra.profile }));
  return root;
}

const ledgerText = async root => fs.readFile(ledgerPath(root), 'utf8');
const logText = async root => {
  try { return await fs.readFile(logPath(root), 'utf8'); } catch { return ''; }
};
const lockPath = root => path.join(root, '.swarm/project/scope-go.lock');
const planPath = root => path.join(root, 'docs/scope/build-plan.md');
const statusOf = async (root, id) => (await readLedger(root)).tickets.find(x => x.id === id)?.status;

test('bare --set refuses and writes nothing', async t => {
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review' }]);
  const beforeLedger = await ledgerText(root);
  const beforeLog = await logText(root);
  const res = await runTicketsCommand(root, ['T-0001', '--set', 'done']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /T-0001: review -> done/);
  assert.match(res.stdout, /--yes or --force/);
  assert.equal(await statusOf(root, 'T-0001'), 'review');
  assert.equal(await ledgerText(root), beforeLedger);
  assert.equal(await logText(root), beforeLog);
});

test('--force and --yes apply a legal transition with actor metadata in the log', async t => {
  const prev = process.env.SWARM_ACTOR;
  process.env.SWARM_ACTOR = 'test-owner';
  t.after(() => { if (prev === undefined) delete process.env.SWARM_ACTOR; else process.env.SWARM_ACTOR = prev; });
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review', files: ['src/plain.ts'] }], { writeFile: 'src/plain.ts' });
  const forced = await runTicketsCommand(root, ['T-0001', '--set', 'done', '--force']);
  assert.equal(forced.exitCode ?? 0, 0);
  assert.equal(await statusOf(root, 'T-0001'), 'done');
  const line = (await logText(root)).trim().split('\n').pop();
  const ev = JSON.parse(line);
  assert.equal(ev.event, 'transition');
  assert.equal(ev.source, 'tickets-set');
  assert.equal(ev.actor, 'test-owner');
  assert.equal(ev.confirmation, 'force');
  assert.equal(ev.by, 'owner');
  const root2 = await project(t, [{ ...base, id: 'T-0002', status: 'blocked' }]);
  const yes = await runTicketsCommand(root2, ['T-0002', '--set', 'cancelled', '--yes']);
  assert.equal(yes.exitCode ?? 0, 0);
  const ev2 = JSON.parse((await logText(root2)).trim().split('\n').pop());
  assert.equal(ev2.confirmation, 'yes');
});

test('--dry-run changes nothing with or without --force', async t => {
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review' }]);
  const beforeLedger = await ledgerText(root);
  const beforeLog = await logText(root);
  for (const args of [['T-0001', '--set', 'done', '--dry-run'], ['T-0001', '--set', 'done', '--dry-run', '--force']]) {
    const res = await runTicketsCommand(root, args);
    assert.match(res.stdout, /dry-run: nothing changed/);
    assert.equal(await statusOf(root, 'T-0001'), 'review');
    assert.equal(await ledgerText(root), beforeLedger);
    assert.equal(await logText(root), beforeLog);
    await assert.rejects(fs.stat(lockPath(root)));
    await assert.rejects(fs.stat(planPath(root)));
  }
});

test('illegal transition, bad id or status, and unapproved proposal refuse even with --force', async t => {
  const root = await project(t, [
    { ...base, id: 'T-0001', status: 'done' },
    { ...base, id: 'T-0002', status: 'review' },
  ]);
  const ledger = await readLedger(root);
  ledger.tickets.push({ ...base, id: 'T-0003', origin: 'comment', status: 'todo', title: 'from comment' });
  await writeLedger(root, ledger);
  const before = await ledgerText(root);
  assert.equal((await runTicketsCommand(root, ['T-0001', '--set', 'ready', '--force'])).exitCode, 1);
  assert.equal((await runTicketsCommand(root, ['T-9999', '--set', 'done', '--force'])).exitCode, 1);
  assert.equal((await runTicketsCommand(root, ['T-0002', '--set', 'not-a-status', '--force'])).exitCode, 1);
  assert.match((await runTicketsCommand(root, ['T-0003', '--set', 'ready', '--force'])).stdout, /approves it/);
  assert.equal(await ledgerText(root), before);
});

test('sensitive ticket without security review cannot be set to done even with --force', async t => {
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review', sensitive: true, files: ['src/auth.ts'] }], { writeFile: 'src/auth.ts' });
  const beforeLedger = await ledgerText(root);
  const beforeLog = await logText(root);
  const res = await runTicketsCommand(root, ['T-0001', '--set', 'done', '--force']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /security review/i);
  assert.equal(await statusOf(root, 'T-0001'), 'review');
  assert.equal(await ledgerText(root), beforeLedger);
  assert.equal(await logText(root), beforeLog);
});

test('sensitive ticket with a passing security review can be set to done', async t => {
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review', sensitive: true, files: ['src/auth.ts'] }], { writeFile: 'src/auth.ts' });
  const hash = await filesHash(root, ['src/auth.ts']);
  await put(root, '.swarm/security-reviews/records.json', `${JSON.stringify({ tickets: { 'T-0001': { verdict: 'pass', filesHash: hash, at: new Date().toISOString(), findings: [] } } })}\n`);
  const res = await runTicketsCommand(root, ['T-0001', '--set', 'done', '--yes']);
  assert.equal(res.exitCode ?? 0, 0);
  assert.equal(await statusOf(root, 'T-0001'), 'done');
});

test('acceptance review is required before done when the profile enforces acceptance', async t => {
  const profile = {
    sensitive: true,
    protectedPaths: [],
    budget: { maxUsd: 5 },
    baseCheck: { status: 'none', ranAt: null, head: null, checks: [] },
    acceptance: { enforce: true },
  };
  const root = await project(t, [{
    ...base,
    id: 'T-0001',
    status: 'review',
    acceptance: ['visual matches the mockup'],
    files: ['src/ui.ts'],
    tests: [],
  }], { writeFile: 'src/ui.ts', profile });
  const before = await ledgerText(root);
  const res = await runTicketsCommand(root, ['T-0001', '--set', 'done', '--force']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /acceptance review/i);
  assert.equal(await ledgerText(root), before);
});

test('non-sensitive ticket without review requirements can be set to done', async t => {
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review', files: ['src/plain.ts'], sensitive: false }], { writeFile: 'src/plain.ts' });
  const res = await runTicketsCommand(root, ['T-0001', '--set', 'done', '--force']);
  assert.equal(res.exitCode ?? 0, 0);
  assert.equal(await statusOf(root, 'T-0001'), 'done');
});

test('dry-run shows review refusal without writing', async t => {
  const root = await project(t, [{ ...base, id: 'T-0001', status: 'review', sensitive: true }]);
  const beforeLedger = await ledgerText(root);
  const res = await runTicketsCommand(root, ['T-0001', '--set', 'done', '--dry-run']);
  assert.equal(res.exitCode, 1);
  assert.match(res.stdout, /dry-run: nothing changed/);
  assert.equal(await ledgerText(root), beforeLedger);
});
