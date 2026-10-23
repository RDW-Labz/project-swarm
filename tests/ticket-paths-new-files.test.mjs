// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateTicketPaths } from '../tools/ticket-paths.mjs';
import { runScopeCommand } from '../tools/scope-commands.mjs';

const execFileAsync = promisify(execFile);

const SCOPE = [
  '# Scope: New file paths',
  'Version: 1',
  '',
  '## Overview',
  'Validate new ticket output paths.',
  '',
  '## Stages',
  '- S1: Core',
  '',
  '## S1 Core',
  '### R-001 A feature works.',
  'Acceptance:',
  '- It works.',
  '',
  '## External',
  '',
  '## Sensitive',
  '',
  '## Protected',
  '- .env',
  '',
].join('\n');

async function gitRepo(root, tracked) {
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  for (const rel of tracked) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `// ${rel}\n`);
  }
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: root });
}

async function project(tracked) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-paths-new-')));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  await gitRepo(root, tracked);
  return root;
}

async function fakeRun(root, id, items) {
  const ws = `.swarm/workspaces/${id}/split-S1`;
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify(items));
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(
    path.join(root, '.swarm/runs', id, 'state.json'),
    JSON.stringify({ id, jobs: [{ id: 'split-S1', status: 'complete', workspace: ws }] }),
  );
}

const okItem = (over) => ({
  key: 'work',
  title: 'Work',
  type: 'build',
  scopeRefs: ['R-001'],
  acceptance: ['ok'],
  files: ['src/base.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

test('validateTicketPaths warns on a similar new output file', () => {
  const repoFiles = ['tools/warm_ten_mile.py', 'src/base.mjs'];
  const ticket = {
    type: 'build',
    files: ['tools/warm_boi_tiles.py'],
    context: ['src/base.mjs'],
  };
  const result = validateTicketPaths(ticket, { repoFiles });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'similar-new-file');
  assert.equal(result.warnings[0].path, 'tools/warm_boi_tiles.py');
  assert.equal(result.warnings[0].suggestion, 'tools/warm_ten_mile.py');
});

test('validateTicketPaths still refuses a missing context path that looks like a typo', () => {
  const repoFiles = ['tools/scope-commands.mjs', 'src/base.mjs'];
  const ticket = {
    type: 'build',
    files: ['src/base.mjs'],
    context: ['tools/scope-comands.mjs'],
  };
  const result = validateTicketPaths(ticket, { repoFiles });
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /likely typo|missing file/);
  assert.equal(result.errors[0].path, 'tools/scope-comands.mjs');
  assert.equal(result.warnings?.length ?? 0, 0);
});

test('ingest accepts a similar new output with a similar-new-file warning', async () => {
  const root = await project(['tools/warm_ten_mile.py', 'src/base.mjs']);
  await fakeRun(root, 'r1', [
    okItem({ files: ['tools/warm_boi_tiles.py'], context: ['src/base.mjs'] }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /new file \(warning only\)/);
  assert.match(result.stdout, /similar-new-file/);
  assert.match(result.stdout, /warm_boi_tiles\.py/);
  assert.match(result.stdout, /warm_ten_mile\.py/);
});

test('--accept-new-path overrides only the named refused read path', async () => {
  const root = await project(['src/base.mjs', 'tools/scope-commands.mjs']);
  await fakeRun(root, 'r1', [
    okItem({
      files: ['src/base.mjs'],
      context: ['src/base.mjs'],
      contracts: ['tools/scope-comands.mjs', 'tools/scope-commandss.mjs'],
    }),
  ]);
  const partial = await runScopeCommand(root, 'scope', [
    'split',
    '--ingest',
    'r1',
    '--accept-new-path',
    'tools/scope-comands.mjs',
  ]);
  assert.equal(partial.exitCode, 1);
  assert.match(partial.stdout, /tools\/scope-commandss\.mjs/);

  const accepted = await runScopeCommand(root, 'scope', [
    'split',
    '--ingest',
    'r1',
    '--accept-new-path',
    './tools/scope-comands.mjs,tools/scope-commandss.mjs',
  ]);
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.match(accepted.stdout, /accepted new path/);
  const logText = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  assert.match(logText, /"event":"accept-new-path"/);
  assert.match(logText, /scope-comands\.mjs/);
  assert.match(logText, /scope-commandss\.mjs/);
});
