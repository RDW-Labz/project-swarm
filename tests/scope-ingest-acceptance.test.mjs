// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger } from '../tools/tickets.mjs';

const SCOPE = [
  '# Scope: Acceptance paths', 'Version: 1', '',
  '## Overview', 'Check acceptance against ticket outputs.', '',
  '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A feature works.', 'Acceptance:', '- `src/routes/public/items.ts` returns 200.', '',
  '## External', '', '## Sensitive', '', '## Protected', '- .env', '',
].join('\n');

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-ingest-acceptance-')));
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

const build = (over = {}) => ({ key: 'build', title: 'Build module', type: 'build', scopeRefs: ['R-001'], acceptance: ['works'], files: ['src/module.mjs'], size: 'S', risk: 'low', ...over });

test('ingest refuses a build acceptance path that no ticket owns', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [build({ acceptance: ['`src/other.mjs` is exported'] })]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /T-0001: acceptance line 1 names src\/other\.mjs, owned by nobody/);
  assert.equal(await readLedger(root), null);
});

test('copied requirement acceptance is deferred until an integration ticket exists', async t => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/route.test.mjs'), 'test');
  await fakeRun(root, 'r1', [
    build(),
    { key: 'test', title: 'Check route', type: 'test', scopeRefs: ['R-001'], files: [], tests: ['tests/route.test.mjs'], dependsOn: ['build'], size: 'S', risk: 'low' },
  ]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /acceptance deferred until its integration ticket exists/);
  const ledger = await readLedger(root);
  const copied = ledger.tickets.find(ticket => ticket.type === 'test');
  assert.equal(copied.acceptanceDeferred, true);
  assert.deepEqual(copied.acceptance, ['`src/routes/public/items.ts` returns 200.']);
});
