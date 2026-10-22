// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JOB_TYPES } from '../tools/job-types.mjs';
import {
  DIAGNOSE_OUTPUT_MAX_LINE_CHARS,
  DIAGNOSE_OUTPUT_MAX_LINES,
  DIAGNOSE_MAX_USD,
  buildDiagnoseManifest,
  capDiagnoseContext,
  diagnoseFailureLine,
  diagnoseRun,
  formatDiagnoseSummaryLines,
  parseDiagnoseArgs,
  pathsFromQuestion,
  selectDiagnoseContextFiles,
} from '../tools/diagnose.mjs';

test('formatDiagnoseSummaryLines caps lines and characters', () => {
  const longLine = 'a'.repeat(DIAGNOSE_OUTPUT_MAX_LINE_CHARS + 40);
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const out = formatDiagnoseSummaryLines([longLine, ...many].join('\n'));
  assert.equal(out.length, DIAGNOSE_OUTPUT_MAX_LINES);
  assert.equal(out[0].length, DIAGNOSE_OUTPUT_MAX_LINE_CHARS);
  assert.equal(out[0], 'a'.repeat(DIAGNOSE_OUTPUT_MAX_LINE_CHARS));
  assert.equal(out[1], 'line 0');
});

test('parseDiagnoseArgs reads question, files, lane, and json', () => {
  const parsed = parseDiagnoseArgs(['why?', '--files', 'a.mjs,b.mjs', '--lane', 'hermes', '--json']);
  assert.equal(parsed.question, 'why?');
  assert.deepEqual(parsed.explicit, ['a.mjs', 'b.mjs']);
  assert.equal(parsed.lane, 'hermes');
  assert.equal(parsed.json, true);
  assert.equal(parseDiagnoseArgs(['--help']).help, true);
});

test('buildDiagnoseManifest is a one-job diagnose run with spend cap', () => {
  const { manifest } = { manifest: buildDiagnoseManifest({ question: 'why fail?', files: ['tools/x.mjs'], id: 'd-1' }) };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.concurrency, 1);
  assert.equal(manifest.budget.maxUsd, DIAGNOSE_MAX_USD);
  const job = manifest.jobs[0];
  assert.equal(job.type, 'diagnose');
  assert.equal(job.agent, 'auto');
  assert.deepEqual(job.outputs, []);
  assert.deepEqual(job.context, ['tools/x.mjs']);
  assert.deepEqual(job.typeRoute, JOB_TYPES.diagnose.route);
  const pinned = buildDiagnoseManifest({ question: 'x', files: [], lane: 'cursor', id: 'd-2' }).jobs[0];
  assert.equal(pinned.agent, 'cursor');
});

test('pathsFromQuestion and context selection respect cursor tracked files', () => {
  assert.deepEqual(pathsFromQuestion('see tools/router.mjs:12 and docs/a.md'), ['tools/router.mjs', 'docs/a.md']);
  const exists = file => ['tools/router.mjs', 'scratch.txt'].includes(file);
  const tracked = ['tools/router.mjs'];
  assert.deepEqual(
    selectDiagnoseContextFiles({ explicit: ['scratch.txt'], question: 'tools/router.mjs', exists, tracked, lane: 'cursor', sizeOf: () => 10 }),
    ['tools/router.mjs'],
  );
  assert.deepEqual(
    selectDiagnoseContextFiles({ explicit: ['scratch.txt'], question: 'see tools/router.mjs', exists, tracked, lane: null, sizeOf: () => 10 }),
    ['scratch.txt', 'tools/router.mjs'],
  );
});

test('capDiagnoseContext stops when total bytes exceed cap', () => {
  const files = ['a', 'b', 'c'];
  const sizes = { a: 100, b: 100, c: 100 };
  assert.deepEqual(capDiagnoseContext(files, f => sizes[f], 250), ['a', 'b']);
});

test('diagnoseFailureLine is one line naming why and lane', () => {
  const line = diagnoseFailureLine({ status: 'failed', agent: 'hermes', error: 'lane paused\nnow' });
  assert.ok(line.includes('hermes'));
  assert.ok(line.includes('lane paused'));
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.length <= DIAGNOSE_OUTPUT_MAX_LINE_CHARS);
});

test('diagnoseRun uses injected runner and prints capped summary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-diagnose-cmd-'));
  const summary = 'Cause: bad map.\nEvidence: tools/router.mjs:1.\nNext: fix TYPE_MAP.';
  let seenManifest = null;
  const result = await diagnoseRun(
    root,
    { question: 'why?', explicit: ['tools/router.mjs'], lane: null, json: false },
    {
      runWithIdRetry: async (_prefix, _opts, attempt) => {
        const id = 'diag-test-1';
        const { state } = await attempt(id);
        return { id, state };
      },
      writeJson: async (_root, rel, manifest) => { seenManifest = { rel, manifest }; },
      exists: async file => file === 'tools/router.mjs',
      trackedFiles: async () => ['tools/router.mjs'],
      runManifest: async (_root, manifest) => {
        assert.equal(manifest.jobs[0].type, 'diagnose');
        return {
          status: 'complete',
          jobs: [{
            id: manifest.jobs[0].id,
            status: 'complete',
            agent: 'hermes',
            response: JSON.stringify({ status: 'complete', summary }),
          }],
        };
      },
      now: () => '2026-01-01T00:00:00.000Z',
    },
  );
  assert.equal(result.ok, true);
  assert.ok(seenManifest.rel.includes('.swarm/diagnose/runs/'));
  assert.deepEqual(result.lines, formatDiagnoseSummaryLines(summary));
  const log = JSON.parse((await fs.readFile(path.join(root, '.swarm/diagnose/log.ndjson'), 'utf8')).trim());
  assert.equal(log.question, 'why?');
  assert.equal(log.runId, 'diag-test-1');
});

test('diagnoseRun failure returns one failure line', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-diagnose-fail-'));
  const result = await diagnoseRun(
    root,
    { question: 'why?', explicit: [], lane: 'cursor', json: false },
    {
      runWithIdRetry: async (_p, _o, attempt) => {
        const id = 'diag-fail-1';
        return { id, state: (await attempt(id)).state };
      },
      writeJson: async () => {},
      exists: async () => false,
      runManifest: async () => ({
        status: 'failed',
        jobs: [{ id: 'diag-fail-1', status: 'failed', agent: 'cursor', error: 'no model configured' }],
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.failureLine, diagnoseFailureLine({ status: 'failed', agent: 'cursor', error: 'no model configured' }));
});
