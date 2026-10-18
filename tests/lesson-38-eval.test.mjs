// SPDX-License-Identifier: Apache-2.0
// Scenario evals for the parts-app S6 report: a failing check must keep tickets out of done; invented dependency keys; help never acts;
// a failure that is not the ticket's own; output that already matches the tree; a clean release of held tickets.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger, approveLedger, isApproved } from '../tools/tickets.mjs';
import { ticketOutcome, isOwnFailure } from '../tools/ticket-manifest.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');
const tmp = async (t, prefix) => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const tk = (id, extra = {}) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', stage: 'S1', ...extra });
const writeState = (root, state) => fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true }).then(() => fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state)));
async function project(t, tickets, { verify = false } = {}) {
  const root = await tmp(t, 'l38-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets }));
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, ...(verify ? { verify: { command: ['npm', 'test'] } } : {}), baseCheck: { status: 'none', ranAt: null, head: null, checks: [] } } }));
  return root;
}
const statuses = async root => Object.fromEntries((await readLedger(root)).tickets.map(t => [t.id, t.status]));

test('eval 39.1 (S6 top priority): a failing check keeps every ticket in the batch or run out of done', async t => {
  // Tickets with no tests of their own (an env check, a log lint) used to reach done while the run's check was failing.
  const root = await project(t, [tk('T-0001', { runId: 'r9' }), tk('T-0002', { runId: 'r9' })]);
  const jobs = ['T-0001', 'T-0002'].map(id => ({ id, status: 'complete', outputs: [`src/${id}.ts`] }));
  await writeState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/T-0001.ts', 'src/T-0002.ts'], jobs, checks: [{ name: 'tests', status: 'failed', tail: 'FAIL env check' }, { name: 'lint-log', status: 'passed' }] });
  const plain = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(plain.stdout, /0 ticket\(s\) marked done/);
  assert.match(plain.stdout, /the tests check failed on this run, so no ticket in it is done/);
  assert.deepEqual(await statuses(root), { 'T-0001': 'review', 'T-0002': 'review' });
  // A custom check that is not tests, typecheck or lint blocks too.
  await writeState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/T-0001.ts', 'src/T-0002.ts'], jobs, checks: [{ name: 'log-lint', status: 'failed', tail: 'console.log found' }] });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /the log-lint check failed on this run/);
  assert.deepEqual(await statuses(root), { 'T-0001': 'review', 'T-0002': 'review' });
  // A batch whose check failed keeps all of its tickets out; a batch of one job goes back to the worker with the failure.
  const batch = { id: 1, jobs: ['T-0001', 'T-0002'], checks: 'failed', security: 'skipped', checkResults: [{ name: 'env-check', status: 'failed', tail: 'MISSING_VAR' }] };
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs, mergeQueue: { integrated: ['T-0001', 'T-0002'], integratedIn: { 'T-0001': 1, 'T-0002': 1 }, checkFailed: [], batches: [batch] } });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /the env-check check failed on its batch/);
  assert.deepEqual(await statuses(root), { 'T-0001': 'review', 'T-0002': 'review' });
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs: jobs.slice(0, 1), mergeQueue: { integrated: ['T-0001'], integratedIn: { 'T-0001': 2 }, checkFailed: [], batches: [{ id: 2, jobs: ['T-0001'], checks: 'failed', security: 'skipped', checkResults: [{ name: 'env-check', status: 'failed', tail: 'MISSING_VAR' }] }] } });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /back to ready/);
  assert.match((await readLedger(root)).tickets[0].retryNote, /failed checks: env-check; MISSING_VAR/);
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', { runId: 'r9' }), tk('T-0002', { runId: 'r9' })] }));
  // A run-level check that failed after the batch passed still blocks, and so does a check that timed out or crashed.
  const passedBatch = { id: 3, jobs: ['T-0001', 'T-0002'], checks: 'passed', security: 'skipped', checkResults: [{ name: 'tests', status: 'passed' }] };
  await writeState(root, { id: 'r9', integratedAt: 'now', jobs, checks: [{ name: 'final-env', status: 'timeout', tail: '' }], mergeQueue: { integrated: ['T-0001', 'T-0002'], integratedIn: { 'T-0001': 3, 'T-0002': 3 }, checkFailed: [], batches: [passedBatch] } });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /the final-env check failed/);
  assert.deepEqual(await statuses(root), { 'T-0001': 'review', 'T-0002': 'review' });
  // The owner's way out when the check was already failing on the base: named, confirmed with --yes, logged.
  const refused = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-failed-check', 'final-env']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /Rerun with --yes to confirm/);
  assert.deepEqual(await statuses(root), { 'T-0001': 'review', 'T-0002': 'review' });
  const accepted = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated', '--accept-failed-check', 'final-env', '--yes', '--note', 'base was already red']);
  assert.match(accepted.stdout, /2 ticket\(s\) marked done/);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"accept-failed-check","by":"owner","run":"r9","checks":\["final-env"\],"note":"base was already red"/);
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', { runId: 'r9' }), tk('T-0002', { runId: 'r9' })] }));
  // With every check passing the same tickets are done.
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', { runId: 'r9' }), tk('T-0002', { runId: 'r9' })] }));
  await writeState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/T-0001.ts', 'src/T-0002.ts'], jobs, checks: [{ name: 'tests', status: 'passed' }, { name: 'log-lint', status: 'passed' }] });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /2 ticket\(s\) marked done/);
});

