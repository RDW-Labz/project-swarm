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

const execFileAsync = promisify(execFile);

const SCOPE = [
  '# Scope: Split ingest guards',
  'Version: 1',
  '',
  '## Overview',
  'Split ingest repairs test stages, context and protected outputs.',
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-split-guards-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await gitRepo(root, ['src/base.mjs', 'coordination/checks.json']);
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

test('ingest moves a later-stage test ticket into the build stage and wires dependsOn', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [build()],
    S2: [testTicket()],
  });

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /moved T-0002 into stage S1 with the code it tests/);
  const ledger = await readLedger(root);
  const moved = ledger.tickets.find(ticket => ticket.type === 'test');
  assert.equal(moved.stage, 'S1');
  assert.ok(moved.dependsOn.includes('T-0001'));
});

test('ingest rejects a later-stage test ticket when no build matches its context', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [build()],
    S2: [testTicket({ scopeRefs: ['R-002'], context: ['src/missing.mjs'] })],
  });

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /rejected 1 ticket\(s\):/);
  assert.match(result.stdout, /T-0002 .*no matching build ticket/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.filter(ticket => ticket.type === 'test').length, 0);
});

test('ingest drops orphan context but keeps dependsOn-produced context', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [
      build(),
      testTicket({
        dependsOn: ['build'],
        context: ['src/module.mjs', 'src/orphan.mjs'],
      }),
    ],
  });

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /dropped context src\/orphan\.mjs: it does not exist yet and no earlier ticket creates it/);
  const ledger = await readLedger(root);
  const testRow = ledger.tickets.find(ticket => ticket.type === 'test');
  assert.deepEqual(testRow.context, ['src/module.mjs']);
});

test('ingest peels coordination/checks.json into an owner commit window human ticket', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', {
    S1: [build({
      key: 'checks',
      title: 'Update checks manifest',
      files: ['coordination/checks.json', 'src/module.mjs'],
    })],
  });

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /removed protected output coordination\/checks\.json/);
  const ledger = await readLedger(root);
  const worker = ledger.tickets.find(ticket => ticket.type === 'build');
  const human = ledger.tickets.find(ticket => ticket.type === 'human');
  assert.ok(human);
  assert.match(human.title, /Owner commit window: edit coordination\/checks\.json/);
  assert.deepEqual(worker.files, ['src/module.mjs']);
  assert.ok(worker.dependsOn.includes(human.id));
});

test('ingest still writes a simple single-stage split', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', { S1: [build()] });

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.filter(ticket => ticket.type === 'build').length, 1);
});
