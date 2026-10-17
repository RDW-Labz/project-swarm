// SPDX-License-Identifier: Apache-2.0
// Scenario evals for lesson 37 (parts app: the --wire flow failed). Each reproduces what the owner saw.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand, contextEnvFor } from '../tools/scope-commands.mjs';
import { readLedger, writeLedger, createLedger } from '../tools/tickets.mjs';
import { validateManifest } from '../tools/swarm.mjs';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';
import { isExampleFile } from '../tools/init-profile.mjs';

const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo app.', '', '## Stages', '- S1: Core', '- S2: Lists', '- S3: Reports', '',
  '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '',
  '## S2 Lists', '### R-002 A user can list requests.', 'Acceptance:', '- Returns 200.', '',
  '## S3 Reports', '### R-003 A user can see a report.', 'Acceptance:', '- Returns 200.', '', '## Protected', '- .env', ''].join('\n');
const tk = (id, ref, stage, extra = {}) => ({ id, title: `${id} ${ref}`, type: 'build', epic: 'E', scopeRefs: [ref], acceptance: ['ok'], files: [`src/${id}.mjs`], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'todo', stage, ...extra });
const mount = (key, ref, extra = {}) => ({ key, title: `mount ${ref}`, type: 'build', integration: true, scopeRefs: [ref], acceptance: ['route works'], files: [`src/routes/${key}.mjs`, 'src/router.mjs'], tests: [`tests/${key}.test.mjs`], size: 'S', risk: 'low', ...extra });
async function fakeRun(root, id, byStage) {
  const jobs = [];
  for (const [stage, items] of Object.entries(byStage)) {
    const ws = `.swarm/workspaces/${id}/split-${stage}`;
    await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
    await fs.writeFile(path.join(root, ws, `docs/scope/split/${stage}.json`), JSON.stringify(items));
    jobs.push({ id: `split-${stage}`, status: 'complete', workspace: ws });
  }
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ id, jobs }));
}
// The parts app ledger: made before the wiring rule. S1 is built and done; S2 and S3 have modules only.
async function oldLedger(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'l37-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const ledger = createLedger({ scope: { name: 'Demo', version: 1, hash: (await import('../tools/scope.mjs')).scopeHash(SCOPE), file: 'docs/scope/scope.md' }, tickets: [tk('T-0001', 'R-001', 'S1', { status: 'done' }), tk('T-0002', 'R-002', 'S2'), tk('T-0003', 'R-003', 'S3')] });
  await writeLedger(root, ledger);
  return root;
}

test('eval 37.3: --wire skips requirements that are already built and done (S1)', async t => {
  const root = await oldLedger(t);
  const made = await runScopeCommand(root, 'scope', ['split', '--wire']);
  assert.equal(made.exitCode, 0, made.stdout);
  // Old behavior: a job for S1 too, whose integration ticket then collided with the later stages.
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.jobs.map(j => j.id), ['split-S2', 'split-S3']);
  assert.match(made.stdout, /skipped 1 requirement\(s\) already built and done: R-001/);
  const all = await runScopeCommand(root, 'scope', ['split', '--wire', '--all']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'docs/scope/split/manifest.json'), 'utf8')).jobs.map(j => j.id), ['split-S1', 'split-S2', 'split-S3']);
  assert.equal(all.exitCode, 0);
});

test('eval 37.1: integration tickets that share a file across stages are chained, so they never share a wave', async t => {
  const root = await oldLedger(t);
  // Both integration tickets edit src/router.mjs. Old behavior: the ingest was refused with "file ownership conflict(s) within a wave" and no names.
  await fakeRun(root, 'w1', { S2: [mount('m2', 'R-002')], S3: [mount('m3', 'R-003')] });
  const ingest = await runScopeCommand(root, 'scope', ['split', '--ingest', 'w1', '--merge', '--wire']);
  assert.equal(ingest.exitCode, 0, ingest.stdout);
  const ledger = await readLedger(root);
  const m2 = ledger.tickets.find(x => x.title === 'mount R-002'), m3 = ledger.tickets.find(x => x.title === 'mount R-003');
  assert.ok(m3.dependsOn.includes(m2.id), 'the later integration ticket waits for the earlier one');
  assert.ok(!m2.dependsOn.includes(m3.id));
  assert.ok(m2.dependsOn.includes('T-0002') && m3.dependsOn.includes('T-0003'), 'and each still waits for its own modules');
});

test('eval 37.4: an ingest conflict names the exact tickets and file', async t => {
  const root = await oldLedger(t);
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const a = { key: 'a', title: 'Create list page', type: 'build', scopeRefs: ['R-002'], acceptance: ['ok'], files: ['src/pages/list.tsx'], size: 'S', risk: 'low' };
  const b = { key: 'b', title: 'Add list filters', type: 'build', scopeRefs: ['R-002'], acceptance: ['ok'], files: ['src/pages/list.tsx'], size: 'S', risk: 'low' };
  const rootNew = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'l37b-')));
  t.after(() => fs.rm(rootNew, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootNew, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(rootNew, 'docs/scope/scope.md'), SCOPE);
  await fakeRun(rootNew, 'r1', { S1: [{ ...a, scopeRefs: ['R-001'] }, { ...b, scopeRefs: ['R-001'] }, mount('m1', 'R-001', { files: ['src/routes/m1.mjs'] })] });
  const refused = await runScopeCommand(rootNew, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /T-0001 "Create list page" and T-0002 "Add list filters" both write src\/pages\/list\.tsx \(wave 1\)/);
  assert.match(refused.stdout, /Make one wait for the other/);
});

test('eval 37.2: .env.example is allowed as read-only context, and still refused as an output', async t => {
  const root = await oldLedger(t);
  await fs.writeFile(path.join(root, '.env.example'), 'SUPABASE_URL=\n');
  await fs.writeFile(path.join(root, '.env'), 'SUPABASE_URL=https://x.invalid\n');
  const job = extra => ({ id: 'j', agent: 'ollama', model: 'm', prompt: 'x', context: ['.env.example'], outputs: ['out.txt'], timeoutMs: 5000, ...extra });
  // Old behavior: "Reserved or secret path: .env.example" for any context path starting with .env.
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [job()] }));
  assert.throws(() => validateManifest({ version: 1, jobs: [job({ context: ['.env'] })] }), /Reserved or secret path/);
  assert.throws(() => validateManifest({ version: 1, jobs: [job({ outputs: ['.env.example'] })] }), /Reserved or secret path/);
  const env = contextEnvFor(root, null);
  assert.equal(env.exists('.env.example'), true);
  assert.equal(env.exists('.env'), false);
  for (const ok of ['.env.example', '.env.local.example', 'config.example.json']) assert.equal(isExampleFile(ok), true, ok);
  for (const no of ['.env', '.env.local', 'id_rsa.example', '.env.example.bak']) assert.equal(isExampleFile(no), false, no);
  // A ticket may name it as context.
  const ticket = tk('T-0009', 'R-002', 'S2', { context: ['.env.example'], status: 'ready' });
  const { manifest } = ticketsToManifest([ticket], { ledger: { tickets: [] }, scope: parseScope(SCOPE), ready: true, contextEnv: env });
  assert.ok(manifest.jobs[0].context.includes('.env.example'));
  validateManifest(manifest);
});
