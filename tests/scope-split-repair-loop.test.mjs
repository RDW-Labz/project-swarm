// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger } from '../tools/tickets.mjs';
import { readJournal } from '../tools/journal.mjs';

const execFileAsync = promisify(execFile);

const SCOPE = [
  '# Scope: Split repair loop',
  'Version: 1',
  '',
  '## Overview',
  'Split ingest self-corrects through repair rounds.',
  '',
  '## Stages',
  '- S1: Core',
  '- S2: More',
  '',
  '## S1 Core',
  '### R-001 A module works.',
  'Acceptance:',
  '- It works.',
  '',
  '## S2 More',
  '### R-002 Another module works.',
  'Acceptance:',
  '- It also works.',
  '',
  '## External',
  '',
  '## Sensitive',
  '',
  '## Protected',
  '- .env',
  '',
].join('\n');

async function gitRepo(root, tracked) {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  for (const rel of tracked) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `// ${rel}\n`);
  }
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: root });
}

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-split-repair-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await gitRepo(root, [
    'src/base.mjs',
    'src/module.mjs',
    'src/mod.mjs',
    'src/shared.mjs',
    'tests/routes/module.test.mjs',
    'tests/routes/mod.test.mjs',
  ]);
  return root;
}

async function fakeRun(root, id, stages) {
  const jobs = [];
  for (const [stage, items] of Object.entries(stages)) {
    const workspace = `.swarm/workspaces/${id}/split-${stage}`;
    await fs.mkdir(path.join(root, workspace, 'docs/scope/split'), { recursive: true });
    await fs.writeFile(path.join(root, workspace, 'docs/scope/split', `${stage}.json`), JSON.stringify(items));
    jobs.push({ id: `split-${stage}`, status: 'complete', workspace });
  }
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs }));
}

