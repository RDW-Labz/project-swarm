// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeLedger, appendLog } from '../tools/tickets.mjs';
import { LOG_FILE } from '../tools/handbuild.mjs';
import { buildFieldExport, exportFieldFile, FAILURE_CAUSES, VERSION } from '../tools/field-export.mjs';

const CANARY_SOURCE = 'CANARY_FIELD_EXPORT_SOURCE_9f3a';
const CANARY_DIFF = 'CANARY_FIELD_EXPORT_DIFF_9f3a';
const CANARY_PROMPT = 'CANARY_FIELD_EXPORT_PROMPT_9f3a';
const GH = 'gh' + 'p_' + 'b'.repeat(36);
const TOKENISH = 'Xk3mQ9pL2sR7vN4tB8wY1zD6cF0hJ5gK8mN2pQ4rS6tU';

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'field-export-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const silenceReaders = {
  readHandbuildLog: async () => [],
  readHandbuildRequests: async () => [],
  readWaveEvents: async () => [],
  readWaveSlots: async () => [],
};

async function seedProject(root) {
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'run-a'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'scope', 'waves'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'leak.ts'), `// ${CANARY_SOURCE}\nexport const x = 1;\n`);
  const longSentence = 'word '.repeat(200).trim();
  const ledger = {
    version: 1,
    scope: { file: 'docs/scope.md', hash: 'abc' },
    tickets: [{
      id: 'T-0001',
      title: 'fixture ticket',
      type: 'build',
      scopeRefs: ['R-001'],
      acceptance: ['passes'],
      size: 'S',
      risk: 'low',
      status: 'review',
      lane: 'claude:sonnet',
      retryNote: `contact user@example.com or +1 (415) 555-0199; token ${TOKENISH}`,
      waveAt: '2026-01-01T00:00:00.000Z',
      attempts: 2,
    }, {
      id: 'T-0002',
      title: 'long note only',
      type: 'build',
      scopeRefs: ['R-001'],
      acceptance: ['passes'],
      size: 'S',
      risk: 'low',
      status: 'ready',
      retryNote: longSentence,
    }],
    approved: { by: 'owner', at: '2026-01-01T00:00:00.000Z', hash: 'x' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await writeLedger(root, ledger);
  await appendLog(root, { event: 'wave', by: 'go', tickets: ['T-0001'], readyAtStart: 1 });
  await fs.writeFile(path.join(root, 'docs', 'scope', 'waves', 'wave-abc.json'), JSON.stringify({ version: 1, concurrency: 4, jobs: [] }));
  const state = {
    id: 'run-a',
    status: 'complete',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:10:00.000Z',
    jobs: [{
      id: 'T-0001',
      agent: 'claude',
      model: 'sonnet',
      tier: 'cheap',
      status: 'failed',
      error: `failed checks: tests; ${CANARY_DIFF}`,
      prompt: CANARY_PROMPT,
      diff: CANARY_DIFF,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:05:00.000Z',
      durationMs: 300000,
      costUsd: 0.12,
      costSource: 'reported',
      attempts: [{ status: 'failed' }, { status: 'failed' }],
    }],
  };
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'run-a', 'state.json'), JSON.stringify(state));
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, LOG_FILE), `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: 'blocked', tool: 'Edit', files: ['src/leak.ts'] })}\n`, { mode: 0o600 });
}

const TOP_KEYS = ['version', 'machine', 'project', 'generatedAt', 'tickets', 'jobs', 'waves', 'guard', 'totals', 'dropped'];
const TICKET_KEYS = ['id', 'wave', 'lane', 'model', 'status', 'retries', 'retryNotes', 'failureCause', 'startedAt', 'finishedAt', 'durationMs'];
const JOB_KEYS = ['runId', 'jobId', 'lane', 'model', 'tier', 'status', 'costUsd', 'costSource', 'durationMs', 'retries', 'failureCause'];
const WAVE_KEYS = ['id', 'tickets', 'readyAtStart', 'slots'];
const BLOCK_KEYS = ['at', 'kind', 'rule'];
const HB_KEYS = ['id', 'kind', 'status', 'decidedBy', 'decidedAt', 'reasonCategory'];

