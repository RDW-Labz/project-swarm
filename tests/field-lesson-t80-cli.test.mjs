// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runManifest } from '../tools/swarm.mjs';
import { lessonAgeDays, lessonQueueWarnings } from '../tools/lessons.mjs';

const exec = promisify(execFile);
const installRoot = fileURLToPath(new URL('../', import.meta.url));
const runner = path.join(installRoot, 'tools/swarm.mjs');
const privateTerms9001 = 'FixtureSecret9001';
const common = ['--private-names', 'coordination/private-names.txt'];
const queued9001 = {
  id: 9001, date: '2000-01-02', area: 'tool', evidence: 'run-0000',
  rule: 'Validate input before writing.', fix: 'Guard tools/example.mjs before writing.',
  public: 'Validate inputs before writing to prevent partial changes.',
  status: 'queued', test: null, version: null,
};
const shipped9002 = {
  ...queued9001, id: 9002, status: 'shipped', version: '1.41.0',
  test: 'tests/field-lesson-9002.test.mjs',
};
const legacy9003 = '| 9003 | 2000-01-03 | Input failed. Rule: Validate before writing. | run-0000 | Fix: Guard input. | Status: queued |\n';

async function lessonFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(
    process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'swarm-t80-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await write('package.json', '{"name":"fixture-9001","version":"0.0.0","type":"module"}\n');
  await write('tools/example.mjs', 'export const value = 9001;\n');
  await write('coordination/private-names.txt', `${privateTerms9001}\n`);
  await write('.gitignore', '.swarm/\n');
  await exec('git', ['init', '-b', 'main'], { cwd: root, env: { ...process.env } });
  await exec('git', ['add', '--', 'package.json', 'tools/example.mjs', '.gitignore'], { cwd: root, env: { ...process.env } });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: root, env: { ...process.env } });
  const store = (rows, file = 'coordination/swarm-lessons.jsonl') => write(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const cli = async (...args) => {
    try {
      const result = await exec(process.execPath, [runner, '--root', root, ...args], {
        cwd: installRoot, env: { ...process.env }, maxBuffer: 1024 * 1024,
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  return { root, write, store, cli, read: file => fs.readFile(path.join(root, file), 'utf8') };
}

function jsonSuccess(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(parsed) + '\n');
  return parsed;
}

function jsonError(result, expected) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, JSON.stringify(expected) + '\n');
}

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: '{"status":"ok"}',
      total_cost_usd: 0,
      permission_denials: [{ tool_name: 'Read', tool_input: { file_path: 'tools/example.mjs' } }],
    }) + '\n');
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
}

const manifest9001 = {
  version: 1,
  jobs: [{ id: 'lesson-9001', agent: 'claude', model: 'sonnet', prompt: 'Inspect input.', context: ['tools/example.mjs'], outputs: [] }],
};

