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
  '# Scope: Manager gate', 'Version: 1', '', '## Overview', 'A manager-gated scope.', '',
  '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A feature works.', 'Acceptance:', '- It works.', '',
  '## External', '', '## Sensitive', '', '## Protected', '- .env', '',
].join('\n');

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-approve-managers-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const workspace = '.swarm/workspaces/r1/split-S1';
  await fs.mkdir(path.join(root, workspace, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, workspace, 'docs/scope/split/S1.json'), JSON.stringify([
    { key: 'module', title: 'Module', type: 'build', scopeRefs: ['R-001'], acceptance: ['works'], files: ['src/module.mjs'], size: 'S', risk: 'low' },
    { key: 'mount', title: 'Mount route', type: 'build', integration: true, scopeRefs: ['R-001'], acceptance: ['route works'], files: ['src/routes/module.mjs'], tests: ['tests/routes.test.mjs'], size: 'S', risk: 'low' },
  ]));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', jobs: [{ id: 'split-S1', status: 'complete', workspace }] }));
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  return root;
}

const fixedNow = () => 1700000000000;

test('a blocking manager gate refuses approval before the ledger is sealed', async t => {
  const root = await project(t);
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes'], {
    now: fixedNow,
    runManagersScopeGate: async () => ({ run: { status: 'blocked', reason: 'manager found an open decision' } }),
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /manager scope gate: manager found an open decision/);
  assert.equal((await readLedger(root)).approved, null);
});

test('a passing manager gate permits approval', async t => {
  const root = await project(t);
  let seenNow;
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes'], {
    now: fixedNow,
    runManagersScopeGate: async (_root, options) => { seenNow = options.now(); return { run: { status: 'passed' } }; },
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(seenNow, fixedNow());
  assert.ok((await readLedger(root)).approved);
});

test('a manager gate error warns, logs, and still approves', async t => {
  const root = await project(t);
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes'], {
    now: fixedNow,
    runManagersScopeGate: async () => { throw new Error('manager service unavailable'); },
  });
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /warning: manager scope gate failed: manager service unavailable/);
  assert.ok((await readLedger(root)).approved);
  const log = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  assert.match(log, /manager-scope-gate-warning/);
});