test('eval 38.1: dependency keys the worker invented are dropped with a note, the split is not refused', async t => {
  const root = await tmp(t, 'l38-k-');
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo.', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const item = (key, extra) => ({ key, title: key, type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${key}.mjs`], size: 'S', risk: 'low', ...extra });
  const mount = item('mount', { integration: true, files: ['src/routes/m.mjs'], tests: ['tests/m.test.mjs'], dependsOn: ['ghost-key', 'mod'] });
  const ws = '.swarm/workspaces/r1/split-S1';
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify([item('mod'), mount]));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
  // Old behavior: "dependsOn names unknown keys: ghost-key" and nothing written.
  const split = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(split.exitCode, 0, split.stdout);
  assert.match(split.stdout, /note: T-0002: dropped dependsOn keys that name no ticket in the file: ghost-key/);
  const mounted = (await readLedger(root)).tickets.find(x => x.integration);
  assert.deepEqual(mounted.dependsOn, ['T-0001']);
});

test('eval 38.2: --help never acts (go --scope --help does not release or start anything)', async t => {
  const root = await project(t, [tk('T-0001', { status: 'todo' })]);
  const l = await readLedger(root); l.approved = approveLedger(l).approved; await writeLedger(root, l);
  const env = { ...process.env, SWARM_CONFIG_DIR: path.join(root, '.cfg') };
  const run = (...args) => exec(process.execPath, [swarm, '--root', root, ...args], { env }).then(r => r.stdout + r.stderr, e => `${e.stdout}${e.stderr}`);
  // Old behavior: go --scope --help prepared a wave: the todo ticket was released and a manifest written.
  for (const args of [['go', '--scope', '--help'], ['go', '--scope', '-h'], ['scope', 'split', '--help'], ['tickets', 'T-0001', '--set', 'ready', '--help']]) assert.match(await run(...args), /Project Swarm|Usage/);
  // -h as the value of a flag, or after --, is not a help request.
  assert.doesNotMatch(await run('tickets', 'T-0001', '--note', '-h'), /Usage: node tools\/swarm\.mjs/);
  assert.equal((await readLedger(root)).tickets[0].status, 'todo');
  await assert.rejects(fs.access(path.join(root, '.swarm/runs')));
  await assert.rejects(fs.access(path.join(root, 'docs/scope/split')));
});

