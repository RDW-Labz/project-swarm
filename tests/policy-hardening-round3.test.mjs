// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  decide,
  effectiveRulesFromOverrides,
  loadPolicy,
  normalizeBranchName,
  normalizePolicyProject,
  policyInitializedMarkerPath,
  protectedBranchState,
} from '../tools/policy.mjs';
import { policyCommand } from '../tools/policy-commands.mjs';
import { runPolicyPass } from '../tools/policy-run.mjs';

const rules = () => effectiveRulesFromOverrides([]);

test('round3-1: persist failure before apply leaves item and skips apply', async () => {
  let applied = false;
  const item = { id: 'persist-fail', kind: 'ticket-retry', project: 'p' };
  const prev = process.env.SWARM_TEST_TMP;
  delete process.env.SWARM_TEST_TMP;
  const r = await runPolicyPass({
    root: '/tmp/policy-round3-no-persist',
    items: [item],
    rules: rules(),
    factsOf: () => ({}),
    apply: async () => { applied = true; },
    journal: () => {},
    events: () => {},
    readHandled: () => [],
  });
  if (prev !== undefined) process.env.SWARM_TEST_TMP = prev;
  assert.equal(applied, false);
  assert.equal(r.decided.length, 0);
  assert.equal(r.left.length, 1);
});

test('round3-2: missing or invalid pastDailyAutoLimit dep blocks cap-raise in pass', async () => {
  const item = { id: 'cap-limit', kind: 'cap-raise', project: 'app' };
  const noKey = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [item],
    rules: rules(),
    factsOf: () => ({ amountUsd: 1 }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [],
    limits: {},
  });
  assert.equal(noKey.decided.length, 0);

  const bad = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [{ ...item, id: 'cap-limit-2' }],
    rules: rules(),
    factsOf: () => ({ amountUsd: 1 }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [],
    limits: { pastDailyAutoLimit: 'no' },
  });
  assert.equal(bad.decided.length, 0);
});

