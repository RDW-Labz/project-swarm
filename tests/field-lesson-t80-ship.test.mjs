// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runLessonShip } from '../tools/lessons-publish.mjs';
import { readLessons, lessonAgeDays } from '../tools/lessons.mjs';
import { validateManifest, validateProject } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const store = 'coordination/swarm-lessons.jsonl';
const archive = 'docs/lessons.md';
const privateTerms9001 = 'FixtureSecret9001';
const now = () => Date.parse('2000-01-10T23:59:59.999Z');
const line = value => JSON.stringify(value) + '\n';
const queued9001 = {
  id: 9001, date: '2000-01-02', area: 'tool', evidence: 'run-0000',
  rule: 'Validate input.', fix: 'Guard tools/example.mjs before writing.',
  public: null, status: 'queued', test: null, version: null,
};
const shipped9002 = {
  ...queued9001, id: 9002, status: 'shipped', version: '1.41.0',
  public: 'Validate input to prevent partial writes.', test: 'tests/field-lesson-9002.test.mjs',
};
const legacy9003 = '| 9003 | 2000-01-02 | Observed failure. Rule: Validate input. | run-0000 | **Swarm fix:** Guard input. Status: queued |\n';
const legacyHeader = '| Id | When | Incident | Proof | Change | State |\n|---|---|---|---|---|---|\n';
const manifest9001 = { command: 'manifest', id: 9001, agent: 'claude', model: 'sonnet' };
const publish9001 = { command: 'publish', version: '1.41.0' };
const initialArchive = '# Field lessons\n\n198. **Keep existing entries.**\n    Enforcement: recorded.\n';

