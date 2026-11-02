// SPDX-License-Identifier: Apache-2.0
// S13: escalated tickets (maxOutputTokens from the first retry, hard at level 2, tier expensive at level 3) and pinned lanes must plan on real wave manifests.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ticketsToManifest } from '../tools/ticket-manifest.mjs';
import { validateProject, unroutableJobs } from '../tools/swarm.mjs';

const t = (id, extra = {}) => ({ id, title: id, type: 'build', status: 'ready', files: [`src/${id}.ts`], acceptance: ['it works'], scopeRefs: [], dependsOn: [], size: 'S', ...extra });
const contextEnv = { exists: () => false, sizes: {}, profileContext: [], listFiles: () => [], limits: {} };
const lanes = { cursor: { model: 'composer-2.5' }, codex: { model: 'gpt-6.1-sol' }, anthropic: { model: 'claude-haiku-5-5' }, claude: { model: 'sonnet', midModel: 'sonnet', expensiveModel: 'opus' } };

async function project(t2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-esc-'));
  t2.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'));
  return root;
}
const wave = tickets => { const m = ticketsToManifest(tickets, { ledger: { tickets }, contextEnv, laneModels: lanes }).manifest; m.lanes = lanes; return m; };
const env = { HOME: os.tmpdir(), PATH: process.env.PATH };

test('an escalated ticket plans at every level: level 1 on Cursor, level 2 hard on Codex, level 3 (tier expensive) on claude:opus', async t2 => {
  const root = await project(t2);
  const out = {};
  for (const level of [0, 1, 2, 3]) {
    const manifest = wave([t(`T-000${level}`, { escalation: level })]);
    const v = await validateProject(root, manifest, { env });
    out[level] = v.routes[0];
  }
  assert.equal(out[0].agent, 'cursor');
  assert.equal(out[1].agent, 'cursor');
  assert.equal(out[2].agent, 'codex', 'hard ticket: codex first');
  assert.equal(out[3].agent, 'claude');
  assert.equal(out[3].model, 'opus');
});

test('pinning any lane plans on a real wave manifest, escalated or not', async t2 => {
  const root = await project(t2);
  for (const lane of ['codex', 'cursor', 'claude:sonnet', 'claude:opus', 'anthropic']) {
    for (const escalation of [0, 2]) {
      const manifest = wave([t('T-0100', { lane, escalation })]);
      const job = manifest.jobs[0];
      if (!lane.startsWith('anthropic')) assert.equal(job.maxOutputTokens, undefined, `${lane}: no output limit on a CLI lane`);
      await validateProject(root, manifest, { env });
    }
  }
});

test('a ticket no lane can take is reported and left out; the rest of the wave plans', async t2 => {
  const root = await project(t2);
  const manifest = wave([t('T-0200'), t('T-0201', { escalation: 3 })]);
  // no claude lane: the expensive ticket has nowhere to go
  const noClaude = { ...manifest, lanes: { cursor: lanes.cursor, codex: lanes.codex, anthropic: lanes.anthropic, claude: { model: null } } };
  const bad = await unroutableJobs(root, noClaude, { env });
  assert.deepEqual(bad.map(b => b.id), ['T-0201']);
  assert.match(bad[0].reason, /route-exhausted/);
  assert.deepEqual((await unroutableJobs(root, manifest, { env })), []);
});
