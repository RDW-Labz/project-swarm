// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardBoardAction, REFUSED_KINDS } from '../tools/board-action-guard.mjs';

const sources = ['board', 'phone'];
const allowedItem = 'question';

test('exports the frozen refused-kind contract', () => {
  assert.deepEqual(REFUSED_KINDS, ['merge', 'deploy', 'cap-raise', 'spend', 'key', 'migration']);
  assert.equal(Object.isFrozen(REFUSED_KINDS), true);
});

test('refuses every protected kind from board and phone paths', () => {
  for (const source of sources) {
    for (const kind of REFUSED_KINDS) {
      assert.deepEqual(guardBoardAction({ source, kind, itemKind: allowedItem }), {
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
      assert.equal(guardBoardAction({ source, kind: variant, itemKind: allowedItem }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'approve', itemKind: variant }).allowed, false);
    }
  }
});

test('refuses protected prefixes only when followed by a separator', () => {
  for (const source of sources) {
    for (const kind of REFUSED_KINDS) {
      const qualified = `${kind}-request`;
      assert.equal(guardBoardAction({ source, kind: qualified, itemKind: allowedItem }).allowed, false);
      assert.equal(guardBoardAction({ source, kind: 'approve', itemKind: qualified }).allowed, false);
    }
    assert.equal(guardBoardAction({ source, kind: 'approve', itemKind: 'merger' }).allowed, true);
  }
});

test('refuses unknown and non-string kinds', () => {
  for (const source of sources) {
    for (const kind of ['review', 'approve-now', '', '   ', null, undefined, 7, {}]) {
      assert.deepEqual(guardBoardAction({ source, kind, itemKind: allowedItem }), {
        allowed: false,
        reason: 'kind-refused',
      });
    }
  }
});

test('refuses unknown sources and malformed item kinds', () => {
  for (const source of ['web', 'api', '', ' BOARD ', null, undefined, 7]) {
    assert.deepEqual(guardBoardAction({ source, kind: 'approve', itemKind: allowedItem }), {
      allowed: false,
      reason: 'source-refused',
    });
  }
  for (const itemKind of ['', '   ', null, undefined, 7, {}, 'deploy-request']) {
    assert.deepEqual(guardBoardAction({ source: 'board', kind: 'approve', itemKind }), {
      allowed: false,
      reason: 'item-kind-refused',
    });
  }
});

test('allows only approve and deny decisions on non-protected items', () => {
  for (const source of sources) {
    for (const kind of ['approve', 'deny', ' APPROVE ', ' DenY ']) {
      assert.deepEqual(guardBoardAction({ source, kind, itemKind: allowedItem }), {
        allowed: true,
        reason: 'allowed',
      });
    }
  }
});