function assertShape(exportObj) {
  assert.deepEqual(Object.keys(exportObj).sort(), TOP_KEYS.sort());
  for (const t of exportObj.tickets) assert.deepEqual(Object.keys(t).sort(), TICKET_KEYS.sort());
  for (const j of exportObj.jobs) assert.deepEqual(Object.keys(j).sort(), JOB_KEYS.sort());
  for (const w of exportObj.waves) assert.deepEqual(Object.keys(w).sort(), WAVE_KEYS.sort());
  for (const b of exportObj.guard.blocks) assert.deepEqual(Object.keys(b).sort(), BLOCK_KEYS.sort());
  for (const h of exportObj.guard.handbuildRequests) assert.deepEqual(Object.keys(h).sort(), HB_KEYS.sort());
  assert.equal(typeof exportObj.totals.perLane, 'object');
}

test('buildFieldExport redacts sensitive retry notes and omits canaries and absolute paths', async t => {
  const root = await tmp(t);
  await seedProject(root);
  const exportObj = await buildFieldExport({
    root,
    machine: 'dev-box',
    project: 'demo',
    now: Date.UTC(2026, 0, 2),
    readers: { readHandbuildRequests: async () => [] },
  });
  assertShape(exportObj);
  assert.equal(exportObj.version, VERSION);
  assert.equal(exportObj.machine, 'dev-box');
  assert.equal(exportObj.project, 'demo');
  assert.equal(exportObj.tickets[0].retryNotes, null);
  assert.ok(exportObj.dropped >= 1);
  const longOnly = 'word '.repeat(200).trim().slice(0, 300);
  assert.equal(exportObj.tickets[1].retryNotes?.length, 300);
  assert.equal(exportObj.tickets[1].retryNotes, longOnly);
  const blob = JSON.stringify(exportObj);
  assert.ok(!blob.includes('user@example.com'));
  assert.ok(!blob.includes('555-0199'));
  assert.ok(!blob.includes(TOKENISH));
  assert.ok(!blob.includes(CANARY_SOURCE));
  assert.ok(!blob.includes(CANARY_DIFF));
  assert.ok(!blob.includes(CANARY_PROMPT));
  assert.ok(!blob.includes(root));
  assert.ok(!/\/Users\/|\/home\//.test(blob));
  assert.ok(FAILURE_CAUSES.includes(exportObj.jobs[0].failureCause));
  assert.equal(exportObj.waves[0].slots, 4);
  assert.equal(exportObj.waves[0].readyAtStart, 1);
});

test('exportFieldFile writes mode 0600 under .swarm/field', async t => {
  const root = await tmp(t);
  await seedProject(root);
  const { file, bytes, dropped } = await exportFieldFile({
    root,
    machine: 'm1',
    project: 'demo',
    now: Date.UTC(2026, 0, 2),
    readers: { readHandbuildRequests: async () => [] },
  });
  assert.ok(file.includes('.swarm/field/demo-m1.json'));
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(bytes > 50);
  assert.ok(dropped >= 1);
});

test('a secret that slips into the export object makes buildFieldExport throw without echoing the value', async t => {
  const root = await tmp(t);
  await seedProject(root);
  const secret = GH;
  await assert.rejects(
    () => buildFieldExport({
      root,
      machine: 'm',
      project: 'p',
      now: Date.UTC(2026, 0, 2),
      readers: {
        ...silenceReaders,
        extraExport: { surprise: secret },
      },
    }),
    err => {
      assert.match(err.message, /^field-export-secret-hit:/);
      assert.ok(!err.message.includes(secret));
      assert.ok(!err.message.includes('ghp_'));
      return true;
    },
  );
});
