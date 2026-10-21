// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { centralDayKey } from '../tools/daily-limit.mjs';
import {
  decide,
  effectiveRulesFromOverrides,
  normalizePolicyProjectPath,
} from '../tools/policy.mjs';
import { runPolicyPass } from '../tools/policy-run.mjs';

const rules = () => effectiveRulesFromOverrides([]);

const handBuildOk = {
  files: ['coordination/task.md', '.gitignore'],
  git: ['commit', 'push'],
  branch: 'feat/x',
};

test('round4-1: missing or invalid branch blocks hand-build and commit-push', () => {
  assert.equal(
    decide({ kind: 'hand-build-request', id: 'h', facts: { ...handBuildOk, branch: undefined } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'hand-build-request', id: 'h', facts: { ...handBuildOk, branch: null } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'hand-build-request', id: 'h', facts: { ...handBuildOk, branch: 42 } }, { rules: rules() }).decision,
    'needs-owner',
  );
  // Missing branch with empty git used to skip gitFactsOk and could imply push to main.
  assert.equal(
    decide(
      {
        kind: 'hand-build-request',
        id: 'h',
        facts: { files: handBuildOk.files, git: [], branch: undefined },
      },
      { rules: rules() },
    ).decision,
    'needs-owner',
  );
  assert.equal(
    decide(
      { kind: 'commit-push-swarm-branch', id: 'c', facts: { allSwarmProduced: true, branch: '' } },
      { rules: rules() },
    ).decision,
    'needs-owner',
  );
  assert.equal(
    decide(
      { kind: 'commit-push-swarm-branch', id: 'c', facts: { allSwarmProduced: true, branch: null } },
      { rules: rules() },
    ).decision,
    'needs-owner',
  );
});

test('round4-2: cap-raise uses one normalized project and refuses mismatches', async () => {
  const root = fs.mkdtempSync(path.join(process.env.SWARM_TEST_TMP || '/tmp', 'policy-r4-cap-'));
  const item = { id: 'cap-mismatch', kind: 'cap-raise', project: 'alpha' };
  const mismatch = await runPolicyPass({
    root,
    items: [item],
    rules: rules(),
    factsOf: () => ({ amountUsd: 1, project: 'beta', pastDailyAutoLimit: false }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [],
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(mismatch.decided.length, 0);
  assert.equal(mismatch.left.length, 1);

  const todayMs = Date.parse('2026-06-15T18:00:00.000Z');
  const now = () => todayMs;
  const norm = normalizePolicyProjectPath('  MyApp ', root);
  assert.equal(norm, 'myapp');
  const ok = await runPolicyPass({
    root,
    items: [{ id: 'cap-ok', kind: 'cap-raise', project: '  MyApp ' }],
    rules: rules(),
    factsOf: () => ({ amountUsd: 2, project: 'myapp', pastDailyAutoLimit: false }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [
      {
        kind: 'auto-decision',
        requestKind: 'cap-raise',
        project: 'myapp',
        amountUsd: 4,
        at: new Date(todayMs).toISOString(),
      },
    ],
    now,
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(ok.decided.length, 0);
});

test('round4-3: ticket-set-status explicit status and done synonyms', () => {
  const reviewGate = { requiresReview: true, reviewPassed: false };
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { ...reviewGate } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { foo: 'done', ...reviewGate } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { to: '  Completed ', ...reviewGate } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { newStatus: 'shipped', requiresReview: false } }, { rules: rules() }).decision,
    'auto-approve',
  );
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { status: 'in-progress', ...reviewGate } }, { rules: rules() }).decision,
    'auto-approve',
  );
});

test('round4-4: cap allowance day uses US Central not UTC', async () => {
  const utcDay = '2024-01-01';
  const centralMs = Date.parse(`${utcDay}T05:30:00.000Z`);
  assert.notEqual(new Date(centralMs).toISOString().slice(0, 10), centralDayKey(() => centralMs));

  const root = fs.mkdtempSync(path.join(process.env.SWARM_TEST_TMP || '/tmp', 'policy-r4-day-'));
  const eventAt = new Date(centralMs).toISOString();
  const now = () => Date.parse('2024-01-01T07:00:00.000Z');
  const r = await runPolicyPass({
    root,
    items: [{ id: 'cap-day', kind: 'cap-raise', project: 'app' }],
    rules: rules(),
    factsOf: () => ({ amountUsd: 2, pastDailyAutoLimit: false }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [
      { kind: 'auto-decision', requestKind: 'cap-raise', project: 'app', amountUsd: 4, at: eventAt },
    ],
    now,
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(r.decided.length, 1);

  const swarmSrc = fs.readFileSync(path.join(process.cwd(), 'tools/swarm.mjs'), 'utf8');
  assert.match(swarmSrc, /centralDayKey\(\(\) => ms\)/);
});