test('eval 38.3: a failure that is not the ticket\'s own does not climb the ladder', async t => {
  assert.equal(isOwnFailure('credit exhausted'), false);
  assert.equal(isOwnFailure('HTTP 429 rate limited'), false);
  assert.equal(isOwnFailure('host-dead: dev2'), false);
  assert.equal(isOwnFailure('ECONNRESET'), false);
  assert.equal(isOwnFailure('output truncated at 8192 tokens'), true);
  assert.equal(isOwnFailure('model returned invalid JSON'), true);
  // Real code failures that merely contain those words or numbers are the ticket's own.
  for (const own of ['AssertionError: expected 200, received 429', 'at handler (foo.js:429:12)', 'TypeError: network request failed', 'quota exceeded in the billing module', 'error TS2394: This overload signature is not compatible', 'CORS preflight test failed']) assert.equal(isOwnFailure(own), true, own);
  const ledger = { tickets: [{ id: 'T-0001', status: 'running', dependsOn: [] }, { id: 'T-0002', status: 'running', dependsOn: [] }] };
  const moves = ticketOutcome([{ id: 'T-0001', status: 'failed', error: 'credit exhausted' }, { id: 'T-0002', status: 'failed', error: 'output truncated' }], ledger);
  assert.deepEqual(moves.map(m => [m.id, m.to, m.infra === true]), [['T-0001', 'ready', true], ['T-0002', 'blocked', false]]);
  // End to end: the ticket returns to ready at the same level with no escalation; after three in a row a person decides (the usual ladder).
  const root = await project(t, [tk('T-0001', { status: 'running', waveAt: undefined })]);
  const state = { id: 'r9', startedAt: new Date().toISOString(), jobs: [{ id: 'T-0001', status: 'failed', error: 'credit exhausted' }] };
  for (let i = 1; i <= 3; i += 1) {
    await edit(root, l => { l.tickets[0].status = 'running'; });
    await writeState(root, state);
    const synced = await runScopeCommand(root, 'scope', ['sync', 'r9']);
    assert.match(synced.stdout, /back to ready at the same level \(the failure was not theirs: T-0001\)/);
    const ticket = (await readLedger(root)).tickets[0];
    assert.equal(ticket.status, 'ready');
    assert.equal(ticket.escalation ?? 0, 0);
    assert.equal(ticket.infraRetries, i);
  }
  await edit(root, l => { l.tickets[0].status = 'running'; });
  await writeState(root, state);
  await runScopeCommand(root, 'scope', ['sync', 'r9']);
  const fourth = (await readLedger(root)).tickets[0];
  assert.equal(fourth.escalation, 1, 'the fourth time it is treated as its own failure');
  assert.equal(fourth.infraRetries, undefined, 'and the counter starts again');
});
async function edit(root, fn) { const l = await readLedger(root); fn(l); await writeLedger(root, l); }

