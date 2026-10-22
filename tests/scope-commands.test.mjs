import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand, prepareScopeRun, buildSplitManifest, ticketsFromStageLists, parseArgs } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { validateProfile } from '../tools/init-profile.mjs';

const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app with Stripe.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201 in under 300 ms.', '',
  '### R-002 A user can list requests.', 'Acceptance:', '- Returns at most 50 rows.', '',
  '## External', '- Stripe: payments', '', '## Sensitive', '- payments', '', '## Protected', '- .env', ''].join('\n');
const STAGE = [
  { key: 'api', title: 'Contract', type: 'contract', scopeRefs: ['R-001', 'R-002'], files: ['contracts/api.json'], size: 'S', risk: 'low' },
  { key: 'create', title: 'Create endpoint', type: 'build', scopeRefs: ['R-001'], acceptance: ['201'], files: ['src/create.mjs'], dependsOn: ['api'], size: 'S', risk: 'medium' },
  { key: 'list', title: 'List endpoint', type: 'build', scopeRefs: ['R-002'], acceptance: ['50 rows'], files: ['src/list.mjs'], dependsOn: ['api'], size: 'S', risk: 'low' },
  { key: 'mount-create', title: 'Mount create route', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['POST /requests returns 201'], files: ['src/routes/create.mjs'], tests: ['tests/routes-create.test.mjs'], size: 'S', risk: 'low' },
  { key: 'mount-list', title: 'Mount list route', type: 'build', integration: true, scopeRefs: ['R-002'], acceptance: ['GET /requests returns rows'], files: ['src/routes/list.mjs'], tests: ['tests/routes-list.test.mjs'], size: 'S', risk: 'low' },
];

async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-cmd-')));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  return root;
}
async function fakeRun(root, id, items) {
  const ws = '.swarm/workspaces/' + id + '/split-S1';
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), '```json\n' + JSON.stringify(items) + '\n```');
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
}

test('parseArgs separates flags with values from positionals', () => {
  const { flags, rest } = parseArgs(['file.md', '--stage', 'S2', '--yes']);
  assert.deepEqual(rest, ['file.md']);
  assert.equal(flags.stage, 'S2');
  assert.equal(flags.yes, true);
  assert.throws(() => parseArgs(['--stage']), /needs a value/);
});

test('split manifest has one sensitive job per stage and a plain prompt', () => {
  const manifest = buildSplitManifest(parseScope(SCOPE));
  assert.equal(manifest.jobs.length, 1);
  assert.equal(manifest.jobs[0].sensitive, true);
  assert.deepEqual(manifest.jobs[0].outputs, ['docs/scope/split/S1.json']);
  assert.match(manifest.jobs[0].prompt, /R-001/);
  assert.throws(() => buildSplitManifest(parseScope(SCOPE), { stage: 'S9' }), /no requirements/);
});

test('ticketsFromStageLists maps keys to ids and drops invented dependency keys with a note', () => {
  const scope = parseScope(SCOPE);
  const ok = ticketsFromStageLists([{ stage: 'S1', items: STAGE }], scope);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.tickets.map(t => t.id), ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005']);
  assert.deepEqual(ok.tickets[1].dependsOn, ['T-0001']);
  const bad = ticketsFromStageLists([{ stage: 'S1', items: [{ ...STAGE[1], dependsOn: ['nope'] }] }], scope);
  assert.deepEqual(bad.errors, []);
  assert.match(bad.notes[0], /dropped dependsOn keys that name no ticket in the file: nope/);
  assert.deepEqual(bad.tickets[0].dependsOn, []);
});