describe('T80 lesson CLI wiring', () => {
  test('T80 CLI exposes every lesson command and preserves old help', async t => {
    const f = await lessonFixture(t);
    const global = await f.cli('--help');
    assert.equal(global.code, 0);
    assert.equal(global.stderr, '');
    for (const old of ['doctor', 'validate MANIFEST', 'preflight MANIFEST', 'run MANIFEST', 'redcheck RUN', 'ship RUN', 'go MANIFEST|RUN', 'ask --model', 'scout --model', 'sweep --model', 'mutants --mutants-file', 'version [--check]', 'update [--projects', 'squash --branch', 'onboard']) assert.ok(global.stdout.includes(old), old);
    const help = await f.cli('lesson', '--help');
    assert.equal(help.code, 0);
    assert.equal(help.stderr, '');
    assert.ok(help.stdout.endsWith('\n'));
    for (const verb of ['add', 'list', 'set', 'manifest', 'check', 'publish', 'import']) {
      assert.ok(global.stdout.includes(`lesson ${verb}`), verb);
      assert.match(help.stdout, new RegExp(`\\b${verb}\\b`));
      assert.deepEqual(await f.cli('lesson', verb, '--help'), help);
    }
    assert.deepEqual(await f.cli('lesson', '-h'), help);
    for (const flag of ['--root', '--file', '--private-names', '--area', '--evidence', '--rule', '--fix', '--public', '--queued', '--shipped', '--older-than', '--status', '--version', '--test', '--agent', '--model', '--tier', '--stale-days', '--installed', '--from', '--help', '-h']) {
      assert.ok(help.stdout.includes(flag), flag);
      assert.ok(global.stdout.includes(flag), flag);
    }
  });

  test('add and set use the selected root, preserve fields, and print one JSON line', async t => {
    const f = await lessonFixture(t);
    const file = 'coordination/selected.jsonl';
    await f.store([{ ...queued9001, status: 'dropped' }], file);
    const before = new Date().toISOString().slice(0, 10);
    const added = jsonSuccess(await f.cli('lesson', 'add', '--area', 'gotchas', '--evidence', 'run-0000', '--rule', queued9001.rule, '--fix', queued9001.fix, '--public', queued9001.public, '--file', file, ...common));
    const after = new Date().toISOString().slice(0, 10);
    assert.equal(added.status, 'ok');
    assert.equal(added.lesson.id, 9002);
    assert.ok(added.lesson.date >= before && added.lesson.date <= after);
    assert.equal(added.routedTo, '.swarm/gotchas.md');
    assert.equal(await f.read('.swarm/gotchas.md'), `- ${queued9001.rule} (lesson 9002)\n`);
    const updated = jsonSuccess(await f.cli('lesson', 'set', '9002', '--status', 'shipped', '--version', '1.41.0', '--test', shipped9002.test, '--file', file, ...common));
    assert.deepEqual(updated.lesson, { ...added.lesson, status: 'shipped', version: '1.41.0', test: shipped9002.test });
    for (const status of ['built', 'dropped', 'queued']) {
      const changed = jsonSuccess(await f.cli('lesson', 'set', '9002', '--status', status, '--file', file, ...common));
      assert.deepEqual(changed.lesson, { ...updated.lesson, status });
    }
    const rows = (await f.read(file)).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows[0], { ...queued9001, status: 'dropped' });
    assert.deepEqual(await f.cli('lesson', 'list', '--queued', '--file', file, ...common), {
      code: 0, stdout: `#9002 ${added.lesson.date} gotchas queued ${queued9001.rule}\n`, stderr: '',
    });
    await assert.rejects(f.read('coordination/swarm-lessons.jsonl'), { code: 'ENOENT' });
  });

  test('lesson failures use the safe envelope and leave store bytes unchanged', async t => {
    const f = await lessonFixture(t);
    await f.store([queued9001]);
    const before = await f.read('coordination/swarm-lessons.jsonl');
    for (const args of [
      ['list', '--unknown', privateTerms9001], ['list', '--date', '2000-01-02'],
      ['list', '--id', '9001'], ['list', '--now', '0'], ['list', '--json'],
      ['list', '--force'], ['list', '--yes'], ['list', 'extra'],
    ]) jsonError(await f.cli('lesson', ...args), { status: 'error', code: 'lesson-args', field: 'arguments' });
    for (const args of [
      ['list', '--area'], ['list', '--area', 'tool', '--area', 'tool'],
      ['list', '--queued', '--shipped'], ['list', '--older-than', '-1'],
      ['set', '9001', '--status', 'invalid'], ['check', '--stale-days', '1.5'],
      ['manifest', '9001', '--agent', 'claude', '--model', 'sonnet', '--tier', 'invalid'],
    ]) {
      const result = await f.cli('lesson', ...args);
      const error = JSON.parse(result.stderr);
      assert.equal(error.code, 'lesson-args');
      assert.equal(typeof error.field, 'string');
      assert.deepEqual(Object.keys(error).sort(), ['code', 'field', 'status']);
      jsonError(result, error);
    }
    jsonError(await f.cli('lesson', 'set', '9002', '--status', 'built', ...common), { status: 'error', code: 'lesson-not-found', id: 9002 });
    const unsafe = await f.cli('lesson', 'add', '--area', 'gotchas', '--evidence', 'run-0000', '--rule', privateTerms9001, '--fix', 'Guard input.', ...common);
    jsonError(unsafe, { status: 'error', code: 'private-name', field: 'rule' });
    assert.ok(!unsafe.stderr.includes(privateTerms9001));
    assert.equal(await f.read('coordination/swarm-lessons.jsonl'), before);
    await assert.rejects(f.read('.swarm/gotchas.md'), { code: 'ENOENT' });
    await f.write('coordination/swarm-lessons.jsonl', `\n${privateTerms9001}\n`);
    jsonError(await f.cli('lesson', 'list', ...common), { status: 'error', code: 'lesson-store-invalid', line: 2 });
    for (const [args, expected] of [
      [['lesson', 'list', '--root'], { status: 'error', code: 'lesson-args', field: 'root' }],
      [['--root', path.join(f.root, 'missing'), 'lesson', 'list'], { status: 'error', code: 'lesson-io', field: 'root' }],
    ]) await assert.rejects(exec(process.execPath, [runner, ...args], { cwd: installRoot, env: { ...process.env } }), error => {
      jsonError(error, expected);
      return true;
    });
  });

  test('T80 manifest validates and always declares its regression test', async t => {
    const f = await lessonFixture(t);
    const packageBefore = await f.read('package.json');
    await f.store([queued9001], 'coordination/selected.jsonl');
    for (const tier of [null, 'cheap', 'mid', 'expensive']) {
      const output = await f.cli('lesson', 'manifest', '9001', '--agent', 'claude', '--model', 'sonnet', '--file', 'coordination/selected.jsonl', ...common, ...(tier ? ['--tier', tier] : []));
      const manifest = jsonSuccess(output);
      assert.deepEqual(manifest.jobs[0].outputs, ['tools/example.mjs', 'tests/field-lesson-9001.test.mjs']);
      assert.deepEqual(manifest.jobs[0].context, ['tools/example.mjs', 'package.json']);
      assert.equal(manifest.jobs[0].prompt, `${queued9001.fix}\nEvidence: ${queued9001.evidence}\nAdd a node:test case in tests/field-lesson-9001.test.mjs that fails without the fix; fixtures use fake ids, no names, repos, URLs or prompt text.`);
      assert.equal(manifest.jobs[0].model, 'sonnet');
      assert.equal(manifest.jobs[0].tier, tier ?? undefined);
      assert.equal(manifest.jobs[0].tierReason, tier === 'expensive' ? 'Explicit lesson manifest --tier expensive selection.' : undefined);
      await f.write('manifest.json', output.stdout);
      assert.equal(jsonSuccess(await f.cli('validate', 'manifest.json')).status, 'valid');
    }
    await f.write('package.json', ' \n');
    jsonError(await f.cli('lesson', 'manifest', '9001', '--agent', 'claude', '--model', 'sonnet', '--file', 'coordination/selected.jsonl', ...common), { status: 'error', code: 'lesson-manifest-invalid', field: 'manifest' });
    await f.write('package.json', packageBefore);
    // This unrelated regression is tracked but absent from the generated context, so the
    // existing project validator must refuse. A shape-only validator cannot catch it.
    await f.write('tests/field-lesson-9002.test.mjs', "import { value } from '../tools/example.mjs';\n");
    await exec('git', ['add', '--', 'tests/field-lesson-9002.test.mjs'], { cwd: f.root, env: { ...process.env } });
    jsonError(await f.cli('lesson', 'manifest', '9001', '--agent', 'claude', '--model', 'sonnet', '--file', 'coordination/selected.jsonl', ...common), { status: 'error', code: 'lesson-manifest-invalid', field: 'manifest' });
  });

  test('check uses the selected installed tree and reports findings with exit zero', async t => {
    const f = await lessonFixture(t);
    await f.store([shipped9002], 'coordination/selected.jsonl');
    await f.write('installed9001/.keep', 'fixture\n');
    await f.write(shipped9002.test, '// Project copy is not installation evidence.\n');
    const args = ['lesson', 'check', '--file', 'coordination/selected.jsonl', '--stale-days', '0', '--installed', 'installed9001', ...common];
    assert.deepEqual(jsonSuccess(await f.cli(...args)), { status: 'ok', checked: 1, findings: [{ code: 'lesson-test-missing', id: 9002, test: shipped9002.test }] });
    await f.write(`installed9001/${shipped9002.test}`, '// Installed fixture.\n');
    assert.deepEqual(jsonSuccess(await f.cli(...args)), { status: 'ok', checked: 1, findings: [] });
    await f.store([{ ...shipped9002, test: null }], 'coordination/selected.jsonl');
    assert.deepEqual(jsonSuccess(await f.cli(...args)).findings, [{ code: 'lesson-test-missing', id: 9002, test: null }]);
    await f.store([queued9001], 'coordination/selected.jsonl');
    const before = Date.now();
    const findings = jsonSuccess(await f.cli(...args)).findings;
    const after = Date.now();
    assert.equal(findings.length, 1);
    assert.ok([before, after].some(now => JSON.stringify(findings[0]) === JSON.stringify({ code: 'lesson-stale', id: 9001, days: lessonAgeDays(queued9001.date, () => now), limit: 0 })));
    const highLimit = String(lessonAgeDays(queued9001.date) + 2);
    assert.deepEqual(jsonSuccess(await f.cli('lesson', 'check', '--file', 'coordination/selected.jsonl', '--stale-days', highLimit, '--installed', 'installed9001', ...common)).findings, []);
    assert.deepEqual(await f.cli('lesson', 'list', '--file', 'coordination/selected.jsonl', '--older-than', highLimit, ...common), { code: 0, stdout: '', stderr: '' });
  });

  test('publish and import route their file flags correctly and are idempotent', async t => {
    const f = await lessonFixture(t);
    await f.store([shipped9002]);
    const args = ['lesson', 'publish', '--version', '1.41.0', '--file', 'docs/public.md', ...common];
    assert.deepEqual(jsonSuccess(await f.cli(...args)), { status: 'ok', version: '1.41.0', file: 'docs/public.md', published: [9002], skipped: [] });
    const before = await f.read('docs/public.md');
    assert.ok(before.includes('<!-- swarm-lesson:9002:1.41.0 -->'));
    assert.ok(!before.includes('run-0000'));
    assert.deepEqual(jsonSuccess(await f.cli(...args)).skipped, [9002]);
    assert.equal(await f.read('docs/public.md'), before);
    await f.store([shipped9002, { ...shipped9002, id: 9003, public: 'Do not carry run-0000 into prose.' }]);
    jsonError(await f.cli(...args), { status: 'error', code: 'public-line-unsafe', field: 'public', pattern: 'run-id' });
    assert.equal(await f.read('docs/public.md'), before);
    await f.write('coordination/legacy.md', '# | Date | What happened | Evidence | Proposed swarm fix | Status\n' + legacy9003);
    const importArgs = ['lesson', 'import', '--from', 'coordination/legacy.md', '--file', 'coordination/imported.jsonl', ...common];
    assert.deepEqual(jsonSuccess(await f.cli(...importArgs)), { status: 'ok', imported: [9003], skipped: [], padded: [], overflow: [] });
    const imported = await f.read('coordination/imported.jsonl');
    assert.deepEqual(jsonSuccess(await f.cli(...importArgs)), { status: 'ok', imported: [], skipped: [9003], padded: [], overflow: [] });
    assert.equal(await f.read('coordination/imported.jsonl'), imported);
    assert.equal(JSON.parse(imported).date, '2000-01-03');
  });
});

