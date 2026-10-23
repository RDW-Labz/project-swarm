// SPDX-License-Identifier: Apache-2.0
// Scenario evals for lesson 34 (parts app S5 report). Each reproduces the failure the owner saw and fails on the 1.92.0 runner.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runScopeCommand, prepareScopeRun, unlockLedger, buildSplitManifest, ticketsFromStageLists } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { readLedger, writeLedger, createLedger, transition, renderBuildPlan, ledgerStats, isApproved, approveLedger } from '../tools/tickets.mjs';
import { runManifest, integrateRun } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');
const tmp = async (t, prefix) => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
async function project(t) {
  const root = await tmp(t, 'l34-');
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  return root;
}
async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
}
const MODULE = { key: 'create', title: 'Create module', type: 'build', scopeRefs: ['R-001'], acceptance: ['201'], files: ['src/create.mjs'], size: 'S', risk: 'low' };
const MOUNT = { key: 'mount', title: 'Mount create route', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['POST /requests returns 201'], files: ['src/routes/requests.mjs'], tests: ['tests/routes.test.mjs'], size: 'S', risk: 'low' };
async function approved(t, items) {
  const root = await project(t);
  await fakeRun(root, 'r1', items);
  const split = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(split.exitCode, 0, split.stdout);
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'])).exitCode, 0);
  return root;
}
async function edit(root, fn) { const l = await readLedger(root); fn(l); await writeLedger(root, l); }

test('eval 34.1: split adds an integration ticket per requirement, and a requirement is done only when it is wired', async t => {
  // Old behavior: modules only, nothing mounts them, split accepted it.
  const root = await project(t);
  await fakeRun(root, 'r1', [MODULE]);
  // New behaviour (parts-app lesson 55): the split is kept, the wire manifest is written, and approval is held until the integration ticket exists.
  const kept = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(kept.exitCode, 0, kept.stdout);
  assert.match(kept.stdout, /wiring: 1 requirement\(s\) have modules but no integration ticket \(R-001\)/);
  assert.match(kept.stdout, /Next: swarm run docs\/scope\/split\/wire-manifest\.json, then swarm scope split --ingest RUN --merge --wire/);
  const wireManifest = JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/wire-manifest.json'), 'utf8'));
  assert.match(wireManifest.jobs[0].prompt, /Write ONLY integration tickets/);
  assert.equal((await readLedger(root)).tickets.length > 0, true, 'the split is not thrown away');
  const held = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(held.exitCode, 1);
  assert.match(held.stdout, /not approvable: 1 requirement\(s\) have modules but no integration ticket \(R-001\)/);
  await fs.rm(path.join(root, '.swarm/project/tickets.json'));
  // The prompt asks for it.
  assert.match(buildSplitManifest(parseScope(SCOPE), {}).jobs[0].prompt, /integration ticket.*routes, pages or entry points.*route-level or end-to-end test/s);
  // An integration ticket without a route-level test is repaired or parked; ingest does not refuse the whole split.
  await fakeRun(root, 'r2', [MODULE, { ...MOUNT, tests: [] }]);
  const badWire = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2', '--max-repairs', '0']);
  assert.equal(badWire.exitCode, 0, badWire.stdout);
  assert.match(badWire.stdout, /no route-level test|parked:/);
  const parkedMount = badWire.stdout.match(/parked:/) ? badWire.stdout : '';
  if (parkedMount) assert.match(parkedMount, /no route-level test/);
  await fs.rm(path.join(root, '.swarm/project/tickets.json'), { force: true }).catch(() => {});
  // With the integration ticket the split passes, the runner makes it wait for the module, and the ledger is marked as wired.
  await fakeRun(root, 'r3', [MODULE, MOUNT]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r3'])).exitCode, 0);
  const ledger = await readLedger(root);
  assert.equal(ledger.wiring, true);
  const mount = ledger.tickets.find(x => x.integration);
  assert.deepEqual(mount.dependsOn, [ledger.tickets.find(x => x.title === 'Create module').id]);
  // A wired ledger whose requirement has only module tickets (an old split merged in) is never reported done.
  const bare = { ...ledger, tickets: ledger.tickets.filter(x => !x.integration).map(x => ({ ...x, status: 'done' })) };
  assert.match(renderBuildPlan(bare, parseScope(SCOPE)), /\| R-001 .*\| unwired \|/);
  assert.equal(ledgerStats({ ...bare, requirements: ['R-001'] }).coveragePct, 0);
  assert.equal(ledgerStats({ ...ledger, tickets: ledger.tickets.map(x => ({ ...x, status: 'done' })), requirements: ['R-001'] }).coveragePct, 100);
});

test('eval 34.1b: swarm scope split --wire asks only for the missing integration tickets of an existing ledger', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [MODULE, MOUNT]);
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  // An old ledger: modules built, nothing mounts them.
  await edit(root, l => { l.tickets = l.tickets.filter(x => !x.integration); l.tickets[0].status = 'done'; delete l.wiring; });
  // Done modules are skipped by default (lesson 37); --all wires them too.
  assert.match((await runScopeCommand(root, 'scope', ['split', '--wire'])).stdout, /nothing to wire: 1 requirement\(s\) are already built and done/);
  const made = await runScopeCommand(root, 'scope', ['split', '--wire', '--all']);
  assert.equal(made.exitCode, 0, made.stdout);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/manifest.json'), 'utf8'));
  assert.match(manifest.jobs[0].prompt, /Write ONLY integration tickets.*Existing module tickets of R-001: T-0001 Create module \(src\/create\.mjs\)/s);
  await fakeRun(root, 'r2', [MOUNT]);
  await fakeRun(root, 'r2b', [MODULE]);
  assert.match((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2b', '--merge', '--wire'])).stdout, /--wire takes integration tickets only/);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2', '--merge', '--wire'])).exitCode, 0);
  assert.notEqual((await readLedger(root)).wiring, true, 'merging into an older ledger does not put it under the wiring rule');
  const ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets.find(x => x.integration).dependsOn, ['T-0001']);
  assert.match((await runScopeCommand(root, 'scope', ['split', '--wire'])).stdout, /already has an integration ticket/);
});

