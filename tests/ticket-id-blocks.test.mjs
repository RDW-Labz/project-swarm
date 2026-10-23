// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runScopeCommand,
  parseTicketIdBlock,
  resolveIngestStartAt,
  validateIngestTicketIds,
} from '../tools/scope-commands.mjs';
import { createLedger, readLedger } from '../tools/tickets.mjs';

const execFileAsync = promisify(execFile);

const SCOPE = [
  '# Scope: Ticket id blocks',
  'Version: 1',
  '',
  '## Overview',
  'Reserve disjoint ticket id blocks per machine.',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 A module works.',
  'Acceptance:',
  '- It works.',
  '',
  '## External',
  '',
  '## Sensitive',
  '',
  '## Protected',
  '',
].join('\n');

async function gitRepo(root) {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  const rel = 'src/base.mjs';
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `// ${rel}\n`);
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: root });
}

async function setLocalConfig(patch) {
  const configPath = process.env.SWARM_CONFIG;
  const base = JSON.parse(await fs.readFile(configPath, 'utf8'));
  await fs.writeFile(configPath, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

async function project(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-id-blocks-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await gitRepo(root);
  return root;
}

async function fakeRun(root, id, items) {
  const workspace = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, workspace, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, workspace, 'docs/scope/split', 'S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({
    id,
    jobs: [{ id: 'split-S1', status: 'complete', workspace }],
  }));
}

const build = (over = {}) => ({
  key: 'build',
  title: 'Build module',
  type: 'build',
  scopeRefs: ['R-001'],
  acceptance: ['works'],
  files: ['src/module.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

test('parseTicketIdBlock accepts start with optional end below T-9000', () => {
  assert.deepEqual(parseTicketIdBlock({ start: 8000 }), { start: 8000, end: 8999 });
  assert.deepEqual(parseTicketIdBlock({ start: 100, end: 199 }), { start: 100, end: 199 });
  assert.equal(parseTicketIdBlock({ start: 0 }), null);
  assert.equal(parseTicketIdBlock({ start: 9000 }), null);
});

test('ingest mints only inside the configured ticket id block', async t => {
  await setLocalConfig({ ticketIdBlock: { start: 100, end: 199 } });
  const root = await project(t);
  await fakeRun(root, 'r1', [build()]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  const ledger = await readLedger(root);
  assert.equal(ledger.tickets.find(ticket => ticket.type === 'build')?.id, 'T-0100');
  assert.ok(!ledger.tickets.some(ticket => ticket.id === 'T-0001'));
});

test('ingest refuses ids outside the configured block instead of renumbering', async t => {
  const block = { start: 5000, end: 5000 };
  await setLocalConfig({ ticketIdBlock: block });
  const root = await project(t);
  await fakeRun(root, 'r1', [build(), build({ key: 'build2', title: 'Second build', files: ['src/other.mjs'] })]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stdout, /ticket-id-block: cannot mint T-5000 through T-5001/);
  assert.match(result.stdout, /T-5000 through T-5000/);
  assert.equal(await readLedger(root), null);
});

test('ingest hard-fails when a minted id collides with a configured peer ledger', async t => {
  const peerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-id-peer-'));
  t.after(() => fs.rm(peerDir, { recursive: true, force: true }));
  const peerFile = path.join(peerDir, 'tickets.json');
  const peerLedger = createLedger({
    scope: { name: 'peer', version: 1, hash: 'peer' },
    tickets: [{
      id: 'T-0200',
      title: 'Peer ticket',
      type: 'build',
      stage: 'S1',
      epic: 'E-00',
      scopeRefs: ['R-001'],
      acceptance: ['done'],
      files: ['src/peer.mjs'],
      size: 'S',
      risk: 'low',
      status: 'todo',
    }],
  });
  await fs.writeFile(peerFile, `${JSON.stringify(peerLedger, null, 2)}\n`);

  await setLocalConfig({
    ticketIdBlock: { start: 200, end: 299 },
    peerTicketsLedger: peerFile,
  });
  const root = await project(t);
  await fakeRun(root, 'r1', [build()]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1, result.stdout);
  assert.match(result.stdout, /ticket-id-collision: T-0200 already exists in peer tickets ledger/);
  assert.equal(await readLedger(root), null);
});

test('validateIngestTicketIds flags cross-block minting without ingest', () => {
  const blockA = { start: 100, end: 199 };
  const blockBStart = 1;
  assert.equal(
    validateIngestTicketIds({ startAt: blockBStart, itemCount: 1, block: blockA }),
    'ticket-id-block: cannot mint T-0001; this machine is configured for ticket ids T-0100 through T-0199',
  );
  assert.equal(resolveIngestStartAt(null, blockA), 100);
});