test('eval 38.4: a ticket whose output already matches the tree is not stuck in review', async t => {
  const root = await project(t, [tk('T-0001', { runId: 'r9', tests: ['tests/T-0001.test.ts'] })], { verify: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/T-0001.ts'), 'export const a = 1;\n');
  // The ticket names a test file, so it must exist in the tree (a ticket whose tests were never written is not done).
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/T-0001.test.ts'), "import { a } from '../src/T-0001';\nif (a !== 1) throw new Error('a');\n");
  const ws = '.swarm/workspaces/r9/T-0001';
  await fs.mkdir(path.join(root, ws, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'src/T-0001.ts'), 'export const a = 1;\n');
  // Nothing to write (the tree already has the proposed bytes): the queue lists the job as integrated but no batch holds it.
  const state = { id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/T-0001.ts'], workspace: ws }], mergeQueue: { integrated: ['T-0001'], integratedIn: {}, checkFailed: [], batches: [] } };
  // Old behavior: "job files are not in the integrated files" kept it in review for ever.
  await writeState(root, state);
  const first = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(first.stdout, /1 ticket\(s\) marked done/);
  assert.match(first.stdout, /1 of them on output that was already in the tree \(not re-verified by this run\): T-0001/);
  // A workspace that points at the project itself, or a symlink, is not a match.
  for (const bad of ['.', 'src/..']) {
    await edit(root, l => { l.tickets[0].status = 'review'; l.tickets[0].runId = 'r9'; });
    await writeState(root, { ...state, jobs: [{ ...state.jobs[0], workspace: bad }] });
    assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /stay in review/, bad);
  }
  await fs.rm(path.join(root, ws, 'src/T-0001.ts'));
  await fs.symlink(path.join(root, 'src/T-0001.ts'), path.join(root, ws, 'src/T-0001.ts'));
  await edit(root, l => { l.tickets[0].status = 'review'; l.tickets[0].runId = 'r9'; });
  await writeState(root, state);
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /stay in review/, 'symlink');
  await fs.rm(path.join(root, ws, 'src/T-0001.ts'));
  await fs.writeFile(path.join(root, ws, 'src/T-0001.ts'), 'export const a = 1;\n');
  // A different tree is still not done.
  await edit(root, l => { l.tickets[0].status = 'review'; l.tickets[0].runId = 'r9'; });
  await fs.writeFile(path.join(root, 'src/T-0001.ts'), 'export const a = 2;\n');
  await writeState(root, state);
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /stay in review.*job files are not in the integrated files/);
});

test('eval 38.5: swarm tickets --release is a clean release of held tickets', async t => {
  const root = await project(t, [tk('T-0001', { status: 'done' }), tk('T-0002', { status: 'blocked', blockReason: 'failure', attempts: 3, escalation: 2, retryNote: 'failed checks: tests', retryHistory: [{ run: 'r1' }], dependsOn: ['T-0001'] }), tk('T-0003', { status: 'blocked', dependsOn: ['T-0009'] }), tk('T-0004', { status: 'running' }), tk('T-0009', { status: 'todo' })]);
  const l = await readLedger(root); l.approved = approveLedger(l).approved; await writeLedger(root, l);
  const run = args => runScopeCommand(root, 'tickets', args);
  // Old behavior: --set ready left the attempts, escalation level and retry note on the ticket.
  const out = await run(['T-0002', 'T-0003', 'T-0004', 'T-0100', '--release', '--note', 'S6 fixed the base']);
  assert.match(out.stdout, /released 1 ticket\(s\) to ready: T-0002/);
  assert.match(out.stdout, /not released: T-0003: still waits on T-0009/);
  assert.match(out.stdout, /not released: T-0004: is running/);
  assert.match(out.stdout, /not released: T-0100: no such ticket/);
  const after = await readLedger(root);
  const t2 = after.tickets.find(x => x.id === 'T-0002');
  assert.equal(t2.status, 'ready');
  for (const key of ['blockReason', 'attempts', 'escalation', 'retryNote', 'retryHistory']) assert.equal(t2[key], undefined, key);
  assert.equal(isApproved(after), true);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"release","by":"owner","tickets":\["T-0002"\],"from":"blocked","note":"S6 fixed the base"/);
  assert.equal((await run(['T-0001', '--release'])).exitCode, 1, 'a done ticket is not released');
});

