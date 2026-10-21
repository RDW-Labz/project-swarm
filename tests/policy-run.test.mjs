// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveRulesFromOverrides } from '../tools/policy.mjs';
import { runPolicyPass, appendAutoDecision } from '../tools/policy-run.mjs';

const CANARY = 'CANARY_FREE_TEXT_NEVER_LOGGED_12345';

function baseRules(overrides = []) {
  return effectiveRulesFromOverrides(overrides);
}

describe('runPolicyPass', () => {
  it('auto-approves once and logs to journal and events without request free text', async () => {
    const journal = [];
    const evts = [];
    let applyCount = 0;
    const item = { id: 'req-1', kind: 'retry', project: 'p1', raw: CANARY };
    const rules = baseRules();
    const r1 = await runPolicyPass({
      root: '/tmp/proj',
      items: [item],
      rules,
      factsOf: () => ({ project: 'p1' }),
      apply: async () => { applyCount += 1; },
      journal: e => { journal.push(e); },
      events: e => { evts.push(e); },
      machine: 'm1',
      readHandled: () => [],
    });
    assert.equal(applyCount, 1);
    assert.equal(r1.decided.length, 1);
    assert.equal(r1.left.length, 0);
    assert.equal(journal.length, 1);
    assert.equal(evts.length, 1);
    assert.equal(journal[0].kind, 'auto-decision');
    assert.equal(journal[0].requestId, 'req-1');
    const blob = JSON.stringify([journal[0], evts[0]]);
    assert.ok(!blob.includes(CANARY));

    const r2 = await runPolicyPass({
      root: '/tmp/proj',
      items: [item],
      rules,
      factsOf: () => ({ project: 'p1' }),
      apply: async () => { applyCount += 1; },
      journal: e => { journal.push(e); },
      events: e => { evts.push(e); },
      readHandled: () => [{ kind: 'auto-decision', requestId: 'req-1', rule: 'retry', at: new Date().toISOString() }],
    });
    assert.equal(applyCount, 1);
    assert.equal(r2.decided.length, 0);
  });

  it('leaves needs-owner items in left', async () => {
    const item = { id: 'req-2', kind: 'retry', project: 'p1', raw: '' };
    const r = await runPolicyPass({
      root: '/tmp',
      items: [item],
      rules: baseRules(),
      factsOf: () => ({}),
      apply: async () => {},
      journal: () => {},
      events: () => {},
      readHandled: () => [],
    });
    assert.equal(r.decided.length, 0);
    assert.equal(r.left.length, 1);
    assert.equal(r.left[0].id, 'req-2');
  });

  it('refuses NEVER_AUTO kinds even when a rule lists the kind', async () => {
    const item = { id: 'req-merge', kind: 'merge-main', project: 'p1', raw: '' };
    const r = await runPolicyPass({
      root: '/tmp',
      items: [item],
      rules: baseRules(),
      factsOf: () => ({ project: 'p1' }),
      apply: async () => { throw new Error('should not apply'); },
      journal: () => {},
      events: () => {},
      readHandled: () => [],
    });
    assert.equal(r.decided.length, 0);
    assert.equal(r.left.length, 1);
  });

  it('records policy-error and leaves item when apply throws', async () => {
    const journal = [];
    const item = { id: 'req-3', kind: 'retry', project: 'p1', raw: '' };
    const r = await runPolicyPass({
      root: '/tmp',
      items: [item],
      rules: baseRules(),
      factsOf: () => ({ project: 'p1' }),
      apply: async () => { throw new Error('boom'); },
      journal: e => { journal.push(e); },
      events: () => {},
      readHandled: () => [],
    });
    assert.equal(r.decided.length, 0);
    assert.equal(r.left.length, 1);
    assert.equal(r.errors.length, 1);
    assert.equal(journal[0].kind, 'policy-error');
    assert.equal(journal[0].requestId, 'req-3');
    assert.equal(journal[0].requestKind, 'retry');
    assert.equal(journal[0].raw, undefined);
  });

  it('makes no decisions when rules could not be loaded', async () => {
    const item = { id: 'req-4', kind: 'retry', project: 'p1', raw: '' };
    const r = await runPolicyPass({
      root: '/tmp',
      items: [item],
      rules: null,
      factsOf: () => ({ project: 'p1' }),
      apply: async () => {},
      journal: () => {},
      events: () => {},
      readHandled: () => [],
    });
    assert.equal(r.decided.length, 0);
    assert.equal(r.left.length, 1);
  });

  it('enforces maxPerPass', async () => {
    const items = [
      { id: 'a', kind: 'retry', project: 'p', raw: '' },
      { id: 'b', kind: 'retry', project: 'p', raw: '' },
      { id: 'c', kind: 'retry', project: 'p', raw: '' },
    ];
    const r = await runPolicyPass({
      root: '/tmp',
      items,
      rules: baseRules(),
      factsOf: () => ({ project: 'p' }),
      apply: async () => {},
      journal: () => {},
      events: () => {},
      limits: { maxPerPass: 2 },
      readHandled: () => [],
    });
    assert.equal(r.decided.length, 2);
    assert.equal(r.left.length, 1);
  });

  it('enforces maxPerDay via readHandled counts', async () => {
    const today = new Date().toISOString();
    const rules = baseRules([{ id: 'retry', maxPerDay: 1 }]);
    const item = { id: 'req-5', kind: 'retry', project: 'p1', raw: '' };
    const r = await runPolicyPass({
      root: '/tmp',
      items: [item],
      rules,
      factsOf: () => ({ project: 'p1' }),
      apply: async () => {},
      journal: () => {},
      events: () => {},
      readHandled: () => [{ kind: 'auto-decision', rule: 'retry', requestId: 'other', at: today }],
    });
    assert.equal(r.decided.length, 0);
    assert.equal(r.left.length, 1);
  });

  it('never auto-applies elevated git ops on hand-build requests', async () => {
    const item = {
      id: 'handbuild-hb-abc',
      kind: 'retry',
      project: 'p1',
      raw: '',
    };
    let applied = false;
    const r = await runPolicyPass({
      root: '/tmp',
      items: [item],
      rules: baseRules(),
      factsOf: () => ({ project: 'p1', git: ['merge'] }),
      apply: async () => { applied = true; },
      journal: () => {},
      events: () => {},
      readHandled: () => [],
    });
    assert.equal(applied, false);
    assert.equal(r.decided.length, 0);
    assert.equal(r.left.length, 1);
  });
});

describe('appendAutoDecision', () => {
  it('writes journal and events lines via injected deps', async () => {
    const journal = [];
    const evts = [];
    await appendAutoDecision({
      root: '/tmp/r',
      entry: {
        kind: 'auto-decision',
        at: '2026-01-02T12:00:00.000Z',
        rule: 'retry',
        requestKind: 'retry',
        requestId: 'x',
        project: 'p',
        machine: 'm',
        reason: 'policy match',
      },
      deps: {
        appendJournal: async (_root, line) => { journal.push(line); },
        appendEvents: async (_root, line) => { evts.push(line); },
      },
    });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].ts, '2026-01-02T12:00:00.000Z');
    assert.equal(journal[0].kind, 'auto-decision');
    assert.equal(evts.length, 1);
    assert.equal(evts[0].kind, 'auto-decision');
    assert.equal(evts[0].requestId, 'x');
  });
});