test('eval 34.2: go --scope releases the root tickets of an approved stage without a hand move', async t => {
  const root = await approved(t, [MODULE, MOUNT]);
  const before = await readLedger(root);
  assert.equal(before.tickets.find(x => x.title === 'Create module').status, 'todo');
  // A ready-state root is picked, and a root left in todo (never released) is released and logged.
  const prepared = await prepareScopeRun(root, {});
  assert.deepEqual(prepared.ids, ['T-0001']);
  const log = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  assert.match(log, /"event":"release","by":"go","tickets":\["T-0001"\]/);
  // The approval is untouched by a release.
  assert.equal(isApproved(await readLedger(root)), true);
  // Autopilot releases a finished stage's next roots too (status todo with dependencies done).
  await edit(root, l => { l.tickets[0].status = 'done'; });
  assert.deepEqual(await unlockLedger(root), ['T-0002']);
  assert.equal((await readLedger(root)).tickets[1].status, 'ready');
});

test('eval 34.3: cancelling a ticket removes it from the dependencies of the others, and the approval survives', async t => {
  const root = await approved(t, [MODULE, MOUNT]);
  // Old behavior: the mount ticket waited on a cancelled ticket for ever.
  await transition(root, 'T-0001', 'cancelled', { by: 'owner' });
  let ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets[1].dependsOn, []);
  assert.equal(isApproved(ledger), true, 'removing a dead dependency keeps the owner approval');
  assert.deepEqual((await prepareScopeRun(root, {})).ids, ['T-0002']);
  // An older ledger that still lists the cancelled dependency is cleaned on the next go --scope, and a deps-blocked ticket with nothing left to wait for unlocks.
  const second = await approved(t, [MODULE, MOUNT]);
  await edit(second, l => { l.tickets[0].status = 'cancelled'; l.tickets[1].status = 'blocked'; l.tickets[1].blockReason = 'deps'; });
  await edit(second, l => { l.approved = approveLedger(l).approved; });
  assert.deepEqual((await prepareScopeRun(second, {})).ids, ['T-0002']);
  ledger = await readLedger(second);
  assert.deepEqual(ledger.tickets[1].dependsOn, []);
  assert.equal(isApproved(ledger), true);
  const log = await fs.readFile(path.join(second, '.swarm/project/tickets.log'), 'utf8');
  assert.match(log, /"event":"prune-deps"/);
  // The owner is told, without being blocked: one journal note names the affected ticket (an FYI, never an inbox item that needs them).
  const { collectInbox } = await import('../tools/inbox.mjs');
  const { inboxDeps } = await import('../tools/inbox-commands.mjs');
  const { readJournal } = await import('../tools/journal.mjs');
  const items = await collectInbox([root], inboxDeps());
  assert.equal(items.find(i => /no action needed/.test(i.title)), undefined, 'nothing is added to what waits for the owner');
  const note = (await readJournal(root, { limit: Infinity })).find(e => e.kind === 'note' && /dropped as a dependency/.test(e.text));
  assert.ok(note, 'a cancel that drops a dependency leaves a journal note');
  assert.match(note.text, /T-0002/);
});