test('split, approve, go --scope preparation, sync and change order work end to end', async () => {
  const root = await project();
  assert.equal((await runScopeCommand(root, 'scope', ['check'])).exitCode, 0);
  assert.equal((await runScopeCommand(root, 'scope', ['split'])).exitCode, 0);
  await fakeRun(root, 'r1', STAGE);
  const ingest = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(ingest.exitCode, 0, ingest.stdout);
  assert.match(ingest.stdout, /coverage 100%/);
  await assert.rejects(prepareScopeRun(root, {}), /not approved/);
  const preview = await runScopeCommand(root, 'scope', ['approve']);
  assert.match(preview.stdout, /swarm scope approve --yes/);
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'])).exitCode, 0);
  const plan = await fs.readFile(path.join(root, 'docs/scope/build-plan.md'), 'utf8');
  assert.match(plan, /R-001/);
  const wave = await prepareScopeRun(root, {});
  assert.deepEqual(wave.ids, ['T-0001']);
  assert.equal(wave.humans, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(root, wave.file), 'utf8'));
  assert.equal(manifest.jobs[0].id, 'T-0001');
  await fs.mkdir(path.join(root, '.swarm/runs/r2'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r2/state.json'), JSON.stringify({ id: 'r2', jobs: [{ id: 'T-0001', status: 'complete' }] }));
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r2'])).stdout, /1 ticket\(s\) in review/);
  assert.equal((await runScopeCommand(root, 'scope', ['sync', 'r2', '--integrated'])).exitCode, 1);
  await fs.writeFile(path.join(root, '.swarm/runs/r2/state.json'), JSON.stringify({ id: 'r2', integratedAt: 'now', jobs: [{ id: 'T-0001', status: 'complete' }] }));
  assert.match((await runScopeCommand(root, 'scope', ['sync', 'r2', '--integrated'])).stdout, /1 ticket\(s\) marked done/);
  const list = await runScopeCommand(root, 'tickets', ['--status', 'done', '--json']);
  assert.equal(JSON.parse(list.stdout).length, 1);
  assert.equal((await runScopeCommand(root, 'tickets', ['T-0003', '--set', 'blocked', '--yes'])).exitCode, 0);
  assert.equal((await runScopeCommand(root, 'tickets', ['T-0003', '--set', 'done'])).exitCode, 1);

  const scopePath = path.join(root, 'docs/scope/scope.md');
  await fs.writeFile(scopePath, SCOPE.replace('## External', '### R-003 A user can cancel a request.\nAcceptance:\n- Cancelling returns 200.\n\n## External'));
  await assert.rejects(prepareScopeRun(root, {}), /changed since approval/);
  const review = await runScopeCommand(root, 'change', ['add cancel']);
  assert.match(review.stdout, /\+1 added/);
  assert.match(review.stdout, /rerun with --yes/);
  const done = await runScopeCommand(root, 'change', ['add cancel', '--yes']);
  assert.match(done.stdout, /recorded CO-001/);
  await fs.rm(path.join(root, 'docs/scope/split'), { recursive: true, force: true });
  assert.equal((await runScopeCommand(root, 'scope', ['split'])).exitCode, 0);
  const again = JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/manifest.json'), 'utf8'));
  assert.match(again.jobs[0].prompt, /R-003/);
  assert.doesNotMatch(again.jobs[0].prompt, /^R-001: /m);
});

test('ingest refuses a bad ticket file and writes no ledger', async () => {
  const root = await project();
  await fakeRun(root, 'r1', [{ key: 'x', title: 'No refs', type: 'build', files: ['a.mjs'], size: 'L', risk: 'low' }]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /parked: 1 ticket\(s\)/);
  await assert.rejects(fs.access(path.join(root, '.swarm/project/tickets.json')));
});

test('approve refuses when the scope changed after the split', async () => {
  const root = await project();
  await fakeRun(root, 'r1', STAGE);
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE.replace('Demo app', 'Other app'));
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /changed after the split/);
});

test('scope contracts generates a working set of files', async () => {
  const root = await project();
  const doc = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/items': { get: { operationId: 'listItems', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Item' } } } } } } } } }, components: { schemas: { Item: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } } };
  await fs.mkdir(path.join(root, 'contracts'), { recursive: true });
  await fs.writeFile(path.join(root, 'contracts/api.json'), JSON.stringify(doc));
  const asked = await runScopeCommand(root, 'scope', ['contracts', 'contracts/api.json']);
  assert.equal(asked.exitCode, 1);
  assert.match(asked.stdout, /needs your approval/);
  const result = await runScopeCommand(root, 'scope', ['contracts', 'contracts/api.json', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal((await runScopeCommand(root, 'scope', ['contracts', 'contracts/api.json'])).exitCode, 1);
  for (const name of ['types.d.ts', 'validators.mjs', 'client.mjs', 'mock-server.mjs', 'seed.json', 'contract.test.mjs']) await fs.access(path.join(root, 'contracts', name));
  const bad = await runScopeCommand(root, 'scope', ['contracts', 'contracts/missing.json', '--yes']);
  assert.equal(bad.exitCode, 1);
});

