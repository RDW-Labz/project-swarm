// SPDX-License-Identifier: Apache-2.0
// Scenario evals for the lesson 34 leftovers: the route-level test must be a real test file, and integration tickets that share a file are chained.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger } from '../tools/tickets.mjs';
import { looksLikeTestFile } from '../tools/wiring.mjs';

const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '### R-002 A user can list requests.', 'Acceptance:', '- Returns 200.', '', '## Protected', '- .env', ''].join('\n');
const item = (key, refs, extra) => ({ key, title: key, type: 'build', scopeRefs: refs, acceptance: ['ok'], files: [`src/${key}.mjs`], size: 'S', risk: 'low', ...extra });
const mount = (key, ref, extra) => item(key, [ref], { integration: true, files: [`src/routes/${key}.mjs`, 'src/router.mjs'], tests: [`tests/${key}.test.mjs`], ...extra });
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bc-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  return root;
}
async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
}

test('eval 38.1: the route-level test of an integration ticket must be a real test file', async t => {
  const root = await setup(t);
  // Old behavior: any path counted, so a page file named as the "test" passed the wiring rule.
  await fakeRun(root, 'r1', [item('a', ['R-001']), mount('m1', 'R-001', { tests: ['src/app/page.tsx'] }), item('b', ['R-002']), mount('m2', 'R-002', { files: ['src/routes/m2.mjs'] })]);
  const refused = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /R-001: the route-level test of its integration ticket is not a test file \(src\/app\/page\.tsx\)/);
  assert.equal(await readLedger(root), null, 'nothing written');
  for (const ok of ['tests/routes.test.mjs', 'src/a.spec.ts', 'e2e/list.ts', 'tests/test_routes.py', 'pkg/routes_test.go', 'supabase/tests/r1.sql']) assert.equal(looksLikeTestFile(ok), true, ok);
  for (const bad of ['src/app/page.tsx', 'src/routes/list.mjs', 'tests/', '', undefined]) assert.equal(looksLikeTestFile(bad), false, String(bad));
  await fakeRun(root, 'r2', [item('a', ['R-001']), mount('m1', 'R-001'), item('b', ['R-002']), mount('m2', 'R-002', { files: ['src/routes/m2.mjs'] })]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2'])).exitCode, 0);
});

test('eval 38.2: integration tickets that edit the same file are chained, the later after the earlier', async t => {
  const root = await setup(t);
  // Both integration tickets write src/router.mjs. Old behavior: nothing ordered them, so they could run at the same time and collide.
  await fakeRun(root, 'r1', [item('a', ['R-001']), mount('m1', 'R-001'), item('b', ['R-002']), mount('m2', 'R-002', { files: ['src/routes/m2.mjs', 'src/router.mjs'] })]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  const ledger = await readLedger(root);
  const m1 = ledger.tickets.find(x => x.title === 'm1'), m2 = ledger.tickets.find(x => x.title === 'm2');
  assert.ok(m2.dependsOn.includes(m1.id), 'm2 waits for m1');
  assert.ok(!m1.dependsOn.includes(m2.id), 'no cycle');
  // Integration tickets that share no file stay free of each other.
  const root2 = await setup(t);
  await fakeRun(root2, 'r1', [item('a', ['R-001']), mount('m1', 'R-001', { files: ['src/routes/m1.mjs'] }), item('b', ['R-002']), mount('m2', 'R-002', { files: ['src/routes/m2.mjs'] })]);
  assert.equal((await runScopeCommand(root2, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  const free = await readLedger(root2);
  assert.ok(!free.tickets.find(x => x.title === 'm2').dependsOn.includes(free.tickets.find(x => x.title === 'm1').id));
});
