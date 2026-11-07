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
import { readLedger, writeLedger } from '../tools/tickets.mjs';

const execFileAsync = promisify(execFile);
const SCOPE = [
  '# Scope: Lane size', 'Version: 1', '',
  '## Overview', 'Size worker tickets by real output bytes.', '',
  '## Stages', '- S1: Core', '',
  '## S1 Core', '### R-001 A feature works.', 'Acceptance:', '- It works.', '',
  '## External', '', '## Sensitive', '', '## Protected', '- .env', '',
].join('\n');

async function project(files = []) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-split-lane-size-')));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  for (const [file, text] of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: root });
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

const item = (files, extra = {}) => ({
  key: 'work',
  title: 'Work',
  type: 'build',
  scopeRefs: ['R-001'],
  acceptance: ['works'],
  files,
  size: 'S',
  risk: 'low',
  ...extra,
});

test('scope split --ingest routes a 40 KB output to an in-place lane', async () => {
  const root = await project([['src/huge.mjs', 'x'.repeat(40_000)]]);
  await fakeRun(root, 'r1', [item(['src/huge.mjs'])]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /T-0001: 40000 bytes routed to in-place lane (cursor|codex)/);
  const ledger = await readLedger(root);
  assert.ok(['cursor', 'codex'].includes(ledger.tickets[0].lane));
});

test('scope split --ingest refuses a ticket exceeding every lane with a split hint', async () => {
  const root = await project([['src/base.mjs', 'base\n']]);
  await fakeRun(root, 'r1', [item(['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'])]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /T-0001: 0 bytes exceeds the cheap-lane cap of 15360 bytes/);
  assert.match(result.stdout, /split this ticket or reduce its outputs/);
  assert.match(result.stdout, /parked:/);
});

test('scope approve warns when a pinned API lane exceeds its byte budget', async () => {
  const root = await project([['contracts/api.json', 'x'.repeat(40_000)]]);
  await fakeRun(root, 'r1', [item(['contracts/api.json'], { type: 'contract' })]);
  const ingest = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(ingest.exitCode, 0, ingest.stdout);
  const ledger = await readLedger(root);
  ledger.tickets[0].lane = 'hermes';
  await writeLedger(root, ledger);
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /warning: T-0001 exceeds active lane hermes byte budget: 40000 bytes \(cap 15360\)/);
});

test('scope approve does not warn about an API cap when the lane is unset', async () => {
  const root = await project([['contracts/api.json', 'x'.repeat(40_000)]]);
  await fakeRun(root, 'r1', [item(['contracts/api.json'], { type: 'contract' })]);
  const ingest = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(ingest.exitCode, 0, ingest.stdout);
  const ledger = await readLedger(root);
  delete ledger.tickets[0].lane;
  await writeLedger(root, ledger);
  const result = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /exceeds active lane cursor byte budget/);
  assert.doesNotMatch(result.stdout, /exceeds active lane hermes byte budget/);
});
