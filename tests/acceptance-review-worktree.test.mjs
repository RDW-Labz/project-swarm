// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acceptanceInputs, reviewManifest } from '../tools/acceptance.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';

const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });

test('acceptance review from a linked worktree lists that worktree files and reads its ledger/records', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-worktree-'));
  const root = path.join(parent, 'repo');
  const linked = path.join(parent, 'linked');
  await fs.mkdir(root);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
  assert.equal(git(root, 'add', 'README.md').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'seed').status, 0);
  assert.equal(git(root, 'worktree', 'add', '-q', '-b', 'acceptance-linked', linked).status, 0);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));

  const ticket = {
    id: 'T-8003',
    title: 'Linked acceptance',
    type: 'build',
    scopeRefs: ['R-800'],
    acceptance: ['the linked file exists'],
    files: ['src/linked.mjs'],
    tests: [],
    context: [],
    dependsOn: [],
    size: 'S',
    risk: 'low',
    status: 'review',
    runId: 'build-linked',
    targetWorktree: await fs.realpath(linked),
  };
  await fs.mkdir(path.join(linked, 'src'), { recursive: true });
  await fs.writeFile(path.join(linked, 'src/linked.mjs'), 'export const linked = true;\n');
  await writeLedger(linked, createLedger({ scope: { name: 'linked' }, tickets: [ticket] }));
  await fs.mkdir(path.join(linked, '.swarm/acceptance-reviews'), { recursive: true });
  await fs.writeFile(path.join(linked, '.swarm/acceptance-reviews/records.json'), JSON.stringify({ tickets: { 'T-8003': { run: 'review-linked' } } }));

  const manifest = reviewManifest('review-linked', [{ ticket, uncovered: [1] }], { root: linked });
  assert.deepEqual(manifest.jobs[0].context, ['src/linked.mjs']);
  const inputs = await acceptanceInputs(root, ticket);
  assert.equal(inputs.root, await fs.realpath(linked));
  assert.equal(inputs.ledger.tickets[0].targetWorktree, await fs.realpath(linked));
  assert.equal(inputs.records.tickets['T-8003'].run, 'review-linked');
});
