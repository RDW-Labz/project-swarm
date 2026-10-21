// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_POLICY_FILE,
  DEFAULT_RULES,
  NEVER_AUTO,
  autoDecisionEvent,
  decide,
  effectiveRulesFromOverrides,
  handledForYou,
  loadPolicy,
  policyPath,
  validatePolicy,
} from '../tools/policy.mjs';
import { policyCommand, POLICY_USAGE } from '../tools/policy-commands.mjs';

const defaultRules = () => effectiveRulesFromOverrides([]);

test('policyPath uses the same folder as machine config', () => {
  const home = '/tmp/home';
  const env = { HOME: home, XDG_CONFIG_HOME: '/xdg' };
  assert.equal(policyPath(env, home), path.join('/xdg', 'project-swarm', 'policy.json'));
  const env2 = { HOME: home, SWARM_CONFIG: '/custom/config.json' };
  assert.equal(policyPath(env2, home), path.join('/custom', 'policy.json'));
});

test('standing default rules auto-approve with the right facts', () => {
  const rules = defaultRules();
  const mergeFacts = {
    repoClass: 'swarm',
    ciGreen: true,
    reviewsPass: true,
    fullSuiteGreen: true,
    inMergeOrder: true,
    deploysLiveSite: false,
  };
  assert.equal(decide({ kind: 'merge-pr', id: 'm1', facts: mergeFacts }, { rules }).decision, 'auto-approve');

  assert.equal(
    decide({ kind: 'swarm-update', id: 'u1', facts: { machineIdle: true, afterReleaseMerge: true } }, { rules }).decision,
    'auto-approve',
  );

  assert.equal(
    decide({ kind: 'commit-push-swarm-branch', id: 'r1', project: 'p', facts: { branch: 'feat', allSwarmProduced: true } }, { rules }).decision,
    'auto-approve',
  );

  const handBuild = {
    files: ['coordination/HANDOFF.md', '.gitignore'],
    git: ['commit', 'push'],
    branch: 'feat',
  };
  assert.equal(decide({ kind: 'hand-build-request', id: 'h1', facts: handBuild }, { rules }).decision, 'auto-approve');

  for (const kind of ['ticket-park', 'ticket-retry', 'ticket-release']) {
    assert.equal(decide({ kind, id: 't', facts: {} }, { rules }).decision, 'auto-approve');
  }
  assert.equal(
    decide({ kind: 'ticket-set-status', id: 't', facts: { status: 'in-progress' } }, { rules }).decision,
    'auto-approve',
  );

  for (const kind of ['change-order-path-fix', 'change-order-split']) {
    assert.equal(
      decide({ kind, id: 'x', project: 'proj', facts: { project: 'proj' } }, { rules }).decision,
      'auto-approve',
    );
  }

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
      { rules },
    ).decision,
    'auto-approve',
  );

  assert.equal(
    decide(
      {
        kind: 'cap-raise',
        id: 'c',
        project: 'demo',
        facts: { amountUsd: 2, raisedTodayUsd: 3, pastDailyAutoLimit: false },
      },
      { rules },
    ).decision,
    'auto-approve',
  );

  const acceptFacts = { failingChecks: ['policy-test'], newTestChecks: ['policy-test'], otherChecksPassing: true };
  assert.equal(decide({ kind: 'accept-failed-checks', id: 'a1', facts: acceptFacts }, { rules }).decision, 'auto-approve');
});

test('accept-failed-checks needs all three conditions', () => {
  const rules = defaultRules();
  const base = { failingChecks: ['policy-test'], newTestChecks: ['policy-test'], otherChecksPassing: true };
  assert.equal(decide({ kind: 'accept-failed-checks', id: 'a', facts: base }, { rules }).decision, 'auto-approve');
  assert.equal(decide({ kind: 'accept-failed-checks', id: 'a', facts: { ...base, failingChecks: ['lint', 'policy-test'] } }, { rules }).decision, 'needs-owner');
  assert.equal(decide({ kind: 'accept-failed-checks', id: 'a', facts: { ...base, failingChecks: [] } }, { rules }).decision, 'needs-owner');
  assert.equal(decide({ kind: 'accept-failed-checks', id: 'a', facts: { ...base, otherChecksPassing: false } }, { rules }).decision, 'needs-owner');
});

test('every NEVER_AUTO kind is needs-owner even when rules would allow it', () => {
  const rules = defaultRules();
  for (const kind of NEVER_AUTO) {
    const result = decide({ kind, id: 'n1', project: 'p', facts: { project: 'p', branch: 'feat', allSwarmProduced: true } }, { rules });
    assert.equal(result.decision, 'needs-owner');
    assert.equal(result.reason, 'owner-only');
  }
  const errors = validatePolicy({ rules: [{ id: 'spend-past-daily-limit', enabled: false }] });
  assert.ok(errors.some(e => e.includes('can never be auto-approved')));
  const kindErrors = validatePolicy({ rules: [{ id: 'ticket-routine', kind: 'deploy' }] });
  assert.ok(kindErrors.some(e => e.includes('unknown field')));
});