const runState = (root, state) => fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true }).then(() => fs.writeFile(path.join(root, '.swarm/runs/r9/state.json'), JSON.stringify(state)));
test('eval 34.4: a failed typecheck or lint check in review goes back to the worker with the errors', async t => {
  const root = await tmp(t, 'l34-q-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' } }));
  const ticket = { id: 'T-0001', title: 'A', type: 'build', epic: 'E', scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/a.ts'], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review', stage: 'S1' };
  await writeLedger(root, createLedger({ scope: { name: 'P', version: 1, hash: 'a'.repeat(64) }, tickets: [ticket] }));
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] } } }));
  await fs.mkdir(path.join(root, '.swarm/runs/r9'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r9/manifest.json'), JSON.stringify({ checks: [{ name: 'typecheck', argv: ['x'] }, { name: 'lint', argv: ['y'] }] }));
  // Old behavior: the failed check was not "missing", but the ticket still sat in review ("stays in review") until a person fixed it.
  const failedBatch = { id: 1, jobs: ['T-0001'], checks: 'failed', security: 'skipped', checkResults: [{ name: 'typecheck', status: 'passed' }, { name: 'lint', status: 'failed', tail: 'src/a.ts:3:1 error no-unused-vars' }] };
  await runState(root, { id: 'r9', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }], mergeQueue: { integrated: ['T-0001'], integratedIn: { 'T-0001': 1 }, checkFailed: [], batches: [failedBatch] } });
  const synced = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(synced.stdout, /back to ready, one level higher/);
  const after = (await readLedger(root)).tickets[0];
  assert.equal(after.status, 'ready');
  assert.match(after.retryNote, /failed checks: lint; src\/a\.ts:3:1 error no-unused-vars/);
  // A plain integrate (no merge queue) records the failed check on the run: same result.
  await edit(root, l => { l.tickets[0].status = 'review'; l.tickets[0].runId = 'r9'; delete l.tickets[0].retryNote; });
  await runState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/a.ts'], jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }], checks: [{ name: 'typecheck', status: 'failed', tail: 'TS2304: Cannot find name foo' }, { name: 'lint', status: 'passed' }] });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /back to ready/);
  assert.match((await readLedger(root)).tickets[0].retryNote, /TS2304/);
  // Several tickets share one plain integrate: only the ticket the errors name goes back; the other stays in review.
  const second = { ...ticket, id: 'T-0002', title: 'B', files: ['src/b.ts'] };
  await edit(root, l => { l.tickets[0].status = 'review'; l.tickets[0].runId = 'r9'; delete l.tickets[0].retryNote; l.tickets.push({ ...second, runId: 'r9' }); });
  await runState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/a.ts', 'src/b.ts'], jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }, { id: 'T-0002', status: 'complete', outputs: ['src/b.ts'] }], checks: [{ name: 'typecheck', status: 'failed', tail: 'src/a.ts(3,5): error TS2304' }, { name: 'lint', status: 'passed' }] });
  const shared = await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated']);
  assert.match(shared.stdout, /T-0002 \(the typecheck check failed for the whole run and its errors do not name this ticket's files/);
  const both = (await readLedger(root)).tickets;
  assert.equal(both[0].status, 'ready');
  assert.equal(both[1].status, 'review');
  await edit(root, l => { l.tickets = l.tickets.slice(0, 1); });
  // A check that never ran stays in review (nothing to send back).
  await edit(root, l => { l.tickets[0].status = 'review'; l.tickets[0].runId = 'r9'; });
  await runState(root, { id: 'r9', integratedAt: 'now', integratedFiles: ['src/a.ts'], jobs: [{ id: 'T-0001', status: 'complete', outputs: ['src/a.ts'] }], checks: [] });
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r9', '--integrated'])).stdout, /stay in review/);
});

