// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLegacyLessons, readLessons } from '../tools/lessons.mjs';

// Run with the suite's --import ./tests/_isolate-config.mjs setup.
const store = 'coordination/swarm-lessons.jsonl';
const legacyFile = 'coordination/swarm-lessons.md';
const header = '| # | Date | What happened | Evidence | Proposed swarm fix | Status |\n|---|---|---|---|---|---|\n';
const line = value => JSON.stringify(value) + '\n';
const lesson = (id, fields = {}) => ({
  id, date: '2000-01-02', area: 'tool', evidence: 'Observed.\nEvidence.',
  rule: 'Validate input.', fix: 'Guard input.', public: null,
  status: 'queued', test: null, version: null, ...fields,
});
const row = (id, status = 'queued') => '| ' + id + ' | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input. | ' + status + ' |\n';

async function put(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function lessonFixture(t, source) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'swarm-lesson-import-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'coordination/private-names.txt', '');
  await put(root, legacyFile, source);
  return root;
}
async function cli(root, args) {
  const entry = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--root', root, 'lesson', ...args], { cwd: os.tmpdir(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ stdout, stderr, exitCode }));
  });
}
async function imports(t, source, expected, { padded = [], overflow = [], skipped = [] } = {}) {
  const diagnostics = {};
  assert.deepEqual(parseLegacyLessons(source, diagnostics), expected);
  assert.deepEqual(diagnostics, { padded, overflow, skipped });
  const root = await lessonFixture(t, source);
  const sorted = [...expected].sort((a, b) => a.id - b.id);
  const ids = sorted.map(value => value.id);
  assert.deepEqual(await cli(root, ['import']), {
    stdout: line({ status: 'ok', imported: ids, skipped, padded, overflow }), stderr: '', exitCode: 0,
  });
  assert.deepEqual(await readLessons(root), sorted);
  if (expected.length) assert.equal(await fs.readFile(path.join(root, store), 'utf8'), sorted.map(line).join(''));
  else await assert.rejects(fs.stat(path.join(root, store)), { code: 'ENOENT' });
  assert.deepEqual(await cli(root, ['import']), {
    stdout: line({ status: 'ok', imported: [], skipped: [...skipped, ...ids], padded, overflow }), stderr: '', exitCode: 0,
  });
  assert.equal(await fs.readFile(path.join(root, legacyFile), 'utf8'), source);
}

