// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_TYPES } from '../tools/job-types.mjs';
import {
  ticketsToManifest,
  ticketOutcome,
  DIAGNOSE_SUMMARY_MAX,
  truncateDiagnoseSummary,
  parseDiagnoseResultLine,
  diagnoseSummaryFromJob,
  diagnoseLedgerFieldsOnIntegrate,
  applyDiagnoseEvidenceFromRunSync,
} from '../tools/ticket-manifest.mjs';
import { parseScope } from '../tools/scope.mjs';

const SCOPE_MD = `# Scope: Diagnose fixture
Version: 1

## Overview
Fixture.

## Stages
- S1: One

## S1 One
### R-001 A thing works.
Acceptance:
- It works.

## Sensitive
-

## Protected
-
`;

const scope = parseScope(SCOPE_MD);

function ticket(over = {}) {
  return {
    id: 'T-0001', title: 'Why did the check fail?', type: 'diagnose', stage: 'S1', epic: 'E-01',
    scopeRefs: ['R-001'], acceptance: [], files: [], context: ['tools/router.mjs'],
    contracts: [], dependsOn: [], size: 'S', risk: 'low', sensitive: false, status: 'ready', ...over,
  };
}

test('diagnose ticket maps to a diagnose job with no outputs or tests', () => {
  const { manifest, warnings, skipped } = ticketsToManifest([ticket()], { scope });
  assert.deepEqual(skipped, []);
  assert.equal(warnings.length, 0);
  const job = manifest.jobs[0];
  assert.equal(job.type, 'diagnose');
  assert.equal(job.agent, 'auto');
  assert.deepEqual(job.outputs, []);
  assert.equal('tests' in job, false);
});

test('diagnose summary cap is enforced when parsing and recording', () => {
  const long = 'x'.repeat(DIAGNOSE_SUMMARY_MAX + 400);
  const line = JSON.stringify({ status: 'complete', summary: long });
  const parsed = parseDiagnoseResultLine(`prose\n${line}`);
  assert.equal(parsed.summary.length, DIAGNOSE_SUMMARY_MAX);
  assert.equal(truncateDiagnoseSummary(long).length, DIAGNOSE_SUMMARY_MAX);
  const fromJob = diagnoseSummaryFromJob({ response: line });
  assert.equal(fromJob.length, DIAGNOSE_SUMMARY_MAX);
  const fields = diagnoseLedgerFieldsOnIntegrate(ticket(), { response: line });
  assert.equal(fields.evidence.length, DIAGNOSE_SUMMARY_MAX);
});

test('ticketOutcome and run sync attach capped evidence for diagnose tickets', () => {
  const summary = 'Likely cause: bad route. Evidence: tools/router.mjs:28. Next: fix TYPE_MAP.';
  const ledger = { tickets: [ticket({ id: 'T-0001', status: 'running' })] };
  const state = {
    'T-0001': {
      status: 'complete',
      response: JSON.stringify({ status: 'complete', summary }),
    },
  };
  const moves = ticketOutcome(state, ledger);
  assert.deepEqual(moves, [{ id: 'T-0001', to: 'review', note: 'run complete', evidence: summary }]);
  applyDiagnoseEvidenceFromRunSync(ledger, moves, state);
  assert.equal(ledger.tickets[0].evidence, summary);
});

test('diagnose job type routes hermes then cursor and writes none', () => {
  assert.deepEqual(JOB_TYPES.diagnose.route, ['hermes', 'cursor']);
  assert.equal(JOB_TYPES.diagnose.writes, 'none');
  assert.equal(JOB_TYPES.diagnose.route.includes('claude'), false);
  assert.ok(JOB_TYPES.diagnose.promptLine.includes('1200'));
});