describe('T80 run queue integration', () => {
  test('T80 list filters and run queue warning use one age rule', async t => {
    const f = await lessonFixture(t);
    const rows = [shipped9002, { ...queued9001, id: 9003, area: 'gotchas' }, queued9001, { ...queued9001, id: 9004, status: 'built' }];
    await f.store(rows);
    const line = row => `#${row.id} ${row.date} ${row.area} ${row.status} ${row.rule.slice(0, 100)}\n`;
    for (const [flags, expected] of [
      [[], [queued9001, shipped9002, rows[1], rows[3]]],
      [['--queued'], [queued9001, rows[1]]], [['--shipped'], [shipped9002]],
      [['--area', 'gotchas'], [rows[1]]], [['--older-than', '0'], [queued9001, shipped9002, rows[1], rows[3]]],
      [['--queued', '--area', 'tool', '--older-than', '0'], [queued9001]],
      [['--shipped', '--area', 'gotchas'], []],
    ]) assert.deepEqual(await f.cli('lesson', 'list', ...flags, ...common), { code: 0, stdout: expected.map(line).join(''), stderr: '' });
    const fixedNow = () => Date.parse('2000-01-10T23:59:59Z');
    assert.equal(lessonAgeDays('2000-01-02', fixedNow), 8);
    assert.equal(lessonAgeDays('2000-01-11', fixedNow), 0);
    assert.deepEqual(await lessonQueueWarnings(f.root, { now: fixedNow }), ['lesson-queue: 2 queued, oldest #9001 (8 days)']);
    const before = Date.now();
    let cleared = false;
    const state = await runManifest(f.root, structuredClone(manifest9001), {
      id: 'run-0000', spawnImpl: fakeSpawn, env: { ...process.env }, liveDir: path.join(f.root, 'live'),
      onState: current => {
        if (!cleared && current.jobs.some(job => job.status === 'running')) {
          // Subsequent saves must use the warning captured at run start.
          cleared = true;
          writeFileSync(path.join(f.root, 'coordination/swarm-lessons.jsonl'), '');
        }
      },
    });
    const after = Date.now();
    assert.equal(state.status, 'complete', state.error);
    assert.equal(cleared, true);
    const saved = JSON.parse(await f.read('.swarm/runs/run-0000/state.json'));
    const queue = saved.warnings.filter(warning => warning.startsWith('lesson-queue:'));
    assert.equal(queue.length, 1);
    assert.ok([before, after].some(now => queue[0] === `lesson-queue: 2 queued, oldest #9001 (${lessonAgeDays(queued9001.date, () => now)} days)`));
    assert.ok(saved.warnings.includes('permission denials: lesson-9001: Read tools/example.mjs'));
    assert.deepEqual(saved.warnings, state.warnings);
  });

  test('no queued rows produce no warning and malformed stores refuse before spawn', async t => {
    for (const rows of [null, [shipped9002]]) {
      const f = await lessonFixture(t);
      if (rows) await f.store(rows);
      assert.deepEqual(await lessonQueueWarnings(f.root), []);
      const state = await runManifest(f.root, structuredClone(manifest9001), { id: 'run-0000', spawnImpl: fakeSpawn, env: { ...process.env }, liveDir: path.join(f.root, 'live') });
      assert.equal(state.status, 'complete', state.error);
      const saved = JSON.parse(await f.read('.swarm/runs/run-0000/state.json'));
      assert.ok(!saved.warnings.some(warning => warning.startsWith('lesson-queue:')));
      if (!rows) await assert.rejects(f.read('coordination/swarm-lessons.jsonl'), { code: 'ENOENT' });
    }
    const f = await lessonFixture(t);
    await f.write('coordination/swarm-lessons.jsonl', 'invalid\n');
    let spawns = 0;
    await assert.rejects(runManifest(f.root, structuredClone(manifest9001), { id: 'run-0000', spawnImpl: () => { spawns++; return fakeSpawn(); }, env: { ...process.env }, liveDir: path.join(f.root, 'live') }), error => {
      assert.deepEqual(error.lessonError, { status: 'error', code: 'lesson-store-invalid', line: 1 });
      return true;
    });
    assert.equal(spawns, 0);
  });
});