test('eval 34.5: a test worker that leaves tsconfig.tsbuildinfo or other gitignored build files needs no --accept-dropped', async t => {
  const root = await tmp(t, 'l34-d-');
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\nbuild-cache/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  const script = "fs.writeFileSync('input.txt','updated');fs.writeFileSync('tsconfig.tsbuildinfo','{}');fs.mkdirSync('build-cache');fs.writeFileSync('build-cache/x.bin','1');fs.mkdirSync('coverage');fs.writeFileSync('coverage/lcov.info','1')";
  const spawnImpl = (_c, _a, options) => spawn(process.execPath, ['-e', `const fs=require('fs');${script};console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`], options);
  const manifest = { version: 1, jobs: [{ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'] }] };
  const state = await runManifest(root, manifest, { spawnImpl });
  assert.equal(state.jobs[0].droppedWrites, undefined, JSON.stringify(state.jobs[0].droppedWrites));
  const integrated = await integrateRun(root, state.id);
  assert.equal(integrated.status ?? 'integrated', 'integrated');
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.equal(await fs.readFile(path.join(root, 'tsconfig.tsbuildinfo'), 'utf8').catch(() => null), null, 'the build file is not copied into the project');
  // A tracked file edited under a build-looking folder, and a secret under one, are still dropped writes.
  await fs.mkdir(path.join(root, 'scripts/build'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts/build/release.mjs'), 'old');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'tracked build script']);
  const spawnTracked = (_c, _a, options) => spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt','x');fs.mkdirSync('scripts/build',{recursive:true});fs.writeFileSync('scripts/build/release.mjs','new');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/.env','S=1');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`], options);
  const state3 = await runManifest(root, { ...manifest, jobs: [{ ...manifest.jobs[0], id: 'tracked' }] }, { spawnImpl: spawnTracked });
  assert.deepEqual(state3.jobs[0].droppedWrites, ['dist/.env', 'scripts/build/release.mjs']);
  // A real stray source file is still a dropped write.
  const stray = { ...manifest, jobs: [{ ...manifest.jobs[0], id: 'stray' }] };
  const spawnStray = (_c, _a, options) => spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt','again');fs.writeFileSync('extra.txt','oops');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`], options);
  const state2 = await runManifest(root, stray, { spawnImpl: spawnStray });
  assert.deepEqual(state2.jobs[0].droppedWrites, ['extra.txt']);
});