test('profile accepts a valid approval block and rejects an unknown key', () => {
  assert.deepEqual(validateProfile({ approval: { changeOrderOverUsd: 5 } }).errors, []);
  assert.match(validateProfile({ approval: { nope: 1 } }).errors[0], /profile\.approval/);
});

async function approvedProject() {
  const root = await project();
  await fakeRun(root, 'r1', STAGE);
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'])).exitCode, 0);
  return root;
}

test('merging new tickets clears the approval, so go --scope refuses until you approve again', async () => {
  const root = await approvedProject();
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE.replace('## External', '### R-003 A user can cancel a request.\nAcceptance:\n- Cancelling returns 200.\n\n## External'));
  assert.match((await runScopeCommand(root, 'change', ['add cancel', '--yes'])).stdout, /recorded CO-001/);
  await prepareScopeRun(root, {}).then(() => {}, () => assert.fail('approval must survive the change order'));
  await fakeRun(root, 'r3', [{ key: 'cancel', title: 'Cancel endpoint', type: 'build', scopeRefs: ['R-003'], acceptance: ['200'], files: ['src/cancel.mjs'], size: 'S', risk: 'low' }, { key: 'mount', title: 'Mount cancel route', type: 'build', integration: true, scopeRefs: ['R-003'], acceptance: ['route'], files: ['src/routes/cancel.mjs'], tests: ['tests/cancel-route.test.mjs'], size: 'S', risk: 'low' }]);
  const merged = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r3', '--merge']);
  assert.equal(merged.exitCode, 0, merged.stdout);
  await assert.rejects(prepareScopeRun(root, {}), /not approved/);
});

test('go --scope refuses when the approved scope file is missing or the ticket set was edited', async () => {
  const root = await approvedProject();
  const ledgerFile = path.join(root, '.swarm/project/tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  ledger.tickets[1].acceptance.push('also delete everything');
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  await assert.rejects(prepareScopeRun(root, {}), /not approved/);
  const second = await approvedProject();
  await fs.rm(path.join(second, 'docs/scope/scope.md'));
  await assert.rejects(prepareScopeRun(second, {}), /is missing/);
});

test('only one go --scope wave starts at a time', async () => {
  const root = await approvedProject();
  const lock = path.join(root, '.swarm/project/scope-go.lock');
  await fs.writeFile(lock, '');
  await assert.rejects(prepareScopeRun(root, {}), /another swarm go --scope/);
  await fs.rm(lock);
  assert.deepEqual((await prepareScopeRun(root, {})).ids, ['T-0001']);
  await assert.rejects(fs.access(lock));
});

test('go --scope marks tickets running in one write and rejects a bad max-jobs', async () => {
  const root = await approvedProject();
  await assert.rejects(prepareScopeRun(root, { maxJobs: 0 }), /max-jobs|maxJobs/i);
  const ledger = JSON.parse(await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8'));
  assert.equal(ledger.tickets.filter(t => t.status === 'running').length, 0);
});

test('ingest rejects hostile run ids, duplicate keys, wrong field types and huge ticket files', async () => {
  const root = await project();
  for (const id of ['../x', '..', 'a/b', '']) {
    const r = await runScopeCommand(root, 'scope', ['split', '--ingest', id || '.']).catch(error => ({ exitCode: 1, stdout: String(error) }));
    assert.equal(r.exitCode, 1);
  }
  const scope = parseScope(SCOPE);
  const dup = ticketsFromStageLists([{ stage: 'S1', items: [STAGE[0], STAGE[0]] }], scope);
  assert.match(dup.errors.join('\n'), /duplicate key/);
  const wrong = ticketsFromStageLists([{ stage: 'S1', items: [{ ...STAGE[1], files: 'src/a.mjs', dependsOn: [] }] }], scope);
  assert.match(wrong.errors.join('\n'), /arrays of strings/);
  await fakeRun(root, 'big', Array.from({ length: 2001 }, (_, i) => ({ ...STAGE[2], key: `k${i}` })));
  const r = await runScopeCommand(root, 'scope', ['split', '--ingest', 'big']);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /more than 2000/);
});

test('a ticket is sensitive when its requirement text names a Sensitive entry, even if the worker says false', () => {
  const scope = parseScope(SCOPE.replace('A user can list requests.', 'A user can pay with payments and cards.'));
  const { tickets } = ticketsFromStageLists([{ stage: 'S1', items: [{ ...STAGE[2], sensitive: false, title: 'Plain title', acceptance: ['ok'] }] }], scope);
  assert.equal(tickets[0].sensitive, true);
});

test('writes never follow a symlink at the target file', async () => {
  const root = await project();
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'outside-')), 'victim.md');
  await fs.writeFile(outside, 'keep');
  await fs.symlink(outside, path.join(root, 'docs/scope/build-plan.md'));
  await fakeRun(root, 'r1', STAGE);
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  await runScopeCommand(root, 'scope', ['approve', '--yes']).catch(() => {});
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  await fs.symlink(path.join(root, 'nowhere.md'), path.join(root, 'docs/scope/linked.md'));
  const r = await runScopeCommand(root, 'scope', ['template', '--out', 'docs/scope/linked.md']).catch(() => ({ exitCode: 1 }));
  assert.equal(r.exitCode, 1);
  await assert.rejects(fs.access(path.join(root, 'nowhere.md')));
});