test('T80 release docs describe the bounded loop and pin kickoff to 1.48.0', async () => {
  const [pkgText, readme, changelog, skill] = await Promise.all(['package.json', 'README.md', 'CHANGELOG.md', 'skills/project-swarm/SKILL.md'].map(file => fs.readFile(path.join(installRoot, file), 'utf8')));
  const pkg = JSON.parse(pkgText);
  assert.equal(pkg.version, '1.48.0');
  assert.equal(pkg.scripts.test, 'node --import ./tests/_isolate-config.mjs --test tests/*.test.mjs');
  assert.equal(pkg.scripts.check, 'node tools/check-package.mjs');
  assert.equal(pkg.scripts.build, undefined);
  assert.match(readme, /Use Project Swarm 1\.48\.0/);
  assert.match(readme, /Install from tag v1\.48\.0/);
  assert.match(skill, /v1\.48\.0, run `install\.mjs --user`/);
  assert.match(changelog, /^# Changelog\n\n## 1\.48\.0\n/);
  const section = skill.slice(skill.indexOf('## Field lessons and prompt guidance\n'), skill.indexOf('## Completion and reuse\n'));
  assert.ok(section.trimEnd().split('\n').length <= 10);
  assert.equal(section.split('\n').filter(line => line.startsWith('- ')).length, 6);
  for (const verb of ['add', 'list', 'set', 'manifest', 'check', 'publish', 'import']) {
    assert.ok(section.includes(`lesson ${verb}`), verb);
    assert.ok(readme.includes(`lesson ${verb}`), verb);
  }
});
