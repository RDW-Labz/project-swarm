// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guardBoardAction, REFUSED_KINDS, ALLOWED_KINDS } from '../tools/board-action-guard.mjs';

const contractUrl = new URL('../contracts/watch-s4-ops.json', import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, 'utf8'));

const sources = ['board', 'phone'];

test('exports the frozen refused-kind contract', () => {
  assert.deepEqual(REFUSED_KINDS, ['merge', 'deploy', 'cap-raise', 'spend', 'key', 'migration']);
  assert.equal(Object.isFrozen(REFUSED_KINDS), true);
});

test('ALLOWED_KINDS equals the contract allowedKinds enum', () => {
  assert.deepEqual(ALLOWED_KINDS, contract.components?.schemas?.allowedKinds?.enum);
  assert.equal(Object.isFrozen(ALLOWED_KINDS), true);
});

test('allows approve and deny for every allowed item kind', () => {
  for (const source of sources) {
    for (const itemKind of ALLOWED_KINDS) {
      assert.deepEqual(guardBoardAction({ source, kind: 'approve', itemKind }), {
        allowed: true,
        reason: 'allowed',
      });
      assert.deepEqual(guardBoardAction({ source, kind: 'deny', itemKind }), {
        allowed: true,
        reason: 'allowed',
      });
    }
  }
});

test('refuses limit-up as not an allowed action kind', () => {
  for (const source of sources) {
    assert.deepEqual(guardBoardAction({ source, kind: 'approve', itemKind: 'limit-up' }), {
      allowed: false,
      reason: 'not an allowed action kind',
    });
    assert.deepEqual(guardBoardAction({ source, kind: 'deny', itemKind: 'limit-up' }), {
      allowed: false,
      reason: 'not an allowed action kind',
    });
  }
});

test('refuses disallowed and protected item kinds', () => {
  const refused = [
    'human',
    'blocker',
    'held-ticket',
    'cap',
    'cap-increase',
    'capRaise',
    'budget',
    'deploy-preview',
    'merge-request',
    '',
    null,
    42,
  ];
  for (const source of sources) {
    for (const itemKind of refused) {
      const out = guardBoardAction({ source, kind: 'approve', itemKind });
      assert.equal(out.allowed, false);
      assert.ok(
        out.reason === 'item-kind-refused' || out.reason === 'not an allowed action kind',
        `expected refusal for ${String(itemKind)}, got ${out.reason}`,
      );
    }
  }
});

test('refuses every protected kind from board and phone paths', () => {
  for (const source of sources) {
    for (const kind of REFUSED_KINDS) {
      assert.deepEqual(guardBoardAction({ source, kind, itemKind: 'scope' }), {
        allowed: false,
        reason: 'kind-refused',
      });
      assert.deepEqual(guardBoardAction({ source, kind: 'approve', itemKind: kind }), {
        allowed: false,
        reason: 'item-kind-refused',
      });
    }
  }
});

test('matches protected kinds after trimming and case folding', () => {
  for (const source of sources) {
    for (const kind of REFUSED_KINDS) {
      const variant = `  ${kind.toUpperCase()}  `;
      assert.equal(guardBoardAction({ source, kind: variant, itemKind: 'scope' }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'approve', itemKind: variant }).allowed, false);
    }
  }
});

test('refuses unknown and non-string decision kinds', () => {
  for (const source of sources) {
    for (const kind of ['review', 'approve-now', '', '   ', null, undefined, 7, {}]) {
      assert.deepEqual(guardBoardAction({ source, kind, itemKind: 'scope' }), {
        allowed: false,
        reason: 'kind-refused',
      });
    }
  }
});

test('refuses unknown sources', () => {
  for (const source of ['web', 'api', '', ' BOARD ', null, undefined, 7]) {
    assert.deepEqual(guardBoardAction({ source, kind: 'approve', itemKind: 'scope' }), {
      allowed: false,
      reason: 'source-refused',
    });
  }
});

test('refuses cap, budget, spend-limit, and related owner-action kind variants', () => {
  const refusedItemKinds = [
    'cap_raise',
    'raise cap',
    'limit-raise',
    'spend-limit',
    'keys',
    'api-secret',
    'migrate-db',
    'rollback-prod',
    'MERGE',
    'deployNow',
  ];
  for (const source of sources) {
    for (const itemKind of refusedItemKinds) {
      assert.equal(guardBoardAction({ source, kind: 'approve', itemKind }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'deny', itemKind }).allowed, false);
    }
  }
});
