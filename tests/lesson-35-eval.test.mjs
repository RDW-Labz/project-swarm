// SPDX-License-Identifier: Apache-2.0
// Scenario eval for lesson 35 (parts app): a change order for one new requirement made the split worker rewrite the whole stage with guessed paths.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { readLedger } from '../tools/tickets.mjs';

const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app.', '', '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');
const SCOPE2 = SCOPE.replace('\n## Protected', '\n### R-002 A user can list requests.\nAcceptance:\n- Returns 200.\n\n## Protected');
const t1 = (key, extra) => ({ key, title: key, type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${key}.mjs`], size: 'S', risk: 'low', ...extra });
const MOUNT1 = t1('mount1', { integration: true, files: ['src/routes/requests.mjs'], tests: ['tests/routes.test.mjs'] });
const t2 = (key, extra) => t1(key, { scopeRefs: ['R-002'], ...extra });
async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }));
}

test('eval 35: a change order adds tickets only for the changed requirement, and the split worker sees the real files and tickets', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'l35-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await fakeRun(root, 'r1', [t1('create'), MOUNT1]);
  assert.equal((await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1'])).exitCode, 0);
  assert.equal((await runScopeCommand(root, 'scope', ['approve', '--yes'])).exitCode, 0);
  // The project has real files, in folders the worker could not guess from two levels.
  await fs.mkdir(path.join(root, 'src/features/requests/api'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/features/requests/api/create.mjs'), 'export {};\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'src'], { cwd: root });
  // One new requirement arrives by change order.
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE2);
  const change = await runScopeCommand(root, 'change', ['add listing', '--yes']);
  assert.equal(change.exitCode, 0, change.stdout);
  const made = await runScopeCommand(root, 'scope', ['split']);
  assert.equal(made.exitCode, 0, made.stdout);
  const prompt = JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/manifest.json'), 'utf8')).jobs[0].prompt;
  // Old behavior: no file list, no existing tickets, so the worker guessed paths and rewrote the stage.
  assert.match(prompt, /ONLY for the requirements listed below.*never repeat, rewrite or replace an existing ticket/s);
  assert.match(prompt, /- src\/features\/requests\/api\/create\.mjs/);
  assert.match(prompt, /- T-0001 \[todo\] create \(R-001\) writes src\/create\.mjs/);
  assert.match(prompt, /R-002: A user can list requests\./);
  assert.doesNotMatch(prompt, /R-001: A user can create/);
  // A worker that rewrote R-001 as well is refused whole: nothing is written.
  const before = (await readLedger(root)).tickets.length;
  await fakeRun(root, 'r2', [t1('create-again'), t2('list'), t2('mount2', { integration: true, files: ['src/routes/list.mjs'], tests: ['tests/list.test.mjs'] })]);
  const refused = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r2', '--merge']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /may only add tickets for requirements that have none \(R-002\).*create-again \(R-001\)/s);
  assert.equal((await readLedger(root)).tickets.length, before);
  // A worker that adds only the changed requirement is accepted.
  await fakeRun(root, 'r3', [t2('list'), t2('mount2', { integration: true, files: ['src/routes/list.mjs'], tests: ['tests/list.test.mjs'] })]);
  const ok = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r3', '--merge']);
  assert.equal(ok.exitCode, 0, ok.stdout);
  assert.equal((await readLedger(root)).tickets.length, before + 2);
});
