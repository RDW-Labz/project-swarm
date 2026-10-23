// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';
import { validateProject } from '../tools/swarm.mjs';
import { validateManifest } from '../tools/swarm/core-31.mjs';
import { contextEnvFor, finalizeScopeWaveManifest } from '../tools/scope-commands.mjs';
import { scopeLoop } from '../tools/scope-loop.mjs';

const SCOPE_MD = `# Scope
Version: 1
## Overview
Wave prep robust fixtures.
## Stages
- S1: Work
## S1 Work
### R-001 A feature exists.
Acceptance:
- It works.
`;

const scope = parseScope(SCOPE_MD);

const baseTicket = (id, over = {}) => ({
  id,
  title: id,
  type: 'build',
  stage: 'S1',
  scopeRefs: ['R-001'],
  acceptance: ['It works.'],
  files: [`src/${id}.mjs`],
  context: [`src/${id}.mjs`],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'ready',
  ...over,
});

const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });

async function project(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-prep-robust-'));
  const root = path.join(parent, 'repo');
  await fs.mkdir(root);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
  assert.equal(git(root, 'add', 'README.md').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'seed').status, 0);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}

async function validateManifestProject(root, manifest) {
  const copy = JSON.parse(JSON.stringify(manifest));
  validateManifest(copy);
  await validateProject(root, copy);
}

test('adds referencing tests to job context for uncovered references when the ticket names no tests', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/widget.mjs'), 'export const widget = 1;\n');
  for (let i = 0; i < 8; i += 1) {
    await fs.writeFile(path.join(root, `tests/ref-${i}.test.mjs`), `import '../src/widget.mjs';\nimport test from 'node:test';\ntest('ref ${i}', () => {});\n`);
  }
  assert.equal(git(root, 'add', '.').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'refs').status, 0);
  const ticket = baseTicket('T-0100', { files: ['src/widget.mjs'], context: ['src/widget.mjs'], tests: [] });
  const { manifest } = ticketsToManifest([ticket], { scope, contextEnv: contextEnvFor(root, null) });
  manifest.jobs[0].agent = 'anthropic';
  manifest.jobs[0].model = 'claude-haiku-5-5';
  const warnings = [];
  await finalizeScopeWaveManifest(manifest, {
    validate: (m) => validateManifestProject(root, m),
    tickets: [ticket],
    warnings,
    root,
  });
  const job = manifest.jobs[0];
  for (let i = 0; i < 8; i += 1) {
    assert.ok(job.context.includes(`tests/ref-${i}.test.mjs`));
  }
  assert.equal(job.ignoreTests, undefined);
});

test('does not auto-fill ignoreTests when the ticket lists its own tests', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/widget.mjs'), 'export const widget = 1;\n');
  await fs.writeFile(path.join(root, 'tests/other.test.mjs'), `import '../src/widget.mjs';\nimport test from 'node:test';\ntest('other', () => {});\n`);
  assert.equal(git(root, 'add', '.').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'refs').status, 0);
  const ticket = baseTicket('T-0101', {
    files: ['src/widget.mjs'],
    tests: ['tests/new.test.mjs'],
    context: ['src/widget.mjs'],
  });
  const { manifest } = ticketsToManifest([ticket], { scope, contextEnv: contextEnvFor(root, null) });
  manifest.jobs[0].agent = 'anthropic';
  manifest.jobs[0].model = 'claude-haiku-5-5';
  const warnings = [];
  await assert.rejects(
    () => finalizeScopeWaveManifest(manifest, {
      validate: (m) => validateManifestProject(root, m),
      tickets: [ticket],
      warnings,
      root,
    }),
    /Uncovered test references/,
  );
  assert.equal(manifest.jobs[0].ignoreTests, undefined);
});

test('drops a not-yet-created ticket test from context but keeps it as an output', () => {
  const future = 'tests/future.test.mjs';
  const ticket = baseTicket('T-0102', { tests: [future], context: [future, 'src/T-0102.mjs'] });
  const { manifest } = ticketsToManifest([ticket], {
    scope,
    contextEnv: { exists: (p) => p === 'src/T-0102.mjs', sizes: {}, profileContext: [], listFiles: () => [], limits: {} },
  });
  const job = manifest.jobs[0];
  assert.ok(job.outputs.includes(future));
  assert.ok(!job.context.includes(future));
});

test('routes a UI ticket with a binary mockup away from API lanes', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'design'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/ui.mjs'), 'export const ui = 1;\n');
  await fs.writeFile(path.join(root, 'design/screen.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  assert.equal(git(root, 'add', '.').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'ui').status, 0);
  const profile = {
    protectedPaths: ['design/'],
    ui: { screens: [{ id: 'home', mockup: 'design/screen.png' }] },
  };
  const ticket = baseTicket('T-0103', { files: ['src/ui.mjs'], screens: ['home'], context: ['src/ui.mjs'] });
  const { manifest } = ticketsToManifest([ticket], {
    scope,
    contextEnv: contextEnvFor(root, profile),
    laneModels: { cursor: { model: 'composer' } },
  });
  const job = manifest.jobs[0];
  assert.equal(job.agent, 'cursor');
  assert.equal(job.model, 'composer');
  assert.ok(job.context.includes('design/screen.png'));
});

test('parks a ticket that still fails prep and lets the rest of the wave proceed', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const big = 'src/huge.mjs';
  const small = 'src/small.mjs';
  await fs.writeFile(path.join(root, big), `${'//'.repeat(120_000)}\n`);
  await fs.writeFile(path.join(root, small), 'export const ok = true;\n');
  assert.equal(git(root, 'add', '.').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'sizes').status, 0);
  const bad = baseTicket('T-0104', { files: [big], context: [big] });
  const good = baseTicket('T-0105', { files: [small], context: [small] });
  const { manifest } = ticketsToManifest([bad, good], { scope, contextEnv: contextEnvFor(root, null) });
  for (const job of manifest.jobs) {
    job.agent = 'anthropic';
    job.model = 'claude-haiku-5-5';
  }
  const warnings = [];
  await finalizeScopeWaveManifest(manifest, {
    validate: (m) => validateManifestProject(root, m),
    tickets: [bad, good],
    warnings,
    root,
  });
  assert.equal(manifest.jobs.length, 1);
  assert.equal(manifest.jobs[0].id, 'T-0105');
  assert.ok(warnings.some((w) => w.startsWith('T-0104 skipped:')));
});

test('scope loop reverts running tickets when the wave run never starts', async () => {
  const tickets = [{ ...baseTicket('T-0200'), status: 'ready' }];
  const deps = {
    prepare: async () => {
      tickets[0].status = 'running';
      return { file: 'wave.json', ids: ['T-0200'] };
    },
    runWave: async () => ({ status: 'failed', stage: 'run', runId: null, reason: 'project-cap: spent' }),
    sync: async () => { throw new Error('should not sync'); },
    salvage: async () => ({ integrated: false, jobs: 0 }),
    review: async () => ({ runId: 'x' }),
    record: async () => {},
    ledger: async () => ({ tickets }),
    revert: async (ids) => {
      for (const id of ids) {
        const ticket = tickets.find((x) => x.id === id);
        if (ticket?.status === 'running') ticket.status = 'ready';
      }
    },
    stopped: async () => null,
    log: () => {},
  };
  const out = await scopeLoop({ deps });
  assert.equal(out.status, 'cap');
  assert.equal(tickets[0].status, 'ready');
});
