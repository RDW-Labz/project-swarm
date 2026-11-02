// SPDX-License-Identifier: Apache-2.0
// parts-app lessons 54-55: a Haiku split left tests without acceptance, wired nothing, and put tests before the modules they import.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand, ticketsFromStageLists, buildSplitManifest } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { orderTestsAfterBuild } from '../tools/wiring.mjs';
import { readLedger } from '../tools/tickets.mjs';

const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '- Rejects an empty body.', '',
  '### R-002 A user can list requests.', 'Acceptance:', '- Returns the list.', '', '## Protected', '- .env', ''].join('\n');
const scope = parseScope(SCOPE);
const item = (key, extra = {}) => ({ key, title: key, type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${key}.mjs`], size: 'S', risk: 'low', ...extra });
const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'l55-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
}

test('a test or build ticket with no acceptance lines gets its requirement\'s own lines, said in a note; with none to copy it is still refused', () => {
  const built = ticketsFromStageLists([{ stage: 'S1', items: [item('mod'), item('mod-test', { type: 'test', acceptance: [], files: ['tests/mod.test.mjs'], dependsOn: ['mod'] }), item('blank', { type: 'test', files: ['tests/b.test.mjs'], acceptance: ['  '], scopeRefs: ['R-001'] })] }], scope);
  assert.deepEqual(built.errors, []);
  const test_ = built.tickets.find(t => t.title === 'mod-test');
  assert.deepEqual(test_.acceptance, ['Returns 201.', 'Rejects an empty body.']);
  assert.ok(built.notes.some(n => /T-0002: no acceptance lines from the worker; copied 2 from R-001/.test(n)));
  assert.deepEqual(built.tickets.find(t => t.title === 'blank').acceptance, ['Returns 201.', 'Rejects an empty body.'], 'blank lines count as none');
  const bare = { ...scope, requirements: scope.requirements.map(r => (r.id === 'R-002' ? { ...r, acceptance: [] } : r)) };
  const none = ticketsFromStageLists([{ stage: 'S1', items: [item('x', { acceptance: [], scopeRefs: ['R-002'] })] }], bare);
  assert.match(none.errors[0], /acceptance is required/);
  const buildBare = ticketsFromStageLists([{ stage: 'S1', items: [item('z', { acceptance: [] })] }], scope);
  assert.match(buildBare.errors[0], /acceptance is required/, 'a module ticket is not given route-level lines it cannot meet before wiring');
  const kept = ticketsFromStageLists([{ stage: 'S1', items: [item('y', { acceptance: ['mine'] })] }], scope);
  assert.deepEqual(kept.tickets[0].acceptance, ['mine'], 'the worker\'s own lines are never replaced');
});

test('a test waits for the modules it tests; a test-first order from the worker is flipped, never a cycle; integration tickets and old tickets are left alone', () => {
  const t = (id, type, deps = [], extra = {}) => ({ id, type, status: 'todo', scopeRefs: ['R-001'], dependsOn: deps, ...extra });
  const added = [t('T-1', 'test', []), t('T-2', 'build', ['T-1']), t('T-3', 'build', []), t('T-4', 'build', ['T-3'], { integration: true })];
  const notes = orderTestsAfterBuild(added, []);
  assert.deepEqual(added[0].dependsOn.sort(), ['T-2', 'T-3']);
  assert.deepEqual(added[1].dependsOn, [], 'the module no longer waits for its own test');
  assert.deepEqual(added[3].dependsOn, ['T-3'], 'integration tickets are not touched');
  assert.match(notes[0], /T-1: test ticket now waits for T-2, T-3.*T-2 no longer waits for it/);
  assert.deepEqual(orderTestsAfterBuild(added, []), [], 'idempotent');
  // An older done module is not given a dependency; a test of another requirement is not tied to this one.
  const old = [t('T-0', 'build', [], { status: 'done' })];
  const fresh = [t('T-9', 'test', [])];
  orderTestsAfterBuild(fresh, old);
  assert.deepEqual(fresh[0].dependsOn, []);
  const other = [t('T-5', 'test', [], { scopeRefs: ['R-002'] }), t('T-6', 'build', [])];
  orderTestsAfterBuild(other, []);
  assert.deepEqual(other[0].dependsOn, []);
  // A chain that already runs module -> other -> test is not turned into a loop.
  const chain = [t('T-7', 'build', []), t('T-8', 'build', ['T-7']), t('T-10', 'test', ['T-8'])];
  orderTestsAfterBuild(chain, []);
  assert.equal(chain[0].dependsOn.includes('T-10'), false);
});

test('ingest orders the split worker\'s test-first tickets after the build tickets', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const mount = item('mount', { integration: true, files: ['src/routes/r.mjs'], tests: ['tests/routes.test.mjs'], scopeRefs: ['R-001'] });
  await fakeRun(root, 'r1', [item('mod', { dependsOn: ['mod-test'] }), item('mod-test', { type: 'test', acceptance: [], files: ['tests/mod.test.mjs'] }), mount, item('list', { scopeRefs: ['R-002'] }), item('list-mount', { integration: true, files: ['src/routes/list.mjs'], tests: ['tests/list.test.mjs'], scopeRefs: ['R-002'] })]);
  const res = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /note: T-0002: no acceptance lines from the worker; copied 2 from R-001/);
  assert.match(res.stdout, /note: T-0002: test ticket now waits for T-0001/);
  const ledger = await readLedger(root);
  const mod = ledger.tickets.find(x => x.title === 'mod'), test_ = ledger.tickets.find(x => x.title === 'mod-test');
  assert.deepEqual(test_.dependsOn, [mod.id]);
  assert.deepEqual(mod.dependsOn, []);
});

test('a split with modules but no integration ticket is kept, the wire manifest is written, and approval is held; the prompt asks for acceptance and test order', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await fakeRun(root, 'r1', [item('mod'), item('list', { scopeRefs: ['R-002'] }), item('list-mount', { integration: true, files: ['src/routes/list.mjs'], tests: ['tests/list.test.mjs'], scopeRefs: ['R-002'] })]);
  const res = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(res.exitCode, 0, res.stdout);
  assert.match(res.stdout, /wiring: 1 requirement\(s\).*\(R-001\)/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/wire-manifest.json'), 'utf8'));
  assert.match(manifest.jobs[0].prompt, /Existing module tickets of R-001/);
  assert.deepEqual((await readLedger(root)).pendingWiring, ['R-001']);
  assert.equal(await fs.stat(path.join(root, 'docs/scope/split/manifest.json')).then(() => true, () => false), false, 'the split manifest is not overwritten');
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'])).exitCode, 1);
  const prompt = buildSplitManifest(scope, {}).jobs[0].prompt;
  assert.match(prompt, /at least one acceptance line/);
  assert.match(prompt, /A test never runs before the module it imports exists/);
});

test('a merge that would leave a requirement unwired is refused when the ledger is approved (the running build keeps its approval)', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const wired = (key, req, file) => [item(key, { scopeRefs: [req] }), item(`${key}-mount`, { integration: true, files: [`src/routes/${file}.mjs`], tests: [`tests/${file}.test.mjs`], scopeRefs: [req] })];
  await fakeRun(root, 'r1', wired('a', 'R-001', 'a'));
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  const only = (await readLedger(root)).tickets.filter(x => x.scopeRefs.includes('R-001'));
  assert.ok(only.length);
  // Approve by hand-sealing the half ledger is not needed: a merge of R-002 modules without a mount on an UNapproved ledger is kept.
  await fakeRun(root, 'r2', [item('b', { scopeRefs: ['R-002'] })]);
  const kept = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2', '--merge']);
  assert.equal(kept.exitCode, 0, kept.stdout);
  assert.deepEqual((await readLedger(root)).pendingWiring, ['R-002']);
  const approvedNow = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(approvedNow.exitCode, 1);
  assert.match(approvedNow.stdout, /not approvable: 1 requirement\(s\).*\(R-002\)/);
});

test('review fixes: template reads (names only, exactly the file, no secret folder), a key-looking value, a template word in front of a key extension, and migrations before tests', async () => {
  const { isExampleFile, templateReadable } = await import('../tools/init-profile.mjs');
  assert.equal(isExampleFile('.env.example'), true);
  assert.equal(isExampleFile('config.example.json'), true);
  for (const bad of ['server.example.pem', 'dev.sample.key', 'tls.template.p12', 'id_rsa.example', '.env', '.env.local', '.env.example.bak']) assert.equal(isExampleFile(bad), false, bad);
  const profile = { protectedPaths: ['.env', '.env.example', 'secrets/', 'config/'] };
  assert.equal(templateReadable(profile, '.env.example'), true, 'protected exactly by name: readable');
  assert.equal(templateReadable(profile, 'secrets/x.example.json'), false, 'a secret folder above it');
  assert.equal(templateReadable(profile, 'config/app.example.json'), false, 'a protected folder above it');
  assert.equal(templateReadable(profile, '.git/hooks/pre-commit.sample'), false);
  assert.equal(templateReadable(profile, '.env'), false);
  assert.equal(templateReadable({ protectedPaths: [] }, 'app/.env.example'), true);
  const t = (id, type, deps = [], extra = {}) => ({ id, type, status: 'todo', scopeRefs: ['R-001'], dependsOn: deps, ...extra });
  const added = [t('T-1', 'test', []), t('T-2', 'migration', [])];
  orderTestsAfterBuild(added, []);
  assert.deepEqual(added[0].dependsOn, ['T-2'], 'a test waits for its migration too');
  const indirect = [t('T-1', 'test', []), t('T-2', 'build', ['T-3']), t('T-3', 'docs', ['T-1'])];
  assert.match(orderTestsAfterBuild(indirect, []).join(' '), /T-1: T-2 waits for this test through other tickets/);
});
