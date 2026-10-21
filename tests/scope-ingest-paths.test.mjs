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
  '# Scope: Path ingest',
  'Version: 1',
  '',
  '## Overview',
  'Validate ticket paths at ingest.',
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
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-ingest-paths-')));
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
  files: ['src/new-feature.mjs'],
  size: 'S',
  risk: 'low',
  ...over,
});

test('ingest refuses a directory path used as context (lessons/swarm)', async () => {
  const root = await project([
    'lessons/swarm/lesson.md',
    'src/existing.mjs',
  ]);
  await fakeRun(root, 'r1', [
    okItem({ context: ['lessons/swarm'], files: ['src/existing.mjs'] }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /lessons\/swarm is a directory/);
  await assert.rejects(fs.access(path.join(root, '.swarm/project/tickets.json')));
});

test('ingest refuses a typo and suggests the real tracked file', async () => {
  const root = await project(['tools/scope-commands.mjs', 'src/base.mjs']);
  await fakeRun(root, 'r1', [
    okItem({ files: ['tools/scope-comands.mjs'], context: ['tools/scope-commands.mjs'] }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /tools\/scope-comands\.mjs likely typo/);
  assert.match(result.stdout, /closest real path: tools\/scope-commands\.mjs/);
  await assert.rejects(fs.access(path.join(root, '.swarm/project/tickets.json')));
});

test('ingest refuses a missing context path', async () => {
  const root = await project(['src/base.mjs']);
  await fakeRun(root, 'r1', [
    okItem({ context: ['docs/no-such-context.md'], files: ['src/base.mjs'] }),
  ]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /docs\/no-such-context\.md missing file/);
  await assert.rejects(fs.access(path.join(root, '.swarm/project/tickets.json')));
});

test('ingest accepts a new output file in an existing folder', async () => {
  const root = await project(['src/base.mjs']);
  await fakeRun(root, 'r1', [okItem({ files: ['src/new-feature.mjs'] })]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
  const ledger = JSON.parse(await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8'));
  assert.ok(ledger.tickets.some((t) => (t.files ?? []).includes('src/new-feature.mjs')));
});

test('ingest accepts a new output file in a folder that does not exist yet', async () => {
  const root = await project(['src/base.mjs']);
  await fakeRun(root, 'r1', [okItem({ files: ['src/new-area/feature.mjs'] })]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
});

test('ingest accepts a missing delete path', async () => {
  const root = await project(['src/base.mjs']);
  await fakeRun(root, 'r1', [okItem({ files: ['src/base.mjs'], deletes: ['src/removed.mjs'] })]);
  const result = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(result.exitCode, 0, result.stdout);
});