describe('T80 lenient lesson import', () => {
  test('short rows are padded, including rows with only an id and date', async t => {
    await imports(t, header
      + '| 9001 | 2000-01-02 | Incident. | Only fix. |\n'
      + '| 9002 | 2000-01-02 |\n', [
      lesson(9001, { evidence: 'Incident.', rule: 'Incident.', fix: 'Only fix.' }),
      lesson(9002, { evidence: 'legacy lesson 9002', rule: 'legacy lesson 9002', fix: 'legacy lesson 9002' }),
    ], { padded: [9001, 9002] });
  });

  test('continuation lines join the open cell with literal newlines', async t => {
    await imports(t, header
      + '| 9001 | 2000-01-02 | Observed.\nAgain. Rule: Validate input. | Evidence.\nMore evidence. | Fix: Guard input.\nKeep input. | queued |\n'
      + row(9002), [
      lesson(9001, { evidence: 'Observed.\nAgain.\nEvidence.\nMore evidence.', fix: 'Guard input.\nKeep input.' }),
      lesson(9002),
    ]);
  });

  test('backtick pipes and escaped pipes remain inside their cells', async t => {
    await imports(t, header
      + '| 9001 | 2000-01-02 | Observed. Rule: Validate input. | `left|right` and left\\|right and ``a`|b`` | Fix: Guard input. | queued |\n', [
      lesson(9001, { evidence: 'Observed.\n`left|right` and left|right and ``a`|b``' }),
    ]);
  });

  test('a seventh cell is appended to the sixth with a spaced pipe', async t => {
    await imports(t, header
      + '| 9001 | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input. | Fix: Keep input. | Keep output. |\n', [
      lesson(9001, { fix: 'Keep input. | Keep output.' }),
    ], { overflow: [9001] });
  });

  test('suffixed ids retain their integer id and persist reopen', async t => {
    await imports(t, header + row('9001r') + row('9002AB'), [
      lesson(9001, { reopen: 'r' }), lesson(9002, { reopen: 'AB' }),
    ]);
  });

  test('plain ids win over suffixed duplicates in either source order', async t => {
    await imports(t, header + row('9001r') + row(9001) + row(9002) + row('9002r'), [
      lesson(9001), lesson(9002),
    ], { skipped: [{ line: 3, reason: 'duplicate-id' }, { line: 6, reason: 'duplicate-id' }] });
  });

  test('unreadable labeled and bare status cells fall back to queued', async t => {
    for (const status of ['Status: unknown', 'Status: ???', 'unknown']) {
      await imports(t, header + row(9001, status), [lesson(9001)]);
    }
  });

  test('a headerless file still returns lesson-import-invalid without a store', async t => {
    for (const source of ['# No table.\n', row(9001)]) {
      assert.throws(() => parseLegacyLessons(source), error => {
        assert.deepEqual(error.lessonError, { status: 'error', code: 'lesson-import-invalid', line: 1 });
        return true;
      });
      const root = await lessonFixture(t, source);
      assert.deepEqual(await cli(root, ['import']), {
        stdout: '', stderr: line({ status: 'error', code: 'lesson-import-invalid', line: 1 }), exitCode: 1,
      });
      await assert.rejects(fs.stat(path.join(root, store)), { code: 'ENOENT' });
    }
  });

  test('twelve mixed rows return twelve exact lessons in source order', async t => {
    const source = header
      + row(9012)
      + '| 9001 | 2000-01-02 | Incident. | Only fix. |\n'
      + '| 9002 | 2000-01-02 | Observed.\nAgain. Rule: Validate input. | Evidence. | Fix: Guard input. | queued |\n'
      + '| 9003 | 2000-01-02 | Observed. Rule: Validate input. | `a|b` | Fix: Guard input. | queued |\n'
      + '| 9004 | 2000-01-02 | Observed. Rule: Validate input. | a\\|b | Fix: Guard input. | queued |\n'
      + '| 9005 | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input. | Fix: Keep input. | Keep output. |\n'
      + row('9006r')
      + row(9007, 'Status: unknown')
      + row(9008, 'shipped 1.0.0')
      + row(9009, 'built 1.0.0')
      + row(9010, 'dropped')
      + '| 9011 | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input.\nKeep input. | queued |\n';
    await imports(t, source, [
      lesson(9012),
      lesson(9001, { evidence: 'Incident.', rule: 'Incident.', fix: 'Only fix.' }),
      lesson(9002, { evidence: 'Observed.\nAgain.\nEvidence.' }),
      lesson(9003, { evidence: 'Observed.\n`a|b`' }),
      lesson(9004, { evidence: 'Observed.\na|b' }),
      lesson(9005, { fix: 'Keep input. | Keep output.' }),
      lesson(9006, { reopen: 'r' }), lesson(9007),
      lesson(9008, { status: 'shipped', version: '1.0.0' }),
      lesson(9009, { status: 'built', version: '1.0.0' }),
      lesson(9010, { status: 'dropped' }),
      lesson(9011, { fix: 'Guard input.\nKeep input.' }),
    ], { padded: [9001], overflow: [9005] });
  });

  test('unrepresentable rows are skipped without aborting following lessons', async t => {
    await imports(t, header
      + row(9001).replace('2000-01-02', '2000-02-30')
      + row('9007199254740992')
      + row(9002).replace('Guard input.', 'Guard\0input.')
      + row(9003) + row(9003), [lesson(9003)], {
      skipped: [
        { line: 3, reason: 'invalid-date' }, { line: 4, reason: 'invalid-id' },
        { line: 5, reason: 'invalid-row' }, { line: 7, reason: 'duplicate-id' },
      ],
    });
  });
});
