// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseLessonArgs } from '../tools/lessons.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const store = 'coordination/swarm-lessons.jsonl';
const legacy = 'coordination/swarm-lessons.md';
const privateTerm = 'private9001';
const header = '| # | Date | What happened | Evidence | Proposed swarm fix | Status |\n|---|---|---|---|---|---|\n';
const row = (id, status = 'queued') => '| ' + id + ' | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input. | ' + status + ' |\n';
// The twelve mixed real-table shapes from the T80 import regression, plus
// private short/overflow rows to exercise privacy precedence over shape.
const realShapes = header
  + row(9012)
  + '| 9001 | 2000-01-02 | Incident. | Only fix. |\n'
  + '| 9002 | 2000-01-02 | Observed.\nAgain. Rule: Validate input. | Evidence. | Fix: Guard input. | queued |\n'
  + '| 9003 | 2000-01-02 | Observed. Rule: Validate input. | \`a|b\` | Fix: Guard input. | queued |\n'
  + '| 9004 | 2000-01-02 | Observed. Rule: Validate input. | a\\|b | Fix: Guard input. | queued |\n'
  + '| 9005 | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input. | Fix: Keep input. | Keep output. |\n'
  + row('9006r')
  + row(9007, 'Status: unknown')
  + row(9008, 'shipped 1.0.0')
  + row(9009, 'built 1.0.0')
  + row(9010, 'dropped')
  + '| 9011 | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: Guard input.\nKeep input. | queued |\n'
  + '| 9013 | 2000-01-02 | ' + privateTerm + ' | Only fix. |\n'
  + '| 9014 | 2000-01-02 | Observed. Rule: Validate input. | Evidence. | Fix: ' + privateTerm + ' | queued | Extra. |\n';
const storedRow = id => ({
  id, date: '2000-01-02', area: 'tool', evidence: 'Evidence.',
  rule: 'Validate input.', fix: 'Guard input.', public: null,
  status: 'queued', test: null, version: null,
});

async function snapshot(root) {
  const entries = [];
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = path.relative(root, file);
      if (entry.isDirectory()) { entries.push([relative, null]); await walk(file); }
      else entries.push([relative, await fs.readFile(file)]);
    }
  }
  await walk(root);
  return entries;
}

