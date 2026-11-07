// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateChildManifest,
  validateLeadArea,
  leadPromptBlock,
  isEmptyChildManifest,
  leadBlockIsOutOfScopeOnly,
  settleLeadOutcome,
} from '../tools/leads.mjs';

const lead = (area = {}) => ({
  id: 'lead-fleet',
  type: 'lead',
  agent: 'codex',
  outputs: ['plans/fleet.json'],
  area: { goal: 'Add docs/fleet.md', scope: ['fleet/'], ...area },
});
const worker = fields => ({ id: 'worker', agent: 'codex', prompt: 'Build it', outputs: ['fleet/x.js'], ...fields });
const options = (area = {}) => ({ lead: lead(area), area: validateLeadArea(lead(area)), parentManifest: {} });

test('empty child manifest validates', () => {
  const empty = { version: 1, jobs: [] };
  const result = validateChildManifest(empty, options());
  assert.deepEqual(result.jobs, []);
  assert.equal(result.version, 1);
});

test('isEmptyChildManifest', () => {
  assert.equal(isEmptyChildManifest({ version: 1, jobs: [] }), true);
  assert.equal(isEmptyChildManifest({ version: 1, jobs: [worker()] }), false);
  assert.equal(isEmptyChildManifest(null), false);
  assert.equal(isEmptyChildManifest({ version: 1 }), false);
});

test('lead prompt mentions empty manifest when scope has nothing to do', () => {
  const job = lead();
  const text = leadPromptBlock({ job, area: validateLeadArea(job), outputPath: 'plans/fleet.json' });
  assert.match(
    text,
    /If nothing in your scope needs to change for this goal, write \{"version":1,"jobs":\[\]\} as your manifest and finish with status complete/,
  );
  assert.match(text, /do not report blocked for that/);
});

test('leadBlockIsOutOfScopeOnly', () => {
  assert.equal(leadBlockIsOutOfScopeOnly('docs/fleet.md is outside the assigned fleet/ scope'), true);
  assert.equal(leadBlockIsOutOfScopeOnly('needs an API key'), false);
  assert.equal(leadBlockIsOutOfScopeOnly('blocked: missing credentials'), false);
});

test('settleLeadOutcome empty manifest', () => {
  assert.deepEqual(settleLeadOutcome({ child: { version: 1, jobs: [] } }), {
    startChildRun: false,
    status: 'complete',
    warning: null,
  });
});

test('settleLeadOutcome out-of-scope-only block', () => {
  assert.deepEqual(
    settleLeadOutcome({
      report: { status: 'blocked', summary: 'docs/fleet.md is outside the assigned fleet/ scope' },
    }),
    { startChildRun: false, status: 'complete', warning: 'lead-out-of-scope-ignored' },
  );
});

test('settleLeadOutcome real block', () => {
  assert.deepEqual(settleLeadOutcome({ report: { status: 'blocked', summary: 'needs an API key' } }), {
    startChildRun: true,
    status: null,
    warning: null,
  });
});

test('settleLeadOutcome normal manifest', () => {
  assert.deepEqual(settleLeadOutcome({ child: { version: 1, jobs: [worker()] } }), {
    startChildRun: true,
    status: null,
    warning: null,
  });
});
