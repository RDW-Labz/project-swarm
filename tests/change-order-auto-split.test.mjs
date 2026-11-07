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
  '# Scope: Change order auto split',
  'Version: 1',
  '',
  '## Overview',
  'Demo app.',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 A user can create a request.',
  'Acceptance:',
  '- Returns 201.',
  '',
  '### R-002 A user can list requests.',
  'Acceptance:',
  '- Returns rows.',
  '',
  '## External',
  '',
  '## Sensitive',
  '',
  '## Protected',
  '- .env',
  '',
].join('\n');

const STAGE = [
  { key: 'api', title: 'Contract', type: 'contract', scopeRefs: ['R-001', 'R-002'], files: ['contracts/api.json'], size: 'S', risk: 'low' },
  { key: 'create', title: 'Create endpoint', type: 'build', scopeRefs: ['R-001'], acceptance: ['201'], files: ['src/create.mjs'], dependsOn: ['api'], size: 'S', risk: 'medium' },
  { key: 'list', title: 'List endpoint', type: 'build', scopeRefs: ['R-002'], acceptance: ['rows'], files: ['src/list.mjs'], dependsOn: ['api'], size: 'S', risk: 'low' },
  { key: 'mount-create', title: 'Mount create route', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['POST works'], files: ['src/routes/create.mjs'], tests: ['tests/routes-create.test.mjs'], size: 'S', risk: 'low' },
  { key: 'mount-list', title: 'Mount list route', type: 'build', integration: true, scopeRefs: ['R-002'], acceptance: ['GET works'], files: ['src/routes/list.mjs'], tests: ['tests/routes-list.test.mjs'], size: 'S', risk: 'low' },
];

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

async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({
    id,
    jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }],
  }));
}

async function approvedProject(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co-auto-split-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await gitRepo(root, [
    'contracts/api.json',
    'src/create.mjs',
    'src/list.mjs',
    'src/routes/create.mjs',
    'src/routes/list.mjs',
    'tests/routes-create.test.mjs',
    'tests/routes-list.test.mjs',
    'src/cancel.mjs',
    'src/routes/cancel.mjs',
    'tests/cancel-route.test.mjs',
  ]);
  await fakeRun(root, 'r1', STAGE);
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'])).exitCode, 0);
  return root;
}

const cancelTickets = () => [
  { key: 'cancel', title: 'Cancel endpoint', type: 'build', scopeRefs: ['R-003'], acceptance: ['200'], files: ['src/cancel.mjs'], size: 'S', risk: 'low' },
  { key: 'mount', title: 'Mount cancel route', type: 'build', integration: true, scopeRefs: ['R-003'], acceptance: ['route'], files: ['src/routes/cancel.mjs'], tests: ['tests/cancel-route.test.mjs'], size: 'S', risk: 'low' },
];

function repairRunSplit(root, fixtures) {
  let calls = 0;
  return {
    calls: () => calls,
    runSplit: async (projectRoot, manifest) => {
      calls += 1;
      const id = `co-split-${calls}`;
      const stages = {};
      for (const job of manifest.jobs ?? []) {
        const stage = job.id.replace(/^split-/, '');
        const fix = fixtures[stage];
        if (fix) stages[stage] = typeof fix === 'function' ? fix(calls) : fix;
      }
      await fakeRun(projectRoot, id, stages.S1 ?? cancelTickets());
      return { id };
    },
  };
}

test('change --yes auto-splits pending requirements into the ledger', async t => {
  const root = await approvedProject(t);
  const scopePath = path.join(root, 'docs/scope/scope.md');
  const text = await fs.readFile(scopePath, 'utf8');
  await fs.writeFile(scopePath, text.replace('## External', '### R-003 A user can cancel a request.\nAcceptance:\n- Cancelling returns 200.\n\n## External'));
  const split = repairRunSplit(root, { S1: cancelTickets() });
  const result = await runScopeCommand(root, 'change', ['add cancel', '--yes'], { runSplit: split.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.ok(split.calls() >= 1);
  assert.match(result.stdout, /recorded CO-001/);
  assert.match(result.stdout, /repair rounds:|ledger written/);
  const ledger = await readLedger(root);
  assert.ok(ledger.tickets.some(ticket => ticket.scopeRefs?.includes('R-003') && ticket.status !== 'cancelled'));
});

test('change --yes parks a bad ticket and ingests good ones', async t => {
  const root = await approvedProject(t);
  const scopePath = path.join(root, 'docs/scope/scope.md');
  const text = await fs.readFile(scopePath, 'utf8');
  await fs.writeFile(scopePath, text.replace('## External', '### R-003 A user can cancel a request.\nAcceptance:\n- Cancelling returns 200.\n\n## External'));
  const split = repairRunSplit(root, {
    S1: [
      { key: 'good', title: 'Cancel endpoint', type: 'build', scopeRefs: ['R-003'], acceptance: ['200'], files: ['src/cancel.mjs'], size: 'S', risk: 'low' },
      { key: 'bad', title: 'Huge bad', type: 'build', scopeRefs: ['R-003'], acceptance: ['nope'], files: ['src/other.mjs'], size: 'L', risk: 'low' },
      { key: 'mount', title: 'Mount cancel route', type: 'build', integration: true, scopeRefs: ['R-003'], acceptance: ['route'], files: ['src/routes/cancel.mjs'], tests: ['tests/cancel-route.test.mjs'], size: 'S', risk: 'low', dependsOn: ['good'] },
    ],
  });
  const result = await runScopeCommand(root, 'change', ['add cancel', '--yes', '--max-repairs', '0'], { runSplit: split.runSplit });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /parked:/);
  const ledger = await readLedger(root);
  assert.ok(ledger.tickets.some(ticket => ticket.id === 'T-0006' || (ticket.scopeRefs?.includes('R-003') && ticket.files?.includes('src/cancel.mjs'))));
  const events = await readJournal(root, { kinds: ['blocker'] });
  assert.ok(events.some(event => event.id?.startsWith('split-park-')));
});

test('change --no-split prints manual steps and does not run split', async t => {
  const root = await approvedProject(t);
  const scopePath = path.join(root, 'docs/scope/scope.md');
  const text = await fs.readFile(scopePath, 'utf8');
  await fs.writeFile(scopePath, text.replace('## External', '### R-003 A user can cancel a request.\nAcceptance:\n- Cancelling returns 200.\n\n## External'));
  let calls = 0;
  const result = await runScopeCommand(root, 'change', ['add cancel', '--yes', '--no-split'], {
    runSplit: async () => { calls += 1; return { id: 'nope' }; },
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(calls, 0);
  assert.match(result.stdout, /swarm scope split, run it, then swarm scope split --ingest RUN --merge/);
  const ledger = await readLedger(root);
  assert.ok(!ledger.tickets.some(ticket => ticket.scopeRefs?.includes('R-003')));
});