test('eval 38.6 (S6 T-0090/T-0091): a failure in another ticket\'s file goes to its owner, or blocks with a note; no attempt, no escalation for the ticket that did not cause it', async t => {
  const lint = tail => ({ id: 1, jobs: ['T-0091'], checks: 'failed', security: 'skipped', checkResults: [{ name: 'lint', status: 'failed', tail }] });
  const batchState = (jobs, batches, integratedIn) => ({ id: 'r9', integratedAt: 'now', jobs, mergeQueue: { integrated: jobs.map(j => j.id), integratedIn, checkFailed: [], batches } });
  const make = async tickets => {
    const root = await project(t, tickets);
    await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
    await fs.writeFile(path.join(root, '.swarm/runs/r9/manifest.json'), JSON.stringify({ checks: [{ name: 'lint', argv: ['x'] }] }));
    return root;
  };
  const own = tk('T-0091', { files: ['src/useRequests.ts'], runId: 'r9' });
  const job91 = { id: 'T-0091', status: 'complete', outputs: ['src/useRequests.ts'] };
  const job90 = { id: 'T-0090', status: 'complete', outputs: ['src/useShops.ts'] };
  const message = "src/useShops.ts:12:3  error  React Hook \"use...\" is called in function \"loadShops\"  react-hooks/rules-of-hooks";
  // (a) T-0090 was finished in an earlier run: T-0091 is blocked with a clear note, nothing counted against it. Old behavior: it was sent back and climbed the ladder.
  let root = await make([tk('T-0090', { status: 'done', files: ['src/useShops.ts'] }), own]);
  await writeState(root, batchState([job91], [lint(message)], { 'T-0091': 1 }));
  let synced = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(synced.stdout, /1 ticket\(s\) blocked after every escalation level failed|blocked/);
  let t91 = (await readLedger(root)).tickets.find(x => x.id === 'T-0091');
  assert.equal(t91.status, 'blocked');
  assert.equal(t91.blockReason, 'manual');
  assert.match(t91.blockNote, /the lint check failed on files of T-0090 \(done\), not on this ticket's own files, and none of them is in run r9/);
  assert.equal(t91.attempts, undefined);
  assert.equal(t91.escalation, undefined);
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"foreign-failure","id":"T-0091"/);
  // (b) T-0090 is in review in this run: it gets the failure (one attempt), T-0091 waits in review with nothing counted.
  root = await make([tk('T-0090', { files: ['src/useShops.ts'], runId: 'r9' }), own]);
  await writeState(root, batchState([job90, job91], [{ id: 1, jobs: ['T-0090'], checks: 'passed', security: 'skipped', checkResults: [{ name: 'lint', status: 'passed' }] }, lint(message)], { 'T-0090': 1, 'T-0091': 2 }));
  // T-0091's batch is the second one
  const state = batchState([job90, job91], [{ id: 1, jobs: ['T-0090'], checks: 'passed', security: 'skipped', checkResults: [{ name: 'lint', status: 'passed' }] }, { ...lint(message), id: 2 }], { 'T-0090': 1, 'T-0091': 2 });
  await writeState(root, state);
  synced = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(synced.stdout, /T-0091 \(the lint check failed on files of T-0090, not on its own; the failure went to that ticket, no attempt counted for T-0091/);
  const both = (await readLedger(root)).tickets;
  const t90 = both.find(x => x.id === 'T-0090');
  assert.equal(t90.status, 'ready');
  assert.equal(t90.attempts, 1);
  assert.match(t90.retryNote, /failed checks: lint; src\/useShops\.ts:12:3/);
  t91 = both.find(x => x.id === 'T-0091');
  assert.equal(t91.status, 'review');
  assert.equal(t91.attempts, undefined);
  // (c) The errors name the ticket's own file: the usual retry, one attempt.
  root = await make([tk('T-0090', { status: 'done', files: ['src/useShops.ts'] }), own]);
  await writeState(root, batchState([job91], [lint('src/useRequests.ts:3:1 error no-unused-vars')], { 'T-0091': 1 }));
  await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  t91 = (await readLedger(root)).tickets.find(x => x.id === 'T-0091');
  assert.equal(t91.status, 'ready');
  assert.equal(t91.attempts, 1);
  // (d) Errors that name no file of any ticket are the ticket's own, as before.
  root = await make([tk('T-0090', { status: 'done', files: ['src/useShops.ts'] }), own]);
  await writeState(root, batchState([job91], [lint('error: something unexpected')], { 'T-0091': 1 }));
  await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.equal((await readLedger(root)).tickets.find(x => x.id === 'T-0091').attempts, 1);
});