test('skeleton first: only the skeleton (and its dependencies) runs until it is done, --skip-skeleton overrides', async () => {
  const root = await project();
  const stage = [
    { key: 'api', title: 'Contract', type: 'contract', scopeRefs: ['R-001', 'R-002'], files: ['contracts/api.json'], size: 'S', risk: 'low' },
    { key: 'create', title: 'Create endpoint', type: 'build', scopeRefs: ['R-001'], acceptance: ['201'], files: ['src/create.mjs'], dependsOn: ['api'], size: 'S', risk: 'medium', skeleton: true },
    { key: 'list', title: 'List endpoint', type: 'build', scopeRefs: ['R-002'], acceptance: ['50 rows'], files: ['src/list.mjs'], dependsOn: ['api'], size: 'S', risk: 'low' },
    { key: 'mount-create', title: 'Mount create route', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['route works'], files: ['src/routes/create.mjs'], tests: ['tests/routes-create.test.mjs'], size: 'S', risk: 'low' },
    { key: 'mount-list', title: 'Mount list route', type: 'build', integration: true, scopeRefs: ['R-002'], acceptance: ['route works'], files: ['src/routes/list.mjs'], tests: ['tests/routes-list.test.mjs'], size: 'S', risk: 'low' },
  ];
  await fakeRun(root, 'r1', stage);
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  await runScopeCommand(root, 'scope', ['approve', '--yes']);
  const first = await prepareScopeRun(root, {});
  assert.deepEqual(first.ids, ['T-0001']);
  const ledgerFile = path.join(root, '.swarm/project/tickets.json');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  ledger.tickets.find(t => t.id === 'T-0001').status = 'done';
  await fs.writeFile(ledgerFile, JSON.stringify(ledger));
  const second = await prepareScopeRun(root, {});
  assert.deepEqual(second.ids, ['T-0002']);
  const again = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  again.tickets.find(t => t.id === 'T-0002').status = 'todo';
  await fs.writeFile(ledgerFile, JSON.stringify(again));
  const skipped = await prepareScopeRun(root, { skipSkeleton: true });
  assert.deepEqual(skipped.ids.sort(), ['T-0002', 'T-0003']);
});

test('a ledger of 30 or more tickets without a skeleton gets a warning', async () => {
  const root = await project();
  const items = Array.from({ length: 31 }, (_, i) => ({ key: `k${i}`, title: `Ticket ${i}`, type: 'build', scopeRefs: ['R-001', 'R-002'][i % 2] ? [['R-001', 'R-002'][i % 2]] : [], acceptance: ['ok'], files: [`src/f${i}.mjs`], size: 'S', risk: 'low' }));
  items.push({ key: 'm1', title: 'Mount one', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['ok'], files: ['src/routes/one.mjs'], tests: ['tests/one.test.mjs'], size: 'S', risk: 'low' }, { key: 'm2', title: 'Mount two', type: 'build', integration: true, scopeRefs: ['R-002'], acceptance: ['ok'], files: ['src/routes/two.mjs'], tests: ['tests/two.test.mjs'], size: 'S', risk: 'low' });
  await fakeRun(root, 'r1', items);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.match(result.stdout, /warning: no skeleton tickets/);
});
