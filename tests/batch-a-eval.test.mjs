// SPDX-License-Identifier: Apache-2.0
// Scenario evals for the lesson 34 leftover (failed test at done-check), lesson 17 (swarm tickets) and lesson 14 (approve a manifest).
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readLedger, writeLedger, createLedger, approveLedger, isApproved } from '../tools/tickets.mjs';
import { runManifest } from '../tools/swarm.mjs';
import { runSecurityGate } from '../tools/security-gate.mjs';
import { createHash } from 'node:crypto';
import { readJournal } from '../tools/journal.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');

const tmp = async (t, prefix) => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const tk = (id, extra = {}) => ({ id, title: id, type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${id}.ts`], tests: [`tests/${id}.test.ts`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', stage: 'S1', ...extra });
const runState = (root, state) => fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true }).then(() => fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state)));
const writeTests = async (root, tickets) => { for (const f of tickets.flatMap(x => x.tests ?? [])) { await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fs.writeFile(path.join(root, f), 'test'); } };
async function withLedger(t, tickets) {
  const root = await tmp(t, 'ba-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets }));
  // The test files the tickets name exist in the tree (a ticket whose named tests are missing is not done).
  for (const f of tickets.flatMap(x => x.tests ?? [])) { await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fs.writeFile(path.join(root, f), 'test'); }
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, verify: { command: ['npm', 'test'] }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] } } }));
  return root;
}

test('eval 36.1: a failed test at done-check goes back to the worker with the failure', async t => {
  const root = await withLedger(t, [tk('T-0001')]);
  // Old behavior: "tests check is failed" / "batch did not pass" put the ticket in "stay in review" until a person fixed it.
  const batch = { id: 1, jobs: ['T-0001'], checks: 'failed', security: 'skipped', checkResults: [{ name: 'tests', status: 'failed', mode: 'affected', tests: 3, tail: 'FAIL tests/T-0001.test.ts expected 201 got 500' }] };
  await runState(root, { id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/T-0001.ts'] }], mergeQueue: { integrated: ['T-0001'], integratedIn: { 'T-0001': 1 }, checkFailed: [], batches: [batch] } });
  const synced = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(synced.stdout, /back to ready, one level higher/);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.status, 'ready');
  assert.match(after.retryNote, /failed checks: tests; FAIL tests\/T-0001\.test\.ts expected 201 got 500/);
  // A plain integrate (no merge queue): same result for a ticket whose files the output names; the other ticket stays in review.
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [tk('T-0001', { runId: 'r9' }), tk('T-0002', { runId: 'r9' })] }));
  await writeTests(root, [tk('T-0002')]);
  await runState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/T-0001.ts', 'src/T-0002.ts'], jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/T-0001.ts'] }, { id: 'T-0002', status: 'complete', outputs: ['src/T-0002.ts'] }], checks: [{ name: 'tests', status: 'failed', tail: 'FAIL tests/T-0001.test.ts' }] });
  const shared = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(shared.stdout, /T-0002 \(the tests check failed for the whole run and its output does not name this ticket's files/);
  const both = (await readLedger(root)).tickets;
  assert.equal(both[0].status, 'ready');
  assert.equal(both[1].status, 'review');
  // A test that failed for many tickets is the base or the setup: nobody is retried.
  const many = ['T-0001', 'T-0002', 'T-0003'].map(id => tk(id, { runId: 'r9' }));
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: many }));
  await writeTests(root, many);
  await runState(root, { id: 'r9', integratedAt: 'now', integratedFiles: many.flatMap(x => x.files), jobs: many.map(x => ({ id: x.id, status: 'complete', outputs: x.files })), checks: [{ name: 'tests', status: 'failed', tail: 'FAIL T-0001 T-0002 T-0003 src/T-0001.ts src/T-0002.ts src/T-0003.ts' }] });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /the tests check failed for 3 tickets of this run, so the base or the setup is likely at fault/);
  assert.ok((await readLedger(root)).tickets.every(x => x.status === 'review'));
});

test('eval 36.2: swarm tickets ID --files/--context edits the lists and keeps an approved ledger approved', async t => {
  const root = await withLedger(t, [tk('T-0001', { status: 'todo' }), tk('T-0002', { status: 'running' }), tk('T-0003', { status: 'todo', files: ['src/other.ts'] })]);
  await edit(root, l => { l.approved = approveLedger(l).approved; });
  const run = args => runScopeCommand(root, 'tickets', args);
  // Old behavior: no command; the lists were edited by hand in tickets.json and the ledger re-approved by hand.
  const preview = await run(['T-0001', '--files', 'src/a.ts,src/b.ts', '--context', 'docs/x.md']);
  assert.match(preview.stdout, /files: src\/T-0001\.ts  ->  src\/a\.ts, src\/b\.ts[\s\S]*Rerun with --yes/);
  assert.deepEqual((await readLedger(root)).tickets[0].files, ['src/T-0001.ts'], 'a preview changes nothing');
  const applied = await run(['T-0001', '--files', 'src/a.ts,src/b.ts', '--context', 'docs/x.md', '--yes']);
  assert.equal(applied.exitCode, 0, applied.stdout);
  const ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets[0].files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(ledger.tickets[0].context, ['docs/x.md']);
  assert.equal(isApproved(ledger), true, 'the approval is sealed again over the new lists');
  assert.match(await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8'), /"event":"ticket-edit","id":"T-0001"/);
  // Refusals: a running ticket, a file another ticket owns, a bad path, a reserved name.
  assert.match((await run(['T-0002', '--files', 'src/z.ts', '--yes'])).stdout, /T-0002 is running/);
  assert.match((await run(['T-0001', '--files', 'src/other.ts', '--yes'])).stdout, /src\/other\.ts is already written by T-0003/);
  assert.match((await run(['T-0001', '--files', '../x.ts', '--yes'])).stdout, /refused/);
  assert.match((await run(['T-0001', '--files', 'src/.env', '--yes'])).stdout, /not allowed/);
  assert.deepEqual((await readLedger(root)).tickets[0].files, ['src/a.ts', 'src/b.ts']);
  // Review tickets cannot change their lists (a cleared tests list would skip the done-check); .env cannot be context or tests.
  await edit(root, l => { l.tickets[0].status = 'review'; });
  assert.match((await run(['T-0001', '--tests', '', '--yes'])).stdout, /only a todo, ready or blocked ticket/);
  await edit(root, l => { l.tickets[0].status = 'todo'; });
  assert.match((await run(['T-0001', '--context', '.env', '--yes'])).stdout, /context path not allowed: \.env/);
  assert.equal((await run(['T-0001', '--context', '.env.example', '--yes'])).exitCode, 0);
  // A ledger that was not approved stays not approved.
  await edit(root, l => { l.approved = null; });
  assert.equal((await run(['T-0001', '--tests', 'tests/new.test.ts', '--yes'])).exitCode, 0);
  assert.equal(isApproved(await readLedger(root)), false);
});
async function edit(root, fn) { const l = await readLedger(root); fn(l); await writeLedger(root, l); }

test('eval 36.3: integrate --approve-manifest lets one reviewed manifest pass the security gate, once, and records a decision', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ba-m-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x']);
  const reply = files => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files }) } }), { headers: { 'content-type': 'application/json' } });
  const make = async () => {
    const m = { version: 1, concurrency: 1, jobs: [{ id: 'job-0', agent: 'ollama', model: 'test-model', prompt: 'Update the workspace file.', context: ['input.txt'], outputs: ['pnpm-workspace.yaml'], timeoutMs: 5000 }] };
    const r = await runManifest(root, m, { fetchImpl: async () => reply([{ path: 'pnpm-workspace.yaml', content: 'packages: []\n' }]) });
    assert.equal(r.status, 'complete', r.error);
    return r.id;
  };
  const cli = (...args) => exec(process.execPath, [swarm, '--root', root, ...args], { env: { ...process.env, SWARM_CONFIG_DIR: path.join(root, '.cfg') } }).then(r => ({ code: 0, out: r.stdout + r.stderr }), e => ({ code: e.code, out: `${e.stdout}${e.stderr}` }));
  // Old behavior: the block message gave the owner no way forward.
  const first = await make();
  const blocked = await cli('integrate', first, '--no-checks');
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.out, /unsupported-manifest/);
  assert.match(blocked.out, /--approve-manifest pnpm-workspace\.yaml/);
  await assert.rejects(fs.access(path.join(root, 'pnpm-workspace.yaml')));
  // A file the run does not change cannot be approved, and leaves no decision record.
  const other = await cli('integrate', first, '--no-checks', '--approve-manifest', 'other.mod');
  assert.notEqual(other.code, 0);
  assert.match(other.out, /does not change other\.mod/);
  assert.equal((await readJournal(root, { kinds: ['decision'], limit: Infinity })).filter(e => /other\.mod/.test(String(e.id))).length, 0);
  // No glob, folder or odd path.
  for (const bad of ['*', 'dir/', './pnpm-workspace.yaml', 'a b']) assert.match((await cli('integrate', first, '--no-checks', '--approve-manifest', bad)).out, /exact repo-relative file path/);
  // The named file passes, and the decision is recorded.
  const ok = await cli('integrate', first, '--no-checks', '--approve-manifest', 'pnpm-workspace.yaml');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), 'packages: []\n');
  const decisions = (await readJournal(root, { kinds: ['decision'], limit: Infinity })).filter(e => /approve-manifest-.*pnpm-workspace/.test(String(e.id)));
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].text, /pnpm-workspace\.yaml \(sha256 [0-9a-f]{12}\).*approved exactly that content past the security gate for run/);
  // It was for that run only: a later run changing the same file is blocked again.
  await fs.rm(path.join(root, 'pnpm-workspace.yaml'));
  await exec('git', ['-C', root, 'checkout', '-q', '--', '.']).catch(() => {});
  const second = await make();
  assert.notEqual((await cli('integrate', second, '--no-checks')).code, 0);
  // The queue path honors it too.
  const queued = await cli('integrate', second, '--queue', '--no-checks', '--approve-manifest', 'pnpm-workspace.yaml');
  assert.equal(queued.code, 0, queued.out);
  assert.equal(await fs.readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8'), 'packages: []\n');
  // A path outside the project is refused.
  assert.match((await cli('integrate', second, '--no-checks', '--approve-manifest', '../x')).out, /repo-relative/);
});

test('eval 36.4: an approved manifest is tied to its exact content: a changed file needs a new approval', async () => {
  const good = Buffer.from('packages: []\n');
  const changed = Buffer.from('packages: [evil]\n');
  const sha = createHash('sha256').update(good).digest('hex');
  const gate = (bytes, policy) => runSecurityGate({ changes: [{ file: 'pnpm-workspace.yaml', bytes, previous: null }], policy: { codeScan: 'off', requireVulnerabilityScan: false, ...policy }, cwd: os.tmpdir(), exec: async () => ({ code: 0, stdout: '', stderr: '' }), fetchImpl: async () => { throw new Error('offline'); } });
  // Old behavior: the approval was by path, so any later content for the same file passed.
  assert.equal((await gate(good, {})).blocks.some(b => b.check === 'unsupported-manifest'), true);
  assert.equal((await gate(good, { approvedManifests: [{ file: 'pnpm-workspace.yaml', sha256: sha }] })).blocks.some(b => b.check === 'unsupported-manifest'), false);
  const after = await gate(changed, { approvedManifests: [{ file: 'pnpm-workspace.yaml', sha256: sha }] });
  const block = after.blocks.find(b => b.check === 'unsupported-manifest');
  assert.ok(block);
  assert.match(block.message, /changed after you approved it \(approved [0-9a-f]{12}, now [0-9a-f]{12}\); review it again/);
  // A malformed approval (no hash) approves nothing.
  assert.equal((await gate(good, { approvedManifests: [{ file: 'pnpm-workspace.yaml' }] })).blocks.some(b => b.check === 'unsupported-manifest'), true);
});