test('round3-3: merge-live-site rejects undefined guard facts', () => {
  const live = {
    repoClass: 'swarm',
    deploysLiveSite: true,
    ciGreen: true,
    fullE2eGreen: true,
    reviewsPass: true,
    postDeployWatch: true,
    autoRollback: true,
    inMergeOrder: true,
    irreversible: false,
    pastDailyAutoLimit: false,
  };
  assert.equal(decide({ kind: 'merge-pr', id: 'm', facts: live }, { rules: rules() }).decision, 'auto-approve');
  assert.equal(
    decide({ kind: 'merge-pr', id: 'm', facts: { ...live, irreversible: undefined } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'merge-pr', id: 'm', facts: { ...live, pastDailyAutoLimit: undefined } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('round3-4: workflow-change with undefined isNewWorkflow needs owner', () => {
  assert.equal(
    decide(
      {
        kind: 'workflow-change',
        id: 'w',
        facts: { opusReviewPassed: true, addsSecrets: false, addsDeploy: false, addsPublish: false },
      },
      { rules: rules() },
    ).decision,
    'needs-owner',
  );
  assert.equal(
    decide(
      {
        kind: 'workflow-change',
        id: 'w',
        facts: {
          opusReviewPassed: true,
          isNewWorkflow: false,
          addsSecrets: false,
          addsDeploy: false,
          addsPublish: false,
        },
      },
      { rules: rules() },
    ).decision,
    'auto-approve',
  );
});

test('round3-5: apply throw logs apply-failed once and does not count toward caps', async () => {
  const journal = [];
  const today = new Date().toISOString();
  const item = { id: 'apply-boom', kind: 'ticket-retry', project: 'p' };
  const r = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [item],
    rules: effectiveRulesFromOverrides([{ id: 'ticket-routine', maxPerDay: 1 }]),
    factsOf: () => ({}),
    apply: async () => { throw new Error('boom'); },
    journal: e => { journal.push(e); },
    events: () => {},
    readHandled: () => [],
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(r.decided.length, 0);
  assert.equal(r.left.length, 1);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, 'apply-failed');

  const capPass = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [
      { id: 'apply-boom', kind: 'ticket-retry', project: 'p' },
      { id: 'apply-ok', kind: 'ticket-park', project: 'p' },
    ],
    rules: effectiveRulesFromOverrides([{ id: 'ticket-routine', maxPerDay: 2 }]),
    factsOf: () => ({}),
    apply: async ({ item }) => {
      if (item.id === 'apply-boom') throw new Error('boom');
    },
    journal: () => {},
    events: () => {},
    readHandled: () => [{ kind: 'auto-decision', rule: 'ticket-routine', requestId: 'other', at: today }],
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(capPass.decided.length, 1);
  assert.equal(capPass.decided[0].id, 'apply-ok');
});

test('round3-6: readHandled missing or throwing fails closed', async () => {
  const item = { id: 'rh', kind: 'ticket-retry', project: 'p' };
  const missing = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [item],
    rules: rules(),
    factsOf: () => ({}),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(missing.decided.length, 0);
  assert.equal(missing.left.length, 1);

  const throwing = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [item],
    rules: rules(),
    factsOf: () => ({}),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => { throw new Error('ledger down'); },
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(throwing.decided.length, 0);
});

test('round3-7: cap-raise requires project and sums per normalized project per Central day', async () => {
  assert.equal(
    decide({ kind: 'cap-raise', id: 'c', project: '  ', facts: { amountUsd: 1, pastDailyAutoLimit: false } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(normalizePolicyProject('  MyApp '), 'myapp');

  const today = new Date().toISOString();
  const item = { id: 'cap-norm', kind: 'cap-raise', project: '  MyApp ' };
  const r = await runPolicyPass({
    root: '/tmp/policy-round3',
    items: [item],
    rules: rules(),
    factsOf: () => ({ amountUsd: 2 }),
    apply: async () => {},
    journal: () => {},
    events: () => {},
    readHandled: () => [
      { kind: 'auto-decision', requestKind: 'cap-raise', project: 'myapp', amountUsd: 4, at: today },
    ],
    limits: { pastDailyAutoLimit: false },
  });
  assert.equal(r.decided.length, 0);
});

test('round3-8: protectedBranch covers HEAD remotes and upstream-style names', () => {
  assert.equal(protectedBranchState('HEAD'), 'protected');
  assert.equal(protectedBranchState('refs/remotes/upstream/main'), 'protected');
  assert.equal(protectedBranchState('upstream/main'), 'protected');
  assert.equal(normalizeBranchName('refs/heads/main'), 'main');
  assert.equal(
    decide({ kind: 'branch-switch', id: 'b', facts: { branch: 'refs/remotes/fork/main', force: false } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('round3-9: journal-restore only allows the four generated routing paths', () => {
  const ok = {
    files: [
      'coordination/HANDOFF.md',
      'docs/state/usage-ledger.md',
      'coordination/TASK.md',
      'docs/scope/build-plan.md',
    ],
  };
  assert.equal(decide({ kind: 'journal-restore', id: 'j', facts: ok }, { rules: rules() }).decision, 'auto-approve');
  assert.equal(
    decide({ kind: 'journal-restore', id: 'j', facts: { files: ['.swarm/journal-1.json'] } }, { rules: rules() }).decision,
    'needs-owner',
  );
  assert.equal(
    decide({ kind: 'journal-restore', id: 'j', facts: { files: ['TASK.md'] } }, { rules: rules() }).decision,
    'needs-owner',
  );
});

test('round3-10: projects empty list, init marker guard, and show fail-closed text', () => {
  const narrowed = effectiveRulesFromOverrides([{ id: 'ticket-routine', projects: [] }]);
  assert.equal(decide({ kind: 'ticket-retry', id: 't', project: 'any', facts: {} }, { rules: narrowed }).decision, 'needs-owner');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-r3-init-'));
  const env = { HOME: dir };
  const outLines = [];
  const out = t => { outLines.push(t); };
  const markerOnly = path.join(dir, '.config', 'project-swarm');
  fs.mkdirSync(markerOnly, { recursive: true });
  const policyFile = path.join(markerOnly, 'policy.json');
  fs.writeFileSync(policyInitializedMarkerPath(policyFile), 'marked\n');
  outLines.length = 0;
  policyCommand(['init'], { out, env, home: dir, fs });
  assert.match(outLines.join(''), /refused|not overwritten/i);

  outLines.length = 0;
  policyCommand(['show'], { out, env, home: dir, fs });
  const showText = outLines.join('');
  assert.match(showText, /failing closed/i);
  assert.match(showText, /\[enabled\]/);

  const badMarker = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-r3-marker-'));
  const badFile = path.join(badMarker, 'policy.json');
  fs.writeFileSync(policyInitializedMarkerPath(badFile), 'x\n', { mode: 0o000 });
  const loaded = loadPolicy(badFile, { fs });
  assert.ok(loaded.error);
  assert.equal(loaded.rules.length, 0);
  fs.chmodSync(policyInitializedMarkerPath(badFile), 0o600);
});