async function fixture(t, source = realShapes) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'aa-lessons9001-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, bytes) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), bytes);
  };
  await write(legacy, source);
  await write('coordination/private-names.txt', privateTerm + '\n');
  // Import must never invoke a provider or repository mutation.
  for (const command of ['git', 'gh', 'codex']) {
    await write('bin/' + command, '#!' + process.execPath + '\nprocess.stderr.write("unexpected command9001"); process.exitCode = 1;\n');
    await fs.chmod(path.join(root, 'bin', command), 0o755);
  }
  await write('preload9001.mjs', [
    'const RealDate = Date;',
    'globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["2000-01-02T00:00:00.000Z"])); } static now() { return 946771200000; } };',
    'globalThis.fetch = async () => { throw Error("unexpected network9001"); };',
  ].join('\n'));
  const cli = async (...args) => {
    try {
      return { code: 0, ...await exec(process.execPath, ['--import', path.join(root, 'preload9001.mjs'), runner, '--root', root, ...args], {
        cwd: root, env: { ...process.env, PATH: path.join(root, 'bin') + path.delimiter + path.dirname(process.execPath) },
      }) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { root, write, cli };
}
function parsed(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(value) + '\n');
  return value;
}
const counts = result => ({
  imported: result.imported.length, padded: result.padded.length,
  overflow: result.overflow.length,
  skippedPrivate: result.skipped.filter(item => item?.reason === 'private-name').length,
});
const expectedCounts = { imported: 12, padded: 2, overflow: 2, skippedPrivate: 2 };

describe('L326 lesson import dry run', () => {
  test('L326 dry run leaves the store and every fixture file byte-identical', async t => {
    const f = await fixture(t);
    // Noncanonical spacing also detects an unnecessary rewrite with no new rows.
    await f.write(store, JSON.stringify(storedRow(9099)).replace(/:/g, ': ') + '\n\n');
    const before = await snapshot(f.root);
    const summary = parsed(await f.cli('lesson', 'import', '--dry-run'));
    // Mutant e: writeLessons before the dry-run return changes these bytes.
    assert.deepEqual(await snapshot(f.root), before);
    assert.deepEqual(summary, { status: 'ok', dryRun: true, ...expectedCounts });
    assert.equal(Object.hasOwn(summary, 'rows'), false);
    const actual = parsed(await f.cli('lesson', 'import'));
    assert.deepEqual(counts(actual), expectedCounts);
    assert.deepEqual(counts(actual), Object.fromEntries(Object.keys(expectedCounts).map(key => [key, summary[key]])));
  });

  test('L326 dry run on a missing store creates no file or directory', async t => {
    const f = await fixture(t);
    await f.write('9001.md', realShapes);
    for (const flags of [[], ['--from', '9001.md', '--file', 'missing9001/rows.jsonl']]) {
      const before = await snapshot(f.root);
      const summary = parsed(await f.cli('lesson', 'import', '--dry-run', ...flags));
      assert.deepEqual(summary, { status: 'ok', dryRun: true, ...expectedCounts });
      assert.deepEqual(await snapshot(f.root), before);
      await assert.rejects(fs.stat(path.join(f.root, store)), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(f.root, 'missing9001')), { code: 'ENOENT' });
    }
  });

  test('L326 verbose reports all four verdicts without private content', async t => {
    const f = await fixture(t);
    const before = await snapshot(f.root);
    const result = await f.cli('lesson', 'import', '--verbose', '--from', legacy, '--dry-run');
    const summary = parsed(result);
    assert.deepEqual(summary, {
      status: 'ok', dryRun: true, ...expectedCounts,
      rows: Array.from({ length: 14 }, (_, index) => {
        const id = 9001 + index;
        return { id, verdict: id >= 9013 ? 'skipped-private' : id === 9001 ? 'padded' : id === 9005 ? 'overflow' : 'import' };
      }),
    });
    assert.ok(!JSON.stringify(result).includes(privateTerm));
    assert.deepEqual(await snapshot(f.root), before);
    const actual = parsed(await f.cli('lesson', 'import', '--verbose'));
    assert.deepEqual(counts(actual), expectedCounts);
    assert.deepEqual(Object.keys(actual), ['status', 'imported', 'skipped', 'padded', 'overflow']);
  });

  test('L326 preview preserves existing ids and lenient invalid-row skips', async t => {
    const source = header + row(9001) + row('9001r')
      + row(9002).replace('2000-01-02', '2000-02-30')
      + row(9003).replace('Evidence.', privateTerm) + row(9004);
    const f = await fixture(t, source);
    await f.write(store, JSON.stringify(storedRow(9001)) + '\n');
    const before = await snapshot(f.root);
    const summary = parsed(await f.cli('lesson', 'import', '--dry-run', '--verbose'));
    assert.deepEqual(summary, {
      status: 'ok', dryRun: true, imported: 1, padded: 0, overflow: 0, skippedPrivate: 1,
      rows: [{ id: 9003, verdict: 'skipped-private' }, { id: 9004, verdict: 'import' }],
    });
    assert.deepEqual(await snapshot(f.root), before);
    assert.deepEqual(counts(parsed(await f.cli('lesson', 'import'))), { imported: 1, padded: 0, overflow: 0, skippedPrivate: 1 });
  });

  test('L326 import help and parser accept preview flags only for import', async t => {
    const f = await fixture(t);
    for (const args of [['--help'], ['lesson', '--help'], ['lesson', 'import', '--help']]) {
      const result = await f.cli(...args);
      assert.equal(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('import [--from FILE] [--dry-run] [--verbose]'));
    }
    assert.deepEqual(parseLessonArgs(['import', '--dry-run', '--from', '9001.md', '--verbose']), { command: 'import', dryRun: true, from: '9001.md', verbose: true });
    for (const args of [['list', '--dry-run'], ['publish', '--verbose'], ['import', '--dry-run', '--dry-run'], ['import', '--verbose', '--verbose'], ['import', '--dry-run', '9001']]) {
      assert.throws(() => parseLessonArgs(args), error => error.lessonError?.code === 'lesson-args');
    }
  });
});
