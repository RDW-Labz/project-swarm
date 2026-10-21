// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { createLedger, logPath, readLedger, writeLedger } from '../tools/tickets.mjs';

const base = { title: 'Declared file state', stage: 'S1', scopeRefs: ['R-001'], acceptance: ['the declared file state is correct'], context: [], contracts: [], tests: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'review' };

async function project(t, ticket, files = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-sync-delete-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  for (const [file, text] of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  await writeLedger(root, createLedger({ scope: { name: 'Sync', version: 1, hash: 'scope' }, tickets: [ticket] }));
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', integratedAt: '2026-10-21T12:00:00.000Z', jobs: [{ id: ticket.id, status: 'complete' }] }));
  return root;
}

const sync = root => runScopeCommand(root, 'scope', ['sync', 'r1', '--integrated']);

test('delete-only tickets stay in review while a declared delete remains, then become done', async t => {
  const ticket = { ...base, id: 'T-0001', type: 'build', files: [], deletes: ['src/old.mjs'] };
  const root = await project(t, ticket, [['src/old.mjs', 'old']]);
  const waiting = await sync(root);
  assert.match(waiting.stdout, /src\/old\.mjs still exists/);
  assert.equal((await readLedger(root)).tickets[0].status, 'review');
  await fs.rm(path.join(root, 'src/old.mjs'));
  const done = await sync(root);
  assert.match(done.stdout, /1 ticket\(s\) marked done/);
  assert.equal((await readLedger(root)).tickets[0].status, 'done');
  const log = await fs.readFile(logPath(root), 'utf8');
  assert.match(log, /delete-only: files gone/);
});

test('rename tickets require only the new path and no longer the old path', async t => {
  const cases = [
    { name: 'both-present', files: [['src/old.mjs', 'old'], ['src/new.mjs', 'new']], pattern: /src\/old\.mjs still exists/ },
    { name: 'neither', files: [], pattern: /src\/new\.mjs does not exist yet/ },
    { name: 'renamed', files: [['src/new.mjs', 'new']], pattern: null },
  ];
  for (const scenario of cases) {
    const ticket = { ...base, id: 'T-0001', type: 'rename', acceptance: [], files: ['src/new.mjs'], deletes: ['src/old.mjs'] };
    const root = await project(t, ticket, scenario.files);
    const result = await sync(root);
    if (scenario.pattern) {
      assert.match(result.stdout, scenario.pattern, scenario.name);
      assert.equal((await readLedger(root)).tickets[0].status, 'review');
    } else {
      assert.equal((await readLedger(root)).tickets[0].status, 'done', scenario.name);
    }
  }
});