const build = (over = {}) => ({
  key: 'build',
  title: 'Build module',
  type: 'build',
  scopeRefs: ['R-001'],
  acceptance: ['works'],
  files: ['src/module.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

const integration = (over = {}) => ({
  key: 'wire',
  title: 'Wire module',
  type: 'build',
  scopeRefs: ['R-001'],
  integration: true,
  acceptance: ['route works'],
  files: ['src/routes/module.mjs'],
  tests: ['tests/routes/module.test.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

const testTicket = (over = {}) => ({
  key: 'test',
  title: 'Test module',
  type: 'test',
  scopeRefs: ['R-001'],
  acceptance: ['tests pass'],
  files: ['tests/module.test.mjs'],
  context: ['src/module.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

function repairRunSplit(fixtures) {
  let calls = 0;
  return {
    calls: () => calls,
    runSplit: async (root, manifest) => {
      calls += 1;
      const id = `repair-${calls}`;
      const stages = {};
      for (const job of manifest.jobs ?? []) {
        const stage = job.id.replace(/^split-/, '');
        const fix = fixtures[stage];
        if (fix) stages[stage] = typeof fix === 'function' ? fix(calls) : fix;
      }
      await fakeRun(root, id, stages);
      return { id };
    },
  };
}

test('future context is repaired in one round and every ticket lands in the ledger', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [
      build(),
      testTicket({ context: ['src/orphan.mjs'], dependsOn: ['build'] }),
    ],
  });
  const repair = repairRunSplit({
    S1: () => [build(), testTicket({ context: ['src/module.mjs'], dependsOn: ['build'] }), integration()],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'], { runSplit: repair.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.ok(repair.calls() <= 1);
  assert.match(result.stdout, /repair rounds:/);
  const ledger = await readLedger(root);
  const testRow = ledger.tickets.find(ticket => ticket.type === 'test');
  assert.ok(testRow);
  assert.ok(testRow.context.includes('src/module.mjs'));
});

test('same-wave shared file is repaired in one round', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [
      build({ key: 'a', files: ['src/shared.mjs'] }),
      build({ key: 'b', files: ['src/shared.mjs'] }),
    ],
  });
  const repair = repairRunSplit({
    S1: (round) => [
      build({ key: 'a', files: ['src/shared.mjs'] }),
      build({ key: 'b', files: ['src/shared.mjs'], dependsOn: ['a'] }),
      integration(),
    ],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'], { runSplit: repair.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.ok(repair.calls() <= 1);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.filter(ticket => ticket.type === 'build' && !ticket.integration).length, 2);
});

test('test after code is repaired in one round', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [build()],
    S2: [testTicket()],
  });
  const repair = repairRunSplit({
    S2: [testTicket({ dependsOn: ['build'] }), integration()],
    S1: [build()],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'], { runSplit: repair.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.ok(repair.calls() <= 1);
  const ledger = await readLedger(root);
  const moved = ledger.tickets.find(ticket => ticket.type === 'test');
  assert.equal(moved.stage, 'S1');
});

test('missing integration ticket is repaired in one round', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', { S1: [build({ files: ['src/mod.mjs'] })] });
  const repair = repairRunSplit({
    S1: [build({ files: ['src/mod.mjs'] }), integration({ files: ['src/routes/mod.mjs'], tests: ['tests/routes/mod.test.mjs'] })],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'], { runSplit: repair.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.ok(repair.calls() <= 1);
  const ledger = await readLedger(root);
  assert.ok(ledger.tickets.some(ticket => ticket.integration === true));
});

test('--max-repairs 0 parks a bad ticket, ingests good ones, and skips runSplit', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [
      build({ key: 'good', files: ['src/module.mjs'] }),
      build({ key: 'bad', files: ['src/mod.mjs'], scopeRefs: ['R-002'], size: 'L' }),
    ],
  });
  let calls = 0;
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1', '--max-repairs', '0'], {
    runSplit: async () => { calls += 1; return { id: 'nope' }; },
  });
  assert.equal(calls, 0);
  assert.match(result.stdout, /T-0002.*size L/);
  assert.match(result.stdout, /ledger written: 1 tickets/);
  const ledger = await readLedger(root);
  assert.ok(ledger.tickets.some(ticket => ticket.id === 'T-0001'));
  assert.ok(!ledger.tickets.some(ticket => ticket.scopeRefs?.includes('R-002')));
  const events = await readJournal(root, { kinds: ['blocker'] });
  assert.ok(events.some(event => event.id?.startsWith('split-park-')));
});

test('no-progress repair parks and reports rounds', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', { S1: [build({ files: ['src/mod.mjs'] })] });
  const repair = repairRunSplit({ S1: [build({ files: ['src/mod.mjs'] })] });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'], { runSplit: repair.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /repair rounds: 1/);
  assert.match(result.stdout, /wiring: 1 requirement\(s\) have modules but no integration ticket/);
  assert.equal(repair.calls(), 1);
  const ledger = await readLedger(root);
  assert.ok(ledger.tickets.some(ticket => ticket.type === 'build' && ticket.integration !== true));
  assert.ok(!ledger.tickets.some(ticket => ticket.integration === true));
});

test('ingest appendLog records a split-repair event for each repair round', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', { S1: [build({ files: ['src/mod.mjs'] })] });
  const repair = repairRunSplit({
    S1: [build({ files: ['src/mod.mjs'] }), integration({ files: ['src/routes/mod.mjs'], tests: ['tests/routes/mod.test.mjs'] })],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'], { runSplit: repair.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /repair rounds: 1/);
  const log = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  const events = log.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'split-repair');
  assert.equal(events.length, 1);
  assert.equal(events[0].round, 0);
  assert.ok(events[0].errorsIn >= 1);
  assert.equal(events[0].errorsLeft, 0);
});

test('a ticket writing coordination/checks.json is routed to an owner-window human ticket on ingest', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [
      build({ key: 'checks', title: 'Register project checks', files: ['coordination/checks.json'] }),
      integration(),
    ],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  const ledger = await readLedger(root);
  const human = ledger.tickets.find(ticket => ticket.type === 'human');
  assert.ok(human, 'owner-window human ticket');
  assert.deepEqual(human.files, ['coordination/checks.json']);
  assert.match(human.title, /Owner commit window: edit coordination\/checks\.json/);
  const worker = ledger.tickets.find(ticket => ticket.title === 'Register project checks');
  assert.ok(worker);
  assert.ok(worker.dependsOn?.includes(human.id));
  assert.ok(!(worker.files ?? []).includes('coordination/checks.json'));
});

test('change-order merge with a stray ticket is repaired or parked, not refused', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [build(), integration()],
  });
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  await fakeRun(root, 'r2', {
    S1: [build({ key: 'stray', scopeRefs: ['R-001'], files: ['src/extra.mjs'] })],
  });
  const repair = repairRunSplit({
    S1: [build({ key: 'ok', scopeRefs: ['R-002'], files: ['src/other.mjs'] }), integration({ scopeRefs: ['R-002'], files: ['src/routes/other.mjs'], tests: ['tests/routes/other.test.mjs'] })],
  });
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2', '--merge'], { runSplit: repair.runSplit });
  assert.doesNotMatch(result.stdout, /split refused/);
  assert.match(result.stdout, /repair rounds:|parked:|ledger written/);
});
