// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runScopeCommand } from '../tools/scope-commands.mjs';

const execFileAsync = promisify(execFile);
const SCOPE = [
  '# Scope: Wave checks',
  'Version: 1',
  '',
  '## Overview',
  'A small project for wave checks.',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 A feature works.',
  'Acceptance:',
  '- The feature works.',
  '',
  '## External',
  '',
  '## Sensitive',
  '',
  '## Protected',
  '- .env',
  '',
].join('\n');

async function project() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-ingest-waves-')));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
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

function chainItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    key: `chain-${i + 1}`,
    title: `Chain ticket ${i + 1}`,
    type: 'human',
    scopeRefs: ['R-001'],
    steps: ['Complete the ticket.'],
    dependsOn: i ? [`chain-${i}`] : [],
    size: 'S',
    risk: 'low',
  }));
}

async function logEntries(root) {
  const text = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('a single ten-ticket chain is refused before ingest writes a ledger', async () => {
  const root = await project();
  await fakeRun(root, 'chain', chainItems(10));
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'chain'], { machineConcurrency: 8 });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /critical path 10 of 10/);
  assert.match(result.stdout, /average fill/);
  assert.match(result.stdout, /T-0001 -> T-0002 -> T-0003 -> T-0004 -> T-0005 -> T-0006 -> T-0007 -> T-0008 -> T-0009 -> T-0010/);
  assert.match(result.stdout, /re-split \(merge chains \/ split the long chain\)/);
  await assert.rejects(fs.access(path.join(root, '.swarm/project/tickets.json')));
});

test('--accept-waves writes the ledger and records wave-sim-accepted', async () => {
  const root = await project();
  await fakeRun(root, 'chain', chainItems(10));
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'chain', '--accept-waves'], { machineConcurrency: 8 });
  assert.equal(result.exitCode, 0, result.stdout);
  const ledger = JSON.parse(await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8'));
  assert.equal(ledger.tickets.length, 10);
  const accepted = (await logEntries(root)).find(entry => entry.event === 'wave-sim-accepted');
  assert.ok(accepted);
  assert.equal(accepted.criticalPathLength, 10);
  assert.deepEqual(accepted.longestChain, Array.from({ length: 10 }, (_, i) => `T-${String(i + 1).padStart(4, '0')}`));
});

test('scope approve prints the summary and needs --accept-waves for a failing assessment', async () => {
  const root = await project();
  await fakeRun(root, 'chain', chainItems(10));
  await runScopeCommand(root, 'scope', ['split', '--ingest', 'chain', '--accept-waves'], { machineConcurrency: 8 });
  const refused = await runScopeCommand(root, 'scope', ['approve', '--yes'], { machineConcurrency: 8 });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /waves: 10, critical path 10 of 10/);
  assert.match(refused.stdout, /re-split/);

  const accepted = await runScopeCommand(root, 'scope', ['approve', '--yes', '--accept-waves'], { machineConcurrency: 8 });
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.match(accepted.stdout, /waves: 10, critical path 10 of 10/);
  assert.match(accepted.stdout, /average fill/);
});
