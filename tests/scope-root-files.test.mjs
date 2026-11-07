// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ticketsFromStageLists, runScopeCommand, runTicketsCommand } from '../tools/scope-commands.mjs';
import { parseScope } from '../tools/scope.mjs';
import { createLedger, readLedger, writeLedger } from '../tools/tickets.mjs';

const SCOPE = [
  '# Scope: Root files',
  'Version: 1',
  'Root files: HEADER-MANIFEST.json',
  '',
  '## Overview', 'A root-file ingest fixture.',
  '',
  '## Stages', '- S1: Core',
  '',
  '## S1 Core', '### R-001 A feature works.', 'Acceptance:', '- It works.',
  '',
  '## External', '', '## Sensitive', '', '## Protected', '- .env',
  '',
].join('\n');

const item = (over = {}) => ({
  key: 'work', title: 'Work', type: 'build', scopeRefs: ['R-001'], acceptance: ['works'],
  files: ['src/work.mjs'], size: 'S', risk: 'low', ...over,
});

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-root-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  return root;
}

async function fakeRun(root, id, items) {
  const workspace = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, workspace, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, workspace, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace }] }));
}

test('a configured root file is accepted and an unlisted root file rejects only its ticket', () => {
  const scope = parseScope(SCOPE);
  const result = ticketsFromStageLists([{ stage: 'S1', items: [
    item({ key: 'manifest', title: 'Release manifest', files: ['RELEASE-MANIFEST.json'] }),
    item({ key: 'other', title: 'Other root file', files: ['OTHER-MANIFEST.json'] }),
  ] }], scope, { rootFiles: ['RELEASE-MANIFEST.json'] });
  assert.deepEqual(result.tickets.map(ticket => ticket.title), ['Release manifest']);
  assert.deepEqual(result.rejected, [{ id: 'T-0002', title: 'Other root file', reason: 'OTHER-MANIFEST.json has no folder; give it its real path (for example src/... or supabase/migrations/...)' }]);
});

test('a rejected ticket rejects its dependent while the remaining split is ingested and journaled', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ scopeRootFiles: ['RELEASE-MANIFEST.json', '.env.local', 'bad/name', 42] }));
  await fakeRun(root, 'r1', [
    item({ key: 'bad', title: 'Bad root output', files: ['UNLISTED.json'] }),
    item({ key: 'dependent', title: 'Dependent output', dependsOn: ['bad'] }),
    item({ key: 'good', title: 'Release output', files: ['RELEASE-MANIFEST.json'] }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /rejected 2 ticket\(s\):/);
  assert.match(result.stdout, /T-0001 .*UNLISTED\.json has no folder/);
  assert.match(result.stdout, /T-0002 .*depends on rejected T-0001/);
  const ledger = await readLedger(root);
  assert.deepEqual(ledger.tickets.filter(ticket => ticket.stage === 'S1').map(ticket => ticket.title), ['Release output']);
  const log = (await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const ingest = log.find(entry => entry.event === 'split');
  assert.deepEqual(ingest.rejected.map(entry => entry.id), ['T-0001', 'T-0002']);
  assert.match(result.stdout, /ignored invalid entry/);
});

test('the scope header root-file override is used by ticket edits', async t => {
  const root = await project(t);
  const ledger = createLedger({ scope: { name: 'Root files', version: 1, hash: 'a'.repeat(64), file: 'docs/scope/scope.md' }, tickets: [{
    id: 'T-0001', title: 'Edit root output', type: 'build', stage: 'S1', epic: 'E-00', scopeRefs: ['R-001'], acceptance: ['works'],
    files: ['src/work.mjs'], context: [], contracts: [], tests: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo',
  }] });
  await writeLedger(root, ledger);
  const result = await runTicketsCommand(root, ['T-0001', '--files', 'HEADER-MANIFEST.json', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.deepEqual((await readLedger(root)).tickets[0].files, ['HEADER-MANIFEST.json']);
});
