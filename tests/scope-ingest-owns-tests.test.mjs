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
  '# Scope: Build-owned tests',
  'Version: 1',
  '',
  '## Overview',
  'Build tickets may own the tests that prove them.',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 A feature works.',
  'Acceptance:',
  '- `tests/feature.test.mjs` proves the feature.',
  '',
  '## External',
  '',
  '## Sensitive',
  '',
  '## Protected',
  '- .env',
  '',
].join('\n');

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-ingest-owns-tests-')));
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
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({
    id,
    jobs: [{ id: 'split-S1', status: 'complete', workspace }],
  }));
}

const build = (over = {}) => ({
  key: 'build',
  title: 'Build feature',
  type: 'build',
  scopeRefs: ['R-001'],
  acceptance: ['`tests/feature.test.mjs` proves the feature.'],
  files: ['src/feature.mjs'],
  tests: ['tests/feature.test.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

const integration = (over = {}) => ({
  key: 'integration',
  title: 'Integrate feature',
  type: 'build',
  integration: true,
  scopeRefs: ['R-001'],
  acceptance: ['`src/routes/public/items.ts` returns 200.'],
  files: ['src/routes/public/items.ts'],
  tests: ['tests/route.test.mjs'],
  dependsOn: ['build'],
  size: 'S',
  risk: 'low',
  ...over,
});

test('ingest accepts a build-owned test as acceptance proof and reports the shorter path', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [build(), integration()]);

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /acceptance is not provable/);
  assert.doesNotMatch(result.stdout, /features are not wired/);
  assert.match(result.stdout, /critical path: 2 tickets/);
  assert.match(result.stdout, /test-first would be 4/);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.find(ticket => ticket.type === 'build' && !ticket.integration).tests[0], 'tests/feature.test.mjs');
});

test('ingest prints the ownership note when it repairs test-first ordering', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [
    build({ dependsOn: ['test'] }),
    {
      key: 'test',
      title: 'Test feature',
      type: 'test',
      scopeRefs: ['R-001'],
      acceptance: ['works'],
      files: ['tests/feature.test.mjs'],
      size: 'S',
      risk: 'low',
    },
    integration(),
  ]);

  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);

  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /T-0001: owns its tests; no longer waits on T-0002/);
});
