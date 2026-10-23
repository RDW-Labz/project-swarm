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
import { scopeLoop } from '../tools/scope-loop.mjs';
import { acceptanceReviewSkipWarning } from '../tools/acceptance.mjs';

const SCOPE_MD = `# Scope
Version: 1
## Overview
Wave prep fixtures.
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
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'wave-prep-'));
  const root = path.join(parent, 'repo');
  await fs.mkdir(root);
  assert.equal(git(root, 'init', '-q', '-b', 'main').status, 0);
  await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
  assert.equal(git(root, 'add', 'README.md').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'seed').status, 0);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}

test('drops context that belongs to a pending ticket output with a warning', () => {
  const pendingPath = 'tests/orchestrator-handoff.test.mjs';
  const ledger = {
    tickets: [
      baseTicket('T-0142', { files: [pendingPath], tests: [pendingPath], context: [pendingPath] }),
      baseTicket('T-0144', {
        context: [pendingPath, 'src/orchestrator-context.mjs'],
        files: ['src/orchestrator-context.mjs'],
      }),
    ],
  };
  const { manifest, warnings } = ticketsToManifest([ledger.tickets[1]], { ledger, scope, ready: false });
  assert.equal(manifest.jobs.length, 1);
  assert.ok(!manifest.jobs[0].context.includes(pendingPath));
  assert.ok(warnings.some((w) => w.includes(`context ${pendingPath} belongs to T-0142 (pending), dropped for this run`)));
});

test('a truly missing context file still fails project validation', async (t) => {
  const root = await project(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/T-0001.mjs'), 'export const ok = true;\n');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/plan.md'), '# plan\n');
  assert.equal(git(root, 'add', '.').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'files').status, 0);
  const { manifest } = ticketsToManifest([baseTicket('T-0001', { context: ['src/T-0001.mjs', 'docs/missing-context.mjs'] })], { scope });
  for (const job of manifest.jobs) {
    job.agent = 'claude';
    job.model = 'sonnet';
  }
  await assert.rejects(
    () => validateProject(root, manifest),
    (err) => /Missing context: docs\/missing-context\.mjs/.test(String(err.message)),
  );
});

test('non-startable tickets are not emitted as jobs', () => {
  const ledger = {
    tickets: [
      baseTicket('T-0142', { status: 'running' }),
      baseTicket('T-0144', { dependsOn: ['T-0142'], context: ['tests/orchestrator-handoff.test.mjs'] }),
    ],
  };
  const { manifest } = ticketsToManifest(ledger.tickets, { ledger, scope, ready: true });
  assert.deepEqual(manifest.jobs.map((job) => job.id), []);
});

test('validateManifest names missing, zero-job, and version problems separately', () => {
  assert.throws(() => validateManifest(null), /Manifest is missing/);
  assert.throws(() => validateManifest({ version: 2, jobs: [{ id: 'a', agent: 'claude', model: 'sonnet', prompt: 'x', context: [], outputs: [] }] }), /Manifest requires version: 1/);
  assert.throws(() => validateManifest({ version: 1, jobs: [] }), /Manifest has zero jobs/);
  assert.throws(() => validateManifest({ version: 1, jobs: Array.from({ length: 5001 }, (_, i) => ({ id: `T-${String(i).padStart(4, '0')}`, agent: 'claude', model: 'sonnet', prompt: 'x', context: [], outputs: [] })) }), /1–5000/);
});

test('resume skips a zero-job acceptance manifest with a note and does not count start failures', async (t) => {
  const root = await project(t);
  const id = 'T-9011';
  await fs.mkdir(path.dirname(path.join(root, `src/${id}.mjs`)), { recursive: true });
  await fs.writeFile(path.join(root, `src/${id}.mjs`), `// ${id}\n`);
  const file = `.swarm/acceptance-reviews/resume-1-${id}.json`;
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), '{"version":1,"jobs":[]}\n');
  const tickets = [{
    ...baseTicket(id, { status: 'review', acceptance: ['output is present'], tests: [] }),
    context: [`src/${id}.mjs`],
  }];
  const reviewCalls = [];
  const notes = new Map();
  const warnings = [];
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => { throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' }); },
    ledger: async () => ({ tickets }),
    review: async (kind, file) => {
      reviewCalls.push({ kind, file });
      return { runId: 'review-9011' };
    },
    record: async () => {},
    ticketNote: async (ticketId, text) => { notes.set(ticketId, text); },
    log: (text) => { if (String(text).startsWith('acceptance-review-skipped:')) warnings.push(text); },
  };
  const out = await scopeLoop({ deps, root });
  assert.equal(reviewCalls.length, 0);
  assert.equal(tickets[0].status, 'review');
  assert.equal(tickets[0].reviewStartFailCount ?? 0, 0);
  assert.match(notes.get(id), /acceptance review skipped: acceptance review manifest has zero jobs/);
  assert.equal(warnings[0], acceptanceReviewSkipWarning(id, 'acceptance review manifest has zero jobs'));
  assert.equal(out.status, 'stuck');
});

test('resume marks a ticket done when every acceptance line is already met by tests', async (t) => {
  const root = await project(t);
  const id = 'T-9012';
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/ac.test.mjs'), "import test from 'node:test';\ntest('AC1: output is present', () => {});\n");
  await fs.mkdir(path.dirname(path.join(root, `src/${id}.mjs`)), { recursive: true });
  await fs.writeFile(path.join(root, `src/${id}.mjs`), `// ${id}\n`);
  assert.equal(git(root, 'add', '.').status, 0);
  assert.equal(git(root, 'commit', '-qm', 'ac').status, 0);
  const tickets = [{
    ...baseTicket(id, { status: 'review', acceptance: ['output is present'], tests: ['tests/ac.test.mjs'] }),
    context: [`src/${id}.mjs`, 'tests/ac.test.mjs'],
  }];
  const reviewCalls = [];
  const deps = {
    root,
    stopped: async () => null,
    prepare: async () => { throw Object.assign(new Error('no ready tickets'), { code: 'scope-nothing' }); },
    ledger: async () => ({ tickets }),
    review: async (kind, file) => {
      reviewCalls.push({ kind, file });
      return { runId: 'review-9012' };
    },
    record: async () => {},
    log: () => {},
  };
  const out = await scopeLoop({ deps, root });
  assert.equal(reviewCalls.length, 0);
  assert.equal(tickets[0].status, 'done');
  assert.equal(out.status, 'complete');
});
