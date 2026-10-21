// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it } from 'node:test';
import { decide, effectiveRulesFromOverrides } from '../tools/policy.mjs';
import {
  autopilotStep,
  executePolicyPass,
  filterPolicyPassItems,
  policyPassFacts,
} from '../tools/autopilot.mjs';

const NOW = Date.parse('2030-01-01T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-policy-'));
}

function baseRules() {
  return effectiveRulesFromOverrides([]);
}

describe('executePolicyPass', () => {
  it('no-ops when loadRules returns null (no policy file)', async () => {
    const root = await tempRoot();
    let opened = false;
    const r = await executePolicyPass(root, {
      policyPass: {
        loadRules: async () => null,
        openRequests: async () => { opened = true; return [{ id: 't1', kind: 'ticket-retry', project: 'p' }]; },
        apply: async () => {},
      },
    }, { now: () => NOW });
    assert.equal(opened, false);
    assert.equal(r.skipped, true);
    assert.equal(r.decided.length, 0);
  });

  it('auto-approves an allowed ticket request and logs a decision', async () => {
    const root = await tempRoot();
    const journal = [];
    const applied = [];
    const item = { id: 'ticket-1', kind: 'ticket-retry', project: 'p1' };
    const r = await executePolicyPass(root, {
      policyPass: {
        loadRules: async () => baseRules(),
        openRequests: async () => [item],
        billedTodayUsd: async () => 0,
        dailyLimitSettings: async () => ({}),
        apply: async ({ item: it }) => { applied.push(it.id); },
        appendAutoDecisionDeps: {
          appendJournal: async (r, entry) => { journal.push(entry); },
          appendEvents: async () => {},
        },
      },
    }, { now: () => NOW });
    assert.deepEqual(applied, ['ticket-1']);
    assert.equal(r.decided.length, 1);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].kind, 'auto-decision');
    assert.equal(journal[0].requestId, 'ticket-1');
  });

  it('leaves elevated hand-build requests out of the pass', async () => {
    const root = await tempRoot();
    const items = [
      { id: 'hb-1', kind: 'hand-build-request', project: 'p', facts: { git: ['merge'], files: ['TASK.md'] } },
      { id: 'hb-2', kind: 'hand-build-request', project: 'p', facts: { git: ['commit'], files: ['TASK.md'], branch: 'swarm/x' } },
    ];
    assert.equal(filterPolicyPassItems(items).length, 1);
    let applied = [];
    const r = await executePolicyPass(root, {
      policyPass: {
        loadRules: async () => baseRules(),
        openRequests: async () => items,
        factsOf: item => item.facts ?? {},
        apply: async ({ item: it }) => { applied.push(it.id); },
        appendAutoDecisionDeps: { appendJournal: async () => {}, appendEvents: async () => {} },
      },
    }, { now: () => NOW });
    assert.deepEqual(applied, ['hb-2']);
    assert.equal(r.decided.length, 1);
  });

  it('provides pastDailyAutoLimit on facts so policy blocks cap-raise', async () => {
    const item = { id: 'cap-1', kind: 'cap-raise', project: 'p' };
    const facts = policyPassFacts({
      billedTodayUsd: 10,
      settings: { project: { usd: 5, mode: 'stop' } },
      factsOf: () => ({ amountUsd: 1, raisedTodayUsd: 0 }),
      item,
    });
    assert.equal(facts.pastDailyAutoLimit, true);
    const decision = decide(
      { kind: 'cap-raise', id: item.id, project: item.project, facts },
      { rules: baseRules() },
    );
    assert.equal(decision.decision, 'needs-owner');
    assert.match(decision.reason, /past daily auto limit/);
  });

  it('refuses cap-raise without a project', () => {
    const facts = { amountUsd: 1, raisedTodayUsd: 0, pastDailyAutoLimit: false };
    const decision = decide({ kind: 'cap-raise', id: 'cap-no-project', facts }, { rules: baseRules() });
    assert.equal(decision.decision, 'needs-owner');
    assert.match(decision.reason, /project missing/);
  });
});

describe('autopilotStep policyPass hook', () => {
  it('invokes policyPass during a step without breaking idle runs', async () => {
    const root = await tempRoot();
    let called = false;
    const journal = [];
    const deps = {
      readJournal: async () => [],
      appendEvent: async (r, event) => { journal.push({ ...event, ts: iso(NOW) }); },
      loadRuns: async () => [],
      readPlan: async () => null,
      policyPass: {
        loadRules: async () => null,
        openRequests: async () => { called = true; return []; },
        apply: async () => {},
      },
    };
    const step = await autopilotStep(root, deps, { now: () => NOW });
    assert.equal(called, false);
    assert.equal(step.idle, true);
    assert.equal(step.actions.length, 0);
  });
});
