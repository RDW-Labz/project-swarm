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
  const tickets = [t('T-0001'), t('T-0193', { files: ['src/a.ts', 'src/dir/'], tests: ['tests/a.test.ts'] })];
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
