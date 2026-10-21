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
  '# Scope: Store wrapper', 'Version: 1', '',
  '## Overview', 'A store wrapper with a public route.', '',
  '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 List items.', 'Acceptance:', '- Returns rows.', '',
  '## External', '', '## Sensitive', '- store-wrapper', '', '## Protected', '- .env', '',
].join('\n');

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-ingest-sensitive-')));
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

const item = (over = {}) => ({ key: 'work', title: 'Store wrapper', type: 'build', scopeRefs: ['R-001'], acceptance: ['works'], files: ['src/store-wrapper.mjs'], size: 'S', risk: 'low', ...over });

test('store-wrapper wording does not make an unrelated ticket sensitive', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [item()]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  assert.equal((await readLedger(root)).tickets[0].sensitive, false);
});

test('a public API route is sensitive even without a scope phrase', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [item({ files: ['app/api/items/route.ts'] })]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  assert.equal((await readLedger(root)).tickets[0].sensitive, true);
});

test('an explicit sensitive owner value remains true', async t => {
  const root = await project(t);
  await fakeRun(root, 'r1', [item({ sensitive: true })]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  assert.equal((await readLedger(root)).tickets[0].sensitive, true);
});
