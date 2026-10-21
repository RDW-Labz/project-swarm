// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handledForProject, sanitizeHandledString } from '../tools/handled.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'handled-test-'));

function writeNdjson(root, rel, lines) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
}

const decision = (over = {}) => ({
  kind: 'auto-decision',
  at: '2026-10-20T12:00:00.000Z',
  rule: 'auto-merge',
  requestKind: 'pr',
  requestId: '42',
  project: 'demo',
  machine: 'host-a',
  reason: 'policy ok',
  ...over,
});

test('missing files return zeros', async () => {
  const root = tmpRoot();
  const r = await handledForProject(root);
  assert.deepEqual(r, { today: 0, week: 0, total: 0, items: [], byRule: {} });
});

test('reads both files, ignores other kinds and bad lines, de-dupes twins', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-10-20T15:00:00.000Z');
  const eventsAt = '2026-10-20T12:00:00.000Z';
  const journalTs = '2026-10-20T12:00:01.000Z';
  writeNdjson(root, '.swarm/orchestrator/events.ndjson', [
    JSON.stringify({ kind: 'noise' }),
    'not json',
    JSON.stringify(decision({ at: eventsAt, requestId: 'dup' })),
    JSON.stringify(decision({ at: '2026-10-19T12:00:00.000Z', requestId: 'old', rule: 'stale' })),
  ]);
  writeNdjson(root, '.swarm/project/journal.ndjson', [
    JSON.stringify({ kind: 'auto-decision', ts: journalTs, rule: 'auto-merge', requestKind: 'pr', requestId: 'dup', reason: 'journal', machine: 'host-a' }),
    JSON.stringify(decision({ at: '2026-10-20T13:00:00.000Z', requestId: 'only-journal', rule: 'notify' })),
  ]);

  const r = await handledForProject(root, { now });
  assert.equal(r.total, 3);
  assert.equal(r.today, 2);
  assert.equal(r.week, 3);
  assert.deepEqual(r.byRule, { 'auto-merge': 1, notify: 1 });
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].requestId, 'only-journal');
  assert.equal(r.items[1].requestId, 'dup');
  assert.equal(r.items[2].requestId, 'old');
});

test('limit and newest-first order', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-10-20T20:00:00.000Z');
  writeNdjson(root, '.swarm/orchestrator/events.ndjson', [
    JSON.stringify(decision({ at: '2026-10-20T10:00:00.000Z', requestId: 'a' })),
    JSON.stringify(decision({ at: '2026-10-20T18:00:00.000Z', requestId: 'b' })),
    JSON.stringify(decision({ at: '2026-10-20T14:00:00.000Z', requestId: 'c' })),
  ]);

  const r = await handledForProject(root, { now, limit: 2 });
  assert.equal(r.total, 3);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(i => i.requestId), ['b', 'c']);
});

test('today and week use UTC day and rolling seven days', async () => {
  const root = tmpRoot();
  const now = Date.parse('2026-10-20T08:00:00.000Z');
  writeNdjson(root, '.swarm/orchestrator/events.ndjson', [
    JSON.stringify(decision({ at: '2026-10-20T01:00:00.000Z', requestId: 'today', rule: 'r1' })),
    JSON.stringify(decision({ at: '2026-10-19T23:00:00.000Z', requestId: 'yesterday', rule: 'r2' })),
    JSON.stringify(decision({ at: '2026-10-13T12:00:00.000Z', requestId: 'week-edge', rule: 'r3' })),
    JSON.stringify(decision({ at: '2026-10-12T23:59:59.000Z', requestId: 'too-old', rule: 'r4' })),
  ]);

  const r = await handledForProject(root, { now });
  assert.equal(r.today, 1);
  assert.equal(r.week, 3);
  assert.equal(r.total, 4);
  assert.deepEqual(r.byRule, { r1: 1 });
});

test('sanitizeHandledString trims, strips control chars, and caps length', () => {
  const long = 'x'.repeat(200);
  const dirty = `  hello\u0007world\u001f\n`;
  assert.equal(sanitizeHandledString(dirty), 'helloworld');
  assert.equal(sanitizeHandledString(long).length, 120);

  const root = tmpRoot();
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  writeNdjson(root, '.swarm/orchestrator/events.ndjson', [
    JSON.stringify(decision({
      at: '2026-10-20T12:00:00.000Z',
      rule: ` ${'R'.repeat(150)} `,
      reason: `why\u0001${'z'.repeat(130)}`,
      machine: '\tmachine\u007f',
    })),
  ]);
  return handledForProject(root, { now }).then(r => {
    assert.equal(r.items[0].rule.length, 120);
    assert.equal(r.items[0].reason.length, 120);
    assert.equal(r.items[0].machine, 'machine');
  });
});
