// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { expandTicketRefs } from '../tools/ticket-refs.mjs';
import { reviewManifest } from '../tools/acceptance.mjs';
import { securityReviewManifest } from '../tools/security-review.mjs';
import { validateManifest } from '../tools/swarm.mjs';

const t = (id, extra = {}) => ({ id, title: id, type: 'build', status: 'todo', files: [`src/${id}.ts`], acceptance: ['it works'], scopeRefs: [], dependsOn: [], ...extra });
const contextEnv = { exists: () => true, sizes: {}, profileContext: [], listFiles: () => [], limits: {} };

test('a ticket pinned to a non-Anthropic lane carries no cacheContext and the manifest validates', () => {
  const ledger = { tickets: [t('T-0001', { lane: 'codex', risk: 'high', contracts: ['docs/contract.md'] })] };
  const { manifest } = ticketsToManifest(ledger.tickets, { ledger, contract: 'docs/contract.md', contextEnv, laneModels: { codex: { model: 'gpt-6.1-sol' } } });
  const unpinned = ticketsToManifest([t('T-0001', { risk: 'high', contracts: ['docs/contract.md'] })], { ledger, contract: 'docs/contract.md', contextEnv }).manifest.jobs[0];
  assert.ok(unpinned.cacheContext?.length, 'the same ticket unpinned has a cacheContext (so the pin test means something)');
  const job = manifest.jobs[0];
  assert.equal(job.agent, 'codex');
  assert.equal(job.model, 'gpt-6.1-sol');
  assert.equal(job.cacheContext, undefined);
  assert.doesNotThrow(() => validateManifest(manifest));
});

test('ticket ids in context resolve to that ticket\'s files, and unknown ids are dropped', () => {
  const tickets = [t('T-0001'), t('T-0193', { status: 'done', files: ['src/a.ts', 'src/dir/'], tests: ['tests/a.test.ts'] })];
  assert.deepEqual(expandTicketRefs(['T-0193', 'README.md', 'T-9999'], tickets), ['src/a.ts', 'tests/a.test.ts', 'README.md']);
  const user = t('T-0002', { context: ['T-0193'] });
  const { manifest } = ticketsToManifest([user], { ledger: { tickets: [...tickets, user] } });
  assert.deepEqual(manifest.jobs[0].context.sort(), ['src/a.ts', 'tests/a.test.ts']);
});

test('review manifests list the files of a ticket named in context', async () => {
  const tickets = [t('T-0193', { files: ['src/a.ts'] })];
  const item = { ticket: t('T-0002', { context: ['T-0193'] }), uncovered: ['it works'] };
  const m = reviewManifest('run1', [item], { tickets });
  assert.ok(m.jobs[0].context.includes('src/a.ts'));
  assert.ok(!m.jobs[0].context.includes('T-0193'));
  const sec = await securityReviewManifest('/nonexistent-root', 'run1', [{ ticket: item.ticket }], tickets);
  assert.ok(!sec.jobs[0].context.includes('T-0193'));
});

import { resolveLanes } from '../tools/lanes.mjs';
test('the claude lane takes tier models; other lanes refuse them; a bad name is refused', () => {
  const lanes = resolveLanes({ config: { lanes: { claude: { model: 'sonnet', midModel: 'sonnet', expensiveModel: 'opus' } } } });
  assert.equal(lanes.claude.expensiveModel, 'opus');
  assert.throws(() => resolveLanes({ config: { lanes: { codex: { expensiveModel: 'x' } } } }), /is unknown/);
  assert.throws(() => resolveLanes({ config: { lanes: { claude: { expensiveModel: 'bad name!' } } } }), /valid model name/);
});

test('a ticket reference never hands on secret files, the project profile or globs', () => {
  const tickets = [t('T-0193', { files: ['.env.local', 'app/.env', '.project-swarm.json', 'src/*.ts', '.env.example', 'src/ok.ts'] })];
  assert.deepEqual(expandTicketRefs(['T-0193'], tickets), ['.env.example', 'src/ok.ts']);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, markerPath, restoreIfStale } from '../tools/concurrency-guard.mjs';
test('a guard marker from before the last boot is stale even if its pid is alive, and a second apply is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ machineConcurrency: 4 }));
  apply(file, 16);
  assert.throws(() => apply(file, 8), /another guarded run/);
  // Same pid (alive) but written a year before: a reboot's pid reuse
  const marker = JSON.parse(fs.readFileSync(markerPath(file), 'utf8'));
  fs.writeFileSync(markerPath(file), JSON.stringify({ ...marker, at: new Date(Date.now() - 365 * 864e5).toISOString() }));
  assert.equal(restoreIfStale(file).restored, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).machineConcurrency, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

import { applyJobType } from '../tools/job-types.mjs';
import { routeJob } from '../tools/router.mjs';
test('routes by job type: Cursor first for build, fix and docs; cursor first for test; paused lane hands on', () => {
  const lanes = { cursor: { model: 'u' }, codex: { model: 'c' }, anthropic: { model: 'h' }, claude: { model: 'sonnet' } };
  const cursorLanePaused = { lanes: { ...lanes, cursor: { ...lanes.cursor, paused: true } } };
  for (const type of ['build', 'fix', 'docs']) {
    const outputs = type === 'docs' ? ['docs/a.md'] : ['src/a.ts'];
    const { job } = applyJobType({ id: 'j', agent: 'auto', type, prompt: 'p', sensitive: false, outputs });
    assert.equal(routeJob(job, { lanes }).agent, 'cursor', type);
    assert.equal(routeJob(job, cursorLanePaused).agent, 'anthropic', `${type}: paused cursor hands on`);
  }
  for (const type of ['test']) {
    const { job } = applyJobType({ id: 'j', agent: 'auto', type, prompt: 'p', sensitive: false, outputs: ['src/a.test.ts'] });
    assert.equal(routeJob(job, { lanes }).agent, 'cursor', type);
    assert.equal(routeJob(job, cursorLanePaused).agent, 'codex', `${type}: paused cursor hands on`);
  }
});
