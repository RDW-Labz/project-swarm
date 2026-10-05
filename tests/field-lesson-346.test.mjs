// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runLessonCore } from '../tools/lessons.mjs';

const store = 'coordination/swarm-lessons.jsonl';
const legacyFile = 'coordination/swarm-lessons.md';
const now = () => Date.parse('2000-01-10T23:59:59.999Z');
const add = { command: 'add', area: 'tool', evidence: 'run-0000', rule: 'Validate input.', fix: 'Guard tools/example.mjs.' };
const line = value => JSON.stringify(value) + '\n';

async function put(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lesson-346-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'coordination/private-names.txt', 'FixtureSecret346\n');
  return root;
}

// Builds a legacy table with ids 1..340; optionally makes one row too short to parse.
function legacyTable(malformedId) {
  const lines = [];
  for (let id = 1; id <= 340; id++) {
    if (id === malformedId) { lines.push(`| ${id} |`); continue; }
    lines.push(`| ${id} | 2000-01-02 | Incident ${id}. | Fix ${id}. |`);
  }
  return lines.join('\n') + '\n';
}

describe('field lesson 346: legacy table parse failure never blocks add', () => {
  test('a malformed legacy row falls back to a regex-scanned max id and reports a warning', async t => {
    const root = await fixture(t);
    await put(root, store, line({ id: 300, date: '2000-01-02', area: 'tool', evidence: 'run-0000', rule: 'Validate input.', fix: 'Guard tools/example.mjs.', public: null, status: 'queued', test: null, version: null }));
    await put(root, legacyFile, legacyTable(74));
    const result = JSON.parse((await runLessonCore(root, add, { now })).stdout);
    assert.equal(result.status, 'ok');
    assert.equal(result.lesson.id, 341);
    assert.deepEqual(result.warnings, [{ code: 'legacy-table-unparsed', line: 74 }]);
  });

  test('a well-formed legacy table adds cleanly with no warnings key', async t => {
    const root = await fixture(t);
    await put(root, legacyFile, legacyTable(-1));
    const result = JSON.parse((await runLessonCore(root, add, { now })).stdout);
    assert.equal(result.status, 'ok');
    assert.equal(result.lesson.id, 341);
    assert.equal(Object.hasOwn(result, 'warnings'), false);
  });

  test('no legacy file adds cleanly with no warnings key', async t => {
    const root = await fixture(t);
    const result = JSON.parse((await runLessonCore(root, add, { now })).stdout);
    assert.equal(result.status, 'ok');
    assert.equal(result.lesson.id, 1);
    assert.equal(Object.hasOwn(result, 'warnings'), false);
  });
});