async function lessonFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(
    process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'swarm-lesson-ship-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  const git = (...args) => exec('git', args, { cwd: root, env: { ...process.env } });
  await write('package.json', '{"name":"fixture-9001","version":"0.0.0","type":"module"}\n');
  await write('tools/example.mjs', 'export const value = 9001;\n');
  await write('coordination/private-names.txt', privateTerms9001 + '\n');
  await write('.gitignore', '.swarm/\n');
  await git('init', '-b', 'main');
  await git('add', '--', 'package.json', 'tools/example.mjs', '.gitignore');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const cli = async (...args) => {
    try {
      const result = await exec(process.execPath, [runner, '--root', root, ...args], {
        cwd: os.tmpdir(), env: { ...process.env }, maxBuffer: 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
    }
  };
  return {
    root, write, git, cli,
    read: file => fs.readFile(path.join(root, file), 'utf8'),
    store: (rows, file = store) => write(file, rows.map(line).join('')),
    deps: { now, validateManifest, validateProject, env: { ...process.env }, home: process.env.HOME },
  };
}

function success(result) {
  assert.equal(result.exitCode, 0, result.stderr);
  if ('stderr' in result) assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.stdout, line(parsed));
  return parsed;
}
function failure(result, expected) {
  assert.deepEqual(result, { stdout: '', stderr: line({ status: 'error', ...expected }), exitCode: 1 });
  assert.ok(!result.stdout.includes(privateTerms9001));
  assert.ok(!result.stderr.includes(privateTerms9001));
}
async function refuses(action, expected) {
  await assert.rejects(action, error => {
    assert.deepEqual(error.lessonError, { status: 'error', ...expected });
    assert.equal(error.message, expected.code);
    return true;
  });
}

describe('T80 ship commands', () => {
  test('T80 manifest validates and always declares its regression test', async t => {
    const f = await lessonFixture(t);
    await f.store([queued9001]);
    const before = await f.read(store);
    for (const tier of [undefined, 'cheap', 'mid', 'expensive']) {
      const emitted = success(await runLessonShip(f.root, { ...manifest9001, tier }, f.deps));
      validateManifest(structuredClone(emitted));
      await validateProject(f.root, structuredClone(emitted), f.deps);
      // Mutant (d): deleting the generated regression output must fail this assertion,
      // even though validateManifest itself currently permits test-free outputs.
      assert.deepEqual(emitted.jobs[0].outputs, ['tools/example.mjs', 'tests/field-lesson-9001.test.mjs']);
      assert.deepEqual(emitted.jobs[0].context, ['tools/example.mjs', 'package.json']);
      assert.equal(emitted.jobs[0].model, 'sonnet');
      assert.equal(emitted.jobs[0].tier, tier);
      assert.equal(emitted.jobs[0].tierReason, tier === 'expensive' ? 'Explicit lesson manifest --tier expensive selection.' : undefined);
      assert.equal(emitted.jobs[0].prompt, `${queued9001.fix}\nEvidence: run-0000\nAdd a node:test case in tests/field-lesson-9001.test.mjs that fails without the fix; fixtures use fake ids, no names, repos, URLs or prompt text.`);
    }
    const result = await f.cli('lesson', 'manifest', '9001', '--agent', 'claude', '--model', 'sonnet');
    const emitted = success(result);
    assert.ok(emitted.jobs[0].outputs.includes('tests/field-lesson-9001.test.mjs'));
    await f.write('manifest.json', result.stdout);
    assert.equal(success(await f.cli('validate', 'manifest.json')).status, 'valid');
    assert.equal(await f.read(store), before);

    await f.write('tests/field-lesson-9001.test.mjs', '// Existing regression.\n');
    await f.write('tools/nested/example.mjs', 'export const value = 9002;\n');
    await f.write('tests/field-lesson-9002.test.mjs', '// Supporting regression.\n');
    await f.store([{ ...queued9001, fix: 'Guard `tools/nested/example.mjs`, (tools/example.mjs). Read [test](tests/field-lesson-9002.test.mjs) and tools/example.mjs; ignore tools/missing.mjs.' }]);
    const nested = success(await runLessonShip(f.root, manifest9001, f.deps)).jobs[0];
    assert.deepEqual(nested.context, ['tests/field-lesson-9001.test.mjs', 'tests/field-lesson-9002.test.mjs', 'tools/example.mjs', 'tools/nested/example.mjs', 'package.json']);
    assert.deepEqual(nested.outputs, ['tools/example.mjs', 'tools/nested/example.mjs', 'tests/field-lesson-9001.test.mjs']);
    await f.store([{ ...queued9001, fix: 'Validate input before writing.' }]);
    const noTool = success(await runLessonShip(f.root, manifest9001, f.deps)).jobs[0];
    assert.deepEqual(noTool.outputs, ['tests/field-lesson-9001.test.mjs']);
  });

  test('manifest refuses unusable paths, private output, and real project policy failures', async t => {
    const f = await lessonFixture(t), outside = await lessonFixture(t);
    const invalid = { code: 'lesson-manifest-invalid', field: 'manifest' };
    await f.store([queued9001]);
    await refuses(() => runLessonShip(f.root, { ...manifest9001, id: 9009 }, f.deps), { code: 'lesson-not-found', id: 9009 });
    for (const fix of ['Guard tools/../example.mjs.', 'Guard /tools/example.mjs.', 'Guard ../tools/example.mjs.', 'Guard C:\\tools\\example.mjs.']) {
      await f.store([{ ...queued9001, fix }]);
      await refuses(() => runLessonShip(f.root, manifest9001, f.deps), invalid);
    }
    await fs.mkdir(path.join(f.root, 'tools/directory.mjs'));
    await fs.symlink(path.join(outside.root, 'tools/example.mjs'), path.join(f.root, 'tools/escaped.mjs'));
    await fs.symlink(path.join(outside.root, 'tools'), path.join(f.root, 'tools/linked'), 'junction');
    for (const file of ['tools/directory.mjs', 'tools/escaped.mjs', 'tools/linked/missing.mjs']) {
      await f.store([{ ...queued9001, fix: `Guard ${file}.` }]);
      await refuses(() => runLessonShip(f.root, manifest9001, f.deps), invalid);
    }
    for (const field of ['fix', 'evidence']) {
      await f.store([{ ...queued9001, [field]: privateTerms9001 }]);
      failure(await f.cli('lesson', 'manifest', '9001', '--agent', 'claude', '--model', 'sonnet'), { code: 'private-name', field });
    }
    await f.store([queued9001]);
    await f.write('package.json', ' \n');
    await refuses(() => runLessonShip(f.root, manifest9001, f.deps), invalid);
    await f.write('package.json', '{"name":"fixture-9001","version":"0.0.0"}\n');
    await refuses(() => runLessonShip(f.root, { ...manifest9001, agent: 'invalid' }, f.deps), invalid);
    await refuses(() => runLessonShip(f.root, manifest9001, { ...f.deps, validateProject: async () => { throw new Error(privateTerms9001); } }), invalid);
    await f.write('tests/field-lesson-9002.test.mjs', "import { value } from '../tools/example.mjs';\n");
    await f.git('add', '--', 'tests/field-lesson-9002.test.mjs');
    failure(await f.cli('lesson', 'manifest', '9001', '--agent', 'claude', '--model', 'sonnet'), invalid);
  });

  test('T80 check findings exit zero and respect installed tree', async t => {
    const f = await lessonFixture(t);
    const rows = [shipped9002, { ...queued9001, id: 9003, date: '2000-01-03' }, queued9001,
      { ...queued9001, id: 9004, status: 'built' }, { ...queued9001, id: 9005, status: 'dropped' },
      { ...queued9001, id: 9006, date: '2000-01-11' }, { ...shipped9002, id: 9007, test: null }];
    await f.store(rows);
    await f.write(shipped9002.test, '// A project copy is not installed evidence.\n');
    const options = { command: 'check', installed: 'installed9001' };
    assert.deepEqual(success(await runLessonShip(f.root, options, f.deps)), {
      status: 'ok', checked: 7, findings: [
        { code: 'lesson-stale', id: 9001, days: 8, limit: 7 },
        { code: 'lesson-test-missing', id: 9002, test: shipped9002.test },
        { code: 'lesson-test-missing', id: 9007, test: null },
      ],
    });
    await f.write(`installed9001/${shipped9002.test}`, '// Installed regression.\n');
    assert.deepEqual(success(await runLessonShip(f.root, { ...options, staleDays: 8 }, f.deps)).findings, [{ code: 'lesson-test-missing', id: 9007, test: null }]);
    await f.store([shipped9002], 'coordination/selected.jsonl');
    assert.deepEqual(success(await f.cli('lesson', 'check', '--file', 'coordination/selected.jsonl', '--installed', 'installed9001')), { status: 'ok', checked: 1, findings: [] });
    const before = await f.read(store);
    assert.deepEqual(success(await runLessonShip(f.root, { ...options, storeFile: 'missing/rows.jsonl' }, f.deps)), { status: 'ok', checked: 0, findings: [] });
    await assert.rejects(f.read('missing/rows.jsonl'), { code: 'ENOENT' });
    assert.equal(await f.read(store), before);
    await f.store([shipped9002]);
    await f.write(`home9001/.project-swarm/current/${shipped9002.test}`, '// Default selected tree.\n');
    assert.deepEqual(success(await runLessonShip(f.root, { command: 'check' }, { ...f.deps, home: path.join(f.root, 'home9001') })).findings, []);
    await f.store([queued9001]);
    const low = Date.now(), actual = success(await f.cli('lesson', 'check', '--stale-days', '0')), high = Date.now();
    assert.ok([low, high].some(value => JSON.stringify(actual.findings) === JSON.stringify([{ code: 'lesson-stale', id: 9001, days: lessonAgeDays(queued9001.date, () => value), limit: 0 }])));
  });

  test('check treats malformed stores, unsafe traversal, and unreadable installed inputs as errors', async t => {
    const f = await lessonFixture(t), outside = await lessonFixture(t);
    for (const testPath of ['tests/../outside.mjs', '/tests/field-lesson-9002.test.mjs']) {
      await f.store([{ ...shipped9002, test: testPath }]);
      failure(await f.cli('lesson', 'check'), { code: 'lesson-store-invalid', line: 1 });
    }
    await f.store([shipped9002]);
    await fs.mkdir(path.join(f.root, 'installed9001'));
    await fs.symlink(outside.root, path.join(f.root, 'installed9001/tests'), 'junction');
    failure(await f.cli('lesson', 'check', '--installed', 'installed9001'), { code: 'lesson-io', field: 'installed' });
    const originalStat = fs.stat;
    t.mock.method(fs, 'stat', async file => {
      if (String(file).includes('unreadable9001')) throw Object.assign(new Error(privateTerms9001), { code: 'EACCES' });
      return originalStat(file);
    });
    await refuses(() => runLessonShip(f.root, { command: 'check', installed: 'unreadable9001' }, f.deps), { code: 'lesson-io', field: 'installed' });
  });

  test('T80 publish never emits run ids or URLs', async t => {
    const f = await lessonFixture(t);
    await f.write(archive, initialArchive);
    const unsafePublic9001 = [
      ['run-' + '0000', 'run-id'], ['9001000000000-' + 'deadbeef', 'run-id'],
      ['ask-' + '9001000000000-' + 'deadbeef', 'run-id'],
      ['https:' + '//fixture9001.invalid', 'url'], ['www.' + 'fixture9001.invalid', 'url'],
      ['[reference]' + '(destination)', 'url'], ['<mailto:' + 'fixture9001.invalid>', 'url'],
    ];
    // Mutant (c): bypassing both publicSafe run-id/URL gates must fail every
    // corresponding refusal assertion; a successful clean control prevents blanket refusal.
    for (const [unsafe, pattern] of unsafePublic9001) {
      for (const field of ['public', 'rule', 'fix']) {
        const row = { ...shipped9002, id: 9003, public: null, rule: 'Validate input.', fix: 'Prevent partial writes.', [field]: `Keep ${unsafe} private.` };
        await f.store([shipped9002, row]);
        const storeBefore = await f.read(store);
        const result = await f.cli('lesson', 'publish', '--version', '1.41.0');
        failure(result, { code: 'public-line-unsafe', field, pattern });
        assert.ok(!result.stdout.includes(unsafe));
        assert.ok(!result.stderr.includes(unsafe));
        assert.equal(await f.read(archive), initialArchive);
        assert.equal(await f.read(store), storeBefore);
      }
    }
    await f.store([{ ...shipped9002, rule: 'run-0000', fix: 'https:' + '//fixture9001.invalid', evidence: privateTerms9001 }]);
    assert.deepEqual(success(await f.cli('lesson', 'publish', '--version', '1.41.0')), { status: 'ok', version: '1.41.0', file: archive, published: [9002], skipped: [] });
    const published = await f.read(archive);
    assert.ok(published.startsWith(initialArchive));
    assert.ok(published.includes('199. **Validate input to prevent partial writes.**'));
    assert.ok(!published.includes('run-0000'));
    assert.ok(!published.includes('fixture9001.invalid'));
    assert.ok(!published.includes(privateTerms9001));
  });

  test('publish refuses every unsafe class with deterministic precedence and no partial writes', async t => {
    const f = await lessonFixture(t);
    await f.write(archive, initialArchive);
    const owner = 'fixtureowner9001', repo = 'fixturerepo9001';
    const cases = [
      [privateTerms9001 + ' run-0000', 'private-name'],
      [owner + '/' + repo, 'repo'], ['@' + 'fixture9001', 'handle'],
      ['/' + 'Users/fixture9001/work', 'home-path'], ['/' + 'home/fixture9001/work', 'home-path'],
      ['/' + 'root/work', 'home-path'], ['C:' + '\\Users\\fixture9001\\work', 'home-path'],
      ['\\\\' + 'fixture9001\\home\\work', 'home-path'], ['~' + '/work', 'home-path'],
      ['T' + '9001', 'ticket-id'],
    ];
    for (const [text, pattern] of cases) {
      await f.store([shipped9002, { ...shipped9002, id: 9003, public: `Keep ${text} private.` }]);
      failure(await f.cli('lesson', 'publish', '--version', '1.41.0'), { code: 'public-line-unsafe', field: 'public', pattern });
      assert.equal(await f.read(archive), initialArchive);
    }
    await f.write('.swarm-projects.json', JSON.stringify({ nested: [
      { remote: 'https:' + '//fixture9001.invalid/' + owner + '/' + repo + '.git' },
      { owner: 'fixtureowner9002', repo: 'fixturerepo9002', name: 'fixturelabel9001' },
    ] }));
    for (const text of [owner, repo, 'fixtureowner9002', 'fixturerepo9002', 'fixturelabel9001']) {
      await f.store([{ ...shipped9002, public: `Keep ${text} private.` }]);
      failure(await f.cli('lesson', 'publish', '--version', '1.41.0'), { code: 'public-line-unsafe', field: 'public', pattern: 'repo' });
      assert.equal(await f.read(archive), initialArchive);
    }
    await f.store([shipped9002]);
    await f.write('.swarm-projects.json', '{invalid');
    failure(await f.cli('lesson', 'publish', '--version', '1.41.0'), { code: 'lesson-io', field: 'registry' });
    assert.equal(await f.read(archive), initialArchive);
    await f.write('.swarm-projects.json', '{}');
    failure(await f.cli('lesson', 'publish', '--version', '1.41.0', '--file', `new/${privateTerms9001}.md`), { code: 'private-name', field: 'file' });
    await assert.rejects(fs.stat(path.join(f.root, 'new')), { code: 'ENOENT' });
    for (const [field, value] of [['test', `tests/${privateTerms9001}.mjs`], ['version', `1.41.0-${privateTerms9001}`]]) {
      await f.store([{ ...shipped9002, [field]: value }]);
      failure(await f.cli('lesson', 'publish', '--version', field === 'version' ? value : '1.41.0'), { code: 'private-name', field });
      assert.equal(await f.read(archive), initialArchive);
    }
  });

  test('publish sequences, escapes prose, filters versions, and skips stable markers', async t => {
    const f = await lessonFixture(t);
    await f.write(archive, initialArchive + '7. **Older sequence appears later.**\n');
    await f.store([
      { ...shipped9002, id: 9004, version: '1.40.0' },
      { ...shipped9002, id: 9003, test: null, public: null, rule: 'Validate *input*.', fix: 'Prevent\n partial\t writes.' },
      queued9001, shipped9002, { ...shipped9002, id: 9005, status: 'built' },
    ]);
    const stored = await f.read(store);
    assert.deepEqual(success(await runLessonShip(f.root, publish9001, f.deps)), { status: 'ok', version: '1.41.0', file: archive, published: [9002, 9003], skipped: [] });
    const before = await f.read(archive);
    assert.ok(before.includes('199. **Validate input to prevent partial writes.**'));
    assert.ok(before.includes('200. **Validate \\*input\\*. — Prevent partial writes.**'));
    assert.ok(before.includes('    Enforcement: lesson 9002, shipped in 1.41.0.\n    Regression coverage: `tests/field-lesson-9002.test.mjs`.\n    <!-- swarm-lesson:9002:1.41.0 -->'));
    assert.ok(before.includes('Regression coverage: not recorded.'));
    assert.deepEqual(success(await f.cli('lesson', 'publish', '--version', '1.41.0')).skipped, [9002, 9003]);
    assert.equal(await f.read(archive), before);
    assert.equal(await f.read(store), stored);
    assert.deepEqual(success(await f.cli('lesson', 'publish', '--version', '9.0.0', '--file', 'absent/public.md')), { status: 'ok', version: '9.0.0', file: 'absent/public.md', published: [], skipped: [] });
    await assert.rejects(fs.stat(path.join(f.root, 'absent')), { code: 'ENOENT' });
    assert.deepEqual(success(await f.cli('lesson', 'publish', '--version', '1.41.0', '--file', 'new/public.md')).published, [9002, 9003]);
    assert.match(await f.read('new/public.md'), /^# Field lessons\n\n1\. /);
    assert.equal(await f.read(archive), before);
  });

  test('publish validates destinations, preserves aliases, and rolls back partial writes', async t => {
    const f = await lessonFixture(t);
    await f.store([shipped9002]);
    for (const bytes of ['# Other heading\n1. **Entry.**\n', '# Field lessons\n', '# Field lessons\n9007199254740992. **Entry.**\n']) {
      await f.write(archive, bytes);
      failure(await f.cli('lesson', 'publish', '--version', '1.41.0'), { code: 'lesson-public-file-invalid', field: 'file' });
      assert.equal(await f.read(archive), bytes);
    }
    await f.write(archive, initialArchive);
    await fs.symlink(path.join(f.root, archive), path.join(f.root, 'alias.md'));
    await fs.link(path.join(f.root, archive), path.join(f.root, 'hard-alias.md'));
    assert.deepEqual(success(await f.cli('lesson', 'publish', '--version', '1.41.0', '--file', 'alias.md')).published, [9002]);
    assert.equal(await f.read('alias.md'), await f.read(archive));
    assert.equal(await f.read('hard-alias.md'), await f.read(archive));
    const before = await f.read(archive);
    assert.deepEqual(success(await f.cli('lesson', 'publish', '--version', '1.41.0', '--file', 'hard-alias.md')).skipped, [9002]);
    assert.equal(await f.read(archive), before);
    await f.store([shipped9002, { ...shipped9002, id: 9003 }]);
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args);
      if (args[0] === path.join(f.root, archive)) {
        const write = handle.write.bind(handle);
        handle.write = async (buffer, offset, length, position) => {
          await write(buffer, offset, Math.min(5, length), position);
          throw new Error(privateTerms9001);
        };
      }
      return handle;
    });
    await refuses(() => runLessonShip(f.root, publish9001, f.deps), { code: 'lesson-io', field: 'file' });
    assert.equal(await f.read(archive), before);
    assert.equal(await f.read('hard-alias.md'), before);
  });

  test('T80 import handles legacy shapes and is idempotent', async t => {
    const f = await lessonFixture(t);
    const source = '# Narrative 999999\n| # | Date | What happened | Evidence | Proposed swarm fix | Status |\n'
      + legacy9003
      + '| 9004 | 2000-02-29 | Incident. | Rule: Keep input. | **Swarm fix:** Preserve **formatting**. Status: shipped 1.41.0 (release) |\n'
      + '| 9005 | 2000-01-02 | Incident. Fix: First fix. Rule: First rule. | `run-0000|sample` | Rule: Later rule. | Fix: Last fix. Status: built 1.41.0-rc.1 |\n'
      + '| 9006 | 2000-01-02 | Incident. | run-0000\\|sample | Final fix. | Status: dropped |\n'
      + '| 9007 | 2000-01-02 | Incident. | Only fix. |\n'
      + '| 9008 | 2000-01-02 | | Rule: Keep input. | Status: queued |\n';
    await f.write('coordination/swarm-lessons.md', source);
    await f.store([queued9001]);
    const result = success(await f.cli('lesson', 'import'));
    assert.deepEqual(result, { status: 'ok', imported: [9003, 9004, 9005, 9006, 9007, 9008], skipped: [], padded: [9003, 9004, 9007, 9008], overflow: [] });
    const rows = await readLessons(f.root);
    assert.deepEqual(rows[0], queued9001);
    assert.deepEqual(rows[1], { ...queued9001, id: 9003, evidence: 'Observed failure.\nrun-0000', fix: 'Guard input.' });
    assert.equal(rows[2].date, '2000-02-29');
    assert.equal(rows[2].status, 'shipped');
    assert.equal(rows[2].version, '1.41.0');
    assert.equal(rows[2].fix, 'Preserve **formatting**.');
    assert.equal(rows[3].evidence, 'Incident.\n`run-0000|sample`');
    assert.equal(rows[3].rule, 'Later rule.');
    assert.equal(rows[3].fix, 'Last fix.');
    assert.equal(rows[3].status, 'built');
    assert.equal(rows[4].evidence, 'Incident.\nrun-0000|sample');
    assert.equal(rows[4].status, 'dropped');
    assert.equal(rows[5].rule, 'Incident.');
    assert.equal(rows[5].fix, 'Only fix.');
    assert.equal(rows[6].evidence, 'legacy lesson 9008');
    const before = await f.read(store);
    assert.deepEqual(success(await f.cli('lesson', 'import')), { status: 'ok', imported: [], skipped: [9003, 9004, 9005, 9006, 9007, 9008], padded: [9003, 9004, 9007, 9008], overflow: [] });
    assert.equal(await f.read(store), before);
    assert.equal(await f.read('coordination/swarm-lessons.md'), source);
    await assert.rejects(fs.stat(path.join(f.root, '.swarm/gotchas.md')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(f.root, 'coordination/skills')), { code: 'ENOENT' });
    await f.write('coordination/legacy.md', legacyHeader + legacy9003);
    assert.deepEqual(success(await f.cli('lesson', 'import', '--from', 'coordination/legacy.md', '--file', 'coordination/selected.jsonl')), { status: 'ok', imported: [9003], skipped: [], padded: [9003], overflow: [] });
    assert.equal(await f.read(store), before);
  });

  test('import preflights every new row, preserves existing ids, and refuses malformed input without writes', async t => {
    const f = await lessonFixture(t);
    await f.store([queued9001]);
    const before = await f.read(store);
    for (const source of [
      legacyHeader + legacy9003 + legacy9003.replace('9003', '9004').replace('Guard input.', privateTerms9001),
      legacy9003.replace('Status: queued', 'Status: unknown'),
      legacy9003.replace('2000-01-02', '2000-02-30'),
      legacy9003 + legacy9003.replace('Guard input.', 'Different fix.'),
    ]) {
      await f.write('coordination/swarm-lessons.md', source);
      const result = await f.cli('lesson', 'import');
      if (source.includes(privateTerms9001)) {
        assert.deepEqual(result, { stdout: line({ status: 'ok', imported: [9003], skipped: [{ id: 9004, line: 4, reason: 'private-name', field: 'fix' }], padded: [9003, 9004], overflow: [] }), stderr: '', exitCode: 0 });
        const rows = await readLessons(f.root);
        assert.ok(rows.some(row => row.id === 9003));
        assert.ok(!rows.some(row => row.id === 9004));
        assert.ok(!result.stdout.includes(privateTerms9001));
        assert.ok(!(await f.read(store)).includes(privateTerms9001));
        await f.store([queued9001]);
      } else {
        failure(result, { code: 'lesson-import-invalid', line: 1 });
      }
      assert.equal(await f.read(store), before);
    }
    await f.write('coordination/swarm-lessons.md', legacyHeader + legacy9003.replace('9003', '9001').replace('Guard input.', privateTerms9001));
    assert.deepEqual(success(await f.cli('lesson', 'import')), { status: 'ok', imported: [], skipped: [9001], padded: [9001], overflow: [] });
    assert.equal(await f.read(store), before);
    failure(await f.cli('lesson', 'import', '--from', 'missing.md'), { code: 'lesson-io', field: 'from' });
    await f.write('coordination/swarm-lessons.md', '# No rows.\n');
    failure(await f.cli('lesson', 'import', '--file', 'absent/rows.jsonl'), { code: 'lesson-import-invalid', line: 1 });
    await assert.rejects(fs.stat(path.join(f.root, 'absent')), { code: 'ENOENT' });
  });
});
