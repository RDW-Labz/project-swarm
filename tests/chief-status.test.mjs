import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotShares, formatStatus } from '../tools/chief-status.mjs';

test('slotShares computes share of the cap for active projects only', () => {
  const { cap, rows } = slotShares({
    cap: 4,
    projects: [
      { name: 'alpha', active: true, slots: 2 },
      { name: 'beta', active: true, slots: 1 },
      { name: 'gamma', active: false, slots: 1 },
    ],
  });
  assert.equal(cap, 4);
  assert.deepEqual(rows.map((r) => r.name), ['alpha', 'beta']);
  assert.equal(rows[0].share, 0.5);
  assert.equal(rows[1].share, 0.25);
});

test('slotShares rejects a non-positive cap', () => {
  assert.throws(() => slotShares({ cap: 0, projects: [] }), TypeError);
});

test('slotShares rejects negative slots', () => {
  assert.throws(
    () => slotShares({ cap: 2, projects: [{ name: 'a', active: true, slots: -1 }] }),
    TypeError,
  );
});

test('formatStatus lists every active project with its slot count', () => {
  const text = formatStatus({
    cap: 4,
    projects: [
      { name: 'beta', active: true, slots: 1 },
      { name: 'alpha', active: true, slots: 2 },
    ],
  });
  const lines = text.split('\n');
  assert.match(lines[0], /2 active project\(s\), cap 4 slots/);
  assert.match(lines[1], /^alpha\s+2\/4\s+50\.0%$/);
  assert.match(lines[2], /^beta\s+1\/4\s+25\.0%$/);
});

test('formatStatus reports zero active projects', () => {
  assert.equal(
    formatStatus({ cap: 4, projects: [{ name: 'a', active: false, slots: 0 }] }),
    'chief: 0 active projects (cap 4 slots)',
  );
});