test('malformed rules file gives no auto rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, '{not json');
  const bad = loadPolicy(file, { fs });
  assert.ok(bad.error);
  assert.equal(bad.rules.length, 0);
  assert.equal(decide({ kind: 'ticket-retry', id: 'r', facts: {} }, { rules: bad.rules }).decision, 'needs-owner');

  fs.writeFileSync(file, JSON.stringify({ rules: [{ id: 'not-a-rule' }] }));
  const invalid = loadPolicy(file, { fs });
  assert.ok(invalid.error);
  assert.equal(invalid.rules.length, 0);
});

test('missing policy file uses built-in defaults', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-')), 'missing.json');
  const loaded = loadPolicy(file, { fs });
  assert.equal(loaded.error, null);
  assert.equal(loaded.rules.length, DEFAULT_RULES.length);
});

test('maxPerDay and projects narrowing', () => {
  const rules = effectiveRulesFromOverrides([
    { id: 'ticket-routine', projects: ['only'] },
    { id: 'ticket-routine', maxPerDay: 1 },
  ]);
  assert.equal(decide({ kind: 'ticket-retry', id: 'r', project: 'other', facts: {} }, { rules }).decision, 'needs-owner');
  assert.equal(decide({ kind: 'ticket-retry', id: 'r', project: 'only', facts: {} }, { rules }).decision, 'auto-approve');

  assert.equal(
    decide({ kind: 'ticket-park', id: 'p', project: 'only', facts: { autoToday: { 'ticket-routine': 0 } } }, { rules }).decision,
    'auto-approve',
  );
  assert.equal(
    decide({ kind: 'ticket-park', id: 'p', project: 'only', facts: { autoToday: { 'ticket-routine': 1 } } }, { rules }).decision,
    'needs-owner',
  );
});

test('autoDecisionEvent has no request free text', () => {
  const request = {
    kind: 'ticket-retry',
    id: 'req-1',
    project: 'demo',
    title: 'please retry the wave',
    reason: 'because I said so',
    description: 'long free text',
  };
  const result = { decision: 'auto-approve', rule: 'ticket-routine', reason: 'policy match' };
  const event = autoDecisionEvent(request, result, { now: () => 1_700_000_000_000, machine: 'rig-a' });
  assert.equal(event.kind, 'auto-decision');
  assert.equal(event.requestKind, 'ticket-retry');
  assert.equal(event.requestId, 'req-1');
  assert.equal(event.project, 'demo');
  assert.equal(event.machine, 'rig-a');
  assert.equal(event.rule, 'ticket-routine');
  assert.equal(event.reason, 'policy match');
  assert.equal(Object.hasOwn(event, 'title'), false);
  assert.equal(Object.hasOwn(event, 'description'), false);
  assert.equal(JSON.stringify(event).includes('please retry'), false);
});

test('handledForYou filters auto-decision newest first', () => {
  const events = [
    { kind: 'auto-decision', at: '2026-01-01T00:00:00.000Z', requestId: 'old' },
    { kind: 'note', at: '2026-01-02T00:00:00.000Z' },
    { kind: 'auto-decision', at: '2026-01-03T00:00:00.000Z', requestId: 'new' },
  ];
  const got = handledForYou(events, { limit: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0].requestId, 'new');
});

test('policyCommand show, validate, path, and init', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cmd-'));
  const home = dir;
  const env = { HOME: home };
  const configDir = path.join(home, '.config', 'project-swarm');
  fs.mkdirSync(configDir, { recursive: true });
  const policyFile = path.join(configDir, 'policy.json');
  const chunks = [];
  const out = text => chunks.push(text);

  const codePath = policyCommand(['path'], { out, env, home, fs });
  assert.equal(codePath, 0);
  assert.equal(chunks.join('').trim(), policyFile);

  chunks.length = 0;
  const codeShow = policyCommand(['show'], { out, env, home, fs });
  assert.equal(codeShow, 0);
  const showText = chunks.join('');
  assert.match(showText, /Never auto-approved/);
  assert.match(showText, /merge-other-repo/);
  assert.match(showText, /new-account/);
  assert.match(showText, /irreversible-action/);
  assert.match(showText, /merge-swarm-pr:/);
  assert.match(showText, /merge-live-site:/);
  assert.match(showText, /hosted-migration:/);
  assert.match(showText, /commit-push-swarm-branch:/);

  chunks.length = 0;
  assert.equal(policyCommand(['validate'], { out, env, home, fs }), 0);
  assert.match(chunks.join(''), /ok/);

  chunks.length = 0;
  assert.equal(policyCommand(['init'], { out, env, home, fs }), 0);
  assert.match(chunks.join(''), /Wrote default policy/);
  const written = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  assert.equal(written.version, DEFAULT_POLICY_FILE.version);
  assert.equal(written.rules.length, DEFAULT_RULES.length);

  chunks.length = 0;
  assert.equal(policyCommand(['init'], { out, env, home, fs }), 0);
  assert.match(chunks.join(''), /already exists/);

  fs.writeFileSync(policyFile, JSON.stringify({ rules: [{ id: 'ticket-routine', enabled: false }] }));
  chunks.length = 0;
  assert.equal(policyCommand(['validate'], { out, env, home, fs }), 0);

  fs.writeFileSync(policyFile, '{');
  chunks.length = 0;
  assert.equal(policyCommand(['validate'], { out, env, home, fs }), 1);

  chunks.length = 0;
  assert.equal(policyCommand(['nope'], { out, env, home, fs }), 2);
  assert.match(chunks.join(''), new RegExp(POLICY_USAGE.split('\n')[0]));
});
