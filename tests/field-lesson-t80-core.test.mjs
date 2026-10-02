// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LESSON_USAGE, parseLessonArgs, lessonError, readLessons, writeLessons, parseLegacyLessons, assertLessonPrivateSafe, lessonAgeDays, lessonQueueWarnings, runLessonCore } from '../tools/lessons.mjs';

const store = 'coordination/swarm-lessons.jsonl';
const legacyFile = 'coordination/swarm-lessons.md';
const skillFile = 'coordination/skills/fixture-skill/SKILL.md';
const privateTerms9001 = 'FixtureSecret9001';
const queued9001 = { id: 9001, date: '2000-01-02', area: 'tool', evidence: 'run-0000', rule: 'Validate input.', fix: 'Guard tools/example.mjs.', public: null, status: 'queued', test: null, version: null };
const shipped9002 = { ...queued9001, id: 9002, status: 'shipped', version: '1.41.0', test: 'tests/field-lesson-9002.test.mjs' };
const legacy9003 = '| 9003 | 2000-01-02 | Observed failure. Rule: Validate input. | run-0000 | **Swarm fix:** Guard tools/example.mjs. Status: queued |\n';
const add = { command: 'add', area: 'tool', evidence: 'run-0000', rule: 'Validate input.', fix: 'Guard tools/example.mjs.' };
const now = () => Date.parse('2000-01-10T23:59:59.999Z');
const line = value => JSON.stringify(value) + '\n';

async function put(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
async function lessonFixture(t, { seed = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'swarm-lesson-core-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (seed) await put(root, store, line(queued9001));
  await put(root, 'coordination/private-names.txt', privateTerms9001 + '\n');
  return root;
}
async function refuses(action, expected) {
  await assert.rejects(action, error => {
    assert.deepEqual(error.lessonError, { status: 'error', ...expected });
    assert.equal(error.message, expected.code);
    assert(!JSON.stringify(error.lessonError).includes(privateTerms9001));
    return true;
  });
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

describe('T80 core lessons', () => {
  test('T80 add rejects private fields without writes or disclosure', async t => {
    const root = await lessonFixture(t);
    const skill = '---\nname: fixture-skill\npaths:\n  - "tools/**"\nchecks:\n  resultKeys:\n    - status\n---\nKeep guidance.\n';
    await put(root, skillFile, skill);
    const before = await fs.readFile(path.join(root, store));
    for (const field of ['area', 'evidence', 'rule', 'fix', 'public']) {
      await refuses(() => runLessonCore(root, { ...add, area: 'fixture-skill', [field]: privateTerms9001 }, { now }), { code: 'private-name', field });
      assert.deepEqual(await fs.readFile(path.join(root, store)), before);
      assert.equal(await fs.readFile(path.join(root, skillFile), 'utf8'), skill);
    }
    await refuses(() => runLessonCore(root, { ...add, area: '../invalid', evidence: privateTerms9001 }, { now }), { code: 'private-name', field: 'evidence' });
    await refuses(() => runLessonCore(root, { ...add, storeFile: `new/${privateTerms9001}.jsonl` }, { now }), { code: 'private-name', field: 'file' });
    await assert.rejects(fs.stat(path.join(root, 'new')), { code: 'ENOENT' });
    await put(root, `${privateTerms9001}.txt`, privateTerms9001 + '\n');
    await refuses(() => runLessonCore(root, { ...add, privateNamesFile: `${privateTerms9001}.txt` }, { now }), { code: 'private-name', field: 'private-names' });
    const clean = await runLessonCore(root, { ...add, area: 'fixture-skill' }, { now });
    assert.equal(clean.exitCode, 0);
    const result = JSON.parse(clean.stdout);
    assert.equal(clean.stdout, line(result));
    assert.equal(result.lesson.id, 9002);
    assert.equal(result.routedTo, skillFile);
    assert.equal(await fs.readFile(path.join(root, skillFile), 'utf8'), skill + '\n## Lessons\n\n- Validate input. (lesson 9002)\n');
  });

  test('generated row fields use the same privacy guard', async t => {
    const root = await lessonFixture(t);
    const before = await fs.readFile(path.join(root, store));
    for (const [field, term] of [['id', '9002'], ['date', '2000-01-10'], ['status', 'queued']]) {
      await put(root, 'coordination/private-names.txt', term + '\n');
      await refuses(() => runLessonCore(root, add, { now }), { code: 'private-name', field });
      assert.deepEqual(await fs.readFile(path.join(root, store)), before);
    }
    for (const field of Object.keys(queued9001)) {
      await put(root, 'coordination/private-names.txt', privateTerms9001 + '\n');
      await refuses(() => assertLessonPrivateSafe(root, { [field]: privateTerms9001 }), { code: 'private-name', field });
    }
  });

  test('refused add leaves missing parents absent and accepted text stays literal', async t => {
    const root = await lessonFixture(t);
    for (const [field, value] of [['rule', 'two\nlines'], ['public', 'two\rlines'], ['fix', ''], ['evidence', '']]) {
      await refuses(() => runLessonCore(root, { ...add, storeFile: 'new/rows.jsonl', [field]: value }, { now }), { code: 'lesson-args', field });
      await assert.rejects(fs.stat(path.join(root, 'new')), { code: 'ENOENT' });
    }
    const evidence = 'run-0000\nLiteral evidence.', fix = 'Guard input.\nKeep the next line.';
    const result = JSON.parse((await runLessonCore(root, { ...add, evidence, fix, rule: '  Validate input.  ', public: '  Generic guidance.  ' }, { now })).stdout);
    assert.equal(result.lesson.date, '2000-01-10');
    assert.equal(result.lesson.evidence, evidence);
    assert.equal(result.lesson.fix, fix);
    assert.equal(result.lesson.rule, 'Validate input.');
    assert.equal(result.lesson.public, 'Generic guidance.');
    assert.equal((await fs.readFile(path.join(root, store), 'utf8')).split('\n').filter(Boolean).length, 2);
    await refuses(() => runLessonCore(root, { ...add, privateNamesFile: 'missing-terms.txt' }, { now }), { code: 'lesson-io', field: 'private-names' });
  });

  test('T80 skill cap refuses the whole add', async t => {
    const root = await lessonFixture(t);
    const suffix = '\n\n## Lessons\n\n- Validate input. (lesson 9002)\n';
    const skillAtCap9001 = 'x'.repeat(3200 - Buffer.byteLength(suffix));
    for (const extra of ['x', 'é']) {
      const skill = skillAtCap9001 + extra;
      assert(Math.ceil((skill + suffix).length / 4) <= 801);
      if (extra === 'é') assert((skill + suffix).length < Buffer.byteLength(skill + suffix));
      await put(root, skillFile, skill);
      const before = await fs.readFile(path.join(root, store));
      await refuses(() => runLessonCore(root, { ...add, area: 'fixture-skill' }, { now }), { code: 'skill-too-long', tokens: 801, cap: 800 });
      assert.deepEqual(await fs.readFile(path.join(root, store)), before);
      assert.equal(await fs.readFile(path.join(root, skillFile), 'utf8'), skill);
    }
    // A multibyte body passes the old character estimate but fails the required byte estimate.
    const multibyte = 'é'.repeat(1550) + 'x'.repeat(101 - Buffer.byteLength(suffix));
    assert(Math.ceil((multibyte + suffix).length / 4) < 800);
    assert.equal(Math.ceil(Buffer.byteLength(multibyte + suffix) / 4), 801);
    await put(root, skillFile, multibyte);
    await refuses(() => runLessonCore(root, { ...add, area: 'fixture-skill' }, { now }), { code: 'skill-too-long', tokens: 801, cap: 800 });
    assert.equal(await fs.readFile(path.join(root, skillFile), 'utf8'), multibyte);
    assert.deepEqual(await readLessons(root), [queued9001]);
    await put(root, skillFile, skillAtCap9001);
    const clean = await runLessonCore(root, { ...add, area: 'fixture-skill' }, { now });
    assert.equal(clean.exitCode, 0);
    assert.equal(Buffer.byteLength(await fs.readFile(path.join(root, skillFile))), 3200);
    assert.equal((await readLessons(root)).length, 2);
  });

  test('T80 id continues beyond legacy and JSONL maxima', async t => {
    for (const seed of [true, false]) {
      const root = await lessonFixture(t, { seed });
      await put(root, legacyFile, '# Narrative 999999\n| # | Date | What happened | Evidence | Proposed swarm fix | Status |\n' + legacy9003 + legacy9003.replace('9003', '9002'));
      const result = JSON.parse((await runLessonCore(root, { ...add, area: 'gotchas' }, { now })).stdout);
      assert.equal(result.lesson.id, 9004);
      assert.equal((await readLessons(root)).at(-1).id, 9004);
      assert.equal(await fs.readFile(path.join(root, '.swarm/gotchas.md'), 'utf8'), '- Validate input. (lesson 9004)\n');
    }
    const root = await lessonFixture(t);
    await put(root, store, line({ ...queued9001, id: 9010, status: 'dropped' }));
    await put(root, legacyFile, legacy9003);
    assert.equal(JSON.parse((await runLessonCore(root, add, { now })).stdout).lesson.id, 9011);
    await put(root, legacyFile, legacy9003.replace('9003', String(Number.MAX_SAFE_INTEGER)));
    const before = await fs.readFile(path.join(root, store));
    await refuses(() => runLessonCore(root, add, { now }), { code: 'lesson-id-overflow', field: 'id' });
    assert.deepEqual(await fs.readFile(path.join(root, store)), before);
    await put(root, legacyFile, legacy9003.replace('2000-01-02', '2000-02-30'));
    await refuses(() => runLessonCore(root, add, { now }), { code: 'lesson-import-invalid', line: 1 });
    assert.deepEqual(await fs.readFile(path.join(root, store)), before);
  });

  test('T80 list filters and run queue warning use one age rule', async t => {
    const root = await lessonFixture(t);
    const rows = [{ ...queued9001, id: 9005, date: '2000-01-11' }, shipped9002, { ...queued9001, id: 9004, date: '2000-01-03', area: 'gotchas' }, { ...queued9001, id: 9003 }, queued9001];
    await put(root, store, rows.map(line).join(''));
    assert.equal(lessonAgeDays('2000-01-02', now), 8);
    assert.equal(lessonAgeDays('2000-01-11', now), 0);
    const all = [...rows].sort((a, b) => a.id - b.id).map(row => `#${row.id} ${row.date} ${row.area} ${row.status} ${row.rule}\n`).join('');
    assert.deepEqual(await runLessonCore(root, { command: 'list' }, { now }), { stdout: all, exitCode: 0 });
    assert.equal((await runLessonCore(root, { command: 'list', queued: true, area: 'tool', olderThan: 7 }, { now })).stdout, '#9001 2000-01-02 tool queued Validate input.\n#9003 2000-01-02 tool queued Validate input.\n');
    assert.equal((await runLessonCore(root, { command: 'list', shipped: true }, { now })).stdout, '#9002 2000-01-02 tool shipped Validate input.\n');
    assert.equal((await runLessonCore(root, { command: 'list', area: 'gotchas', olderThan: 7 }, { now })).stdout, '');
    assert.equal((await runLessonCore(root, { command: 'list', olderThan: 8 }, { now })).stdout, '');
    assert.deepEqual(await lessonQueueWarnings(root, { now }), ['lesson-queue: 4 queued, oldest #9001 (8 days)']);
    await put(root, store, line(shipped9002));
    assert.deepEqual(await lessonQueueWarnings(root, { now }), []);
    await put(root, store, line({ ...queued9001, date: '2000-01-09', rule: 'x'.repeat(101) }));
    assert.deepEqual(await lessonQueueWarnings(root, { now }), ['lesson-queue: 1 queued, oldest #9001 (1 days)']);
    assert.equal((await runLessonCore(root, { command: 'list' }, { now })).stdout, '#9001 2000-01-09 tool queued ' + 'x'.repeat(100) + '\n');
    const empty = await lessonFixture(t, { seed: false });
    assert.deepEqual(await lessonQueueWarnings(empty, { now }), []);
    assert.deepEqual(await runLessonCore(empty, { command: 'list', storeFile: 'missing/rows.jsonl' }), { stdout: '', exitCode: 0 });
    await assert.rejects(fs.stat(path.join(empty, 'missing')), { code: 'ENOENT' });
    await put(root, store, '\ninvalid\n');
    await refuses(() => lessonQueueWarnings(root, { now }), { code: 'lesson-store-invalid', line: 2 });
  });

  test('T80 set preserves identity and untouched fields', async t => {
    const root = await lessonFixture(t);
    await put(root, store, line(shipped9002) + line(queued9001));
    const result = await runLessonCore(root, { command: 'set', id: 9002, status: 'dropped' }, { now });
    assert.deepEqual(result, { stdout: line({ status: 'ok', lesson: { ...shipped9002, status: 'dropped' } }), exitCode: 0 });
    assert.deepEqual(await readLessons(root), [{ ...shipped9002, status: 'dropped' }, queued9001]);
    const built = { ...queued9001, status: 'built', version: '1.41.0-rc.1+fixture', test: 'tests/field-lesson-9001.test.mjs' };
    assert.equal((await runLessonCore(root, { command: 'set', id: 9001, status: built.status, version: built.version, test: built.test }, { now })).stdout, line({ status: 'ok', lesson: built }));
    const before = await fs.readFile(path.join(root, store));
    for (const [field, value] of [['status', privateTerms9001], ['version', privateTerms9001], ['test', `tests/${privateTerms9001}.mjs`]]) {
      await refuses(() => runLessonCore(root, { command: 'set', id: 9001, status: 'queued', [field]: value }), { code: 'private-name', field });
      assert.deepEqual(await fs.readFile(path.join(root, store)), before);
    }
    await refuses(() => runLessonCore(root, { command: 'set', id: 9001, status: 'shipped', test: 'tests/../outside.mjs' }), { code: 'lesson-args', field: 'test' });
    await refuses(() => runLessonCore(root, { command: 'set', id: 9009, status: 'queued' }), { code: 'lesson-not-found', id: 9009 });
    assert.deepEqual(await fs.readFile(path.join(root, store)), before);
  });

  test('store validation rejects malformed rows at physical lines without repairing them', async t => {
    const root = await lessonFixture(t);
    for (const bad of [line({ ...queued9001, extra: true }), line({ ...queued9001, date: '2001-02-29' }), line({ ...queued9001, public: 'two\nlines' }), line({ ...queued9001, version: '01.2.3' }), line({ ...queued9001, test: '/tests/x.mjs' }), line({ ...queued9001, id: '9001' }), '{bad}\n', JSON.stringify(queued9001)]) {
      await put(root, store, '\n' + bad);
      await refuses(() => readLessons(root), { code: 'lesson-store-invalid', line: 2 });
      assert.equal(await fs.readFile(path.join(root, store), 'utf8'), '\n' + bad);
    }
    await put(root, store, line(queued9001) + '\n' + line(queued9001));
    await refuses(() => readLessons(root), { code: 'lesson-store-invalid', line: 3 });
    await put(root, store, line({ ...queued9001, evidence: privateTerms9001 }));
    assert.equal((await readLessons(root))[0].evidence, privateTerms9001);
    assert.equal((await runLessonCore(root, { command: 'list' })).exitCode, 0);
    await put(root, store, line({ ...queued9001, rule: privateTerms9001 }));
    await refuses(() => runLessonCore(root, { command: 'list' }), { code: 'private-name', field: 'rule' });
  });

  test('legacy parser handles five and six cells, separate rules, escaped pipes, and code spans', () => {
    const header = '| # | Date | What happened | Evidence | Proposed swarm fix | Status |\n';
    const rows = parseLegacyLessons(header + legacy9003 + '| 9004 | 2000-02-29 | Incident. | Rule: Keep input. | **Swarm fix:** Preserve **formatting**. Status: shipped 1.41.0 (release) |\n' + '| 9005 | 2000-01-02 | Incident. Fix: First fix. Rule: First rule. | `run-0000|sample` | Rule: Later rule. | Fix: Last fix. Status: built 1.41.0-rc.1 |\n' + '| 9006 | 2000-01-02 | Incident. | run-0000\\|sample | Final fix. | Status: dropped |\n');
    assert.equal(rows[0].id, 9003);
    assert.equal(rows[0].date, '2000-01-02');
    assert.equal(rows[0].evidence, 'Observed failure.\nrun-0000');
    assert.equal(rows[0].rule, 'Validate input.');
    assert.equal(rows[0].fix, 'Guard tools/example.mjs.');
    assert.equal(rows[1].status, 'shipped');
    assert.equal(rows[1].version, '1.41.0');
    assert.equal(rows[1].fix, 'Preserve **formatting**.');
    assert.equal(rows[2].rule, 'Later rule.');
    assert.equal(rows[2].fix, 'Last fix.');
    assert.equal(rows[2].evidence, 'Incident.\n`run-0000|sample`');
    assert.equal(rows[3].evidence, 'Incident.\nrun-0000|sample');
    assert.equal(rows[3].fix, 'Final fix.');
    assert.equal(rows[3].status, 'dropped');
    assert.deepEqual(parseLegacyLessons(header + legacy9003 + legacy9003), [rows[0]]);
    for (const alternate of [
      '# | Date | What happened | Evidence | Proposed swarm fix | Status\n',
      '| Id | When | Incident | Proof | Change | State |\n|---|---|---|---|---|---|\n',
      'Id | When | Incident | Proof | Change | State\n--- | --- | --- | --- | --- | ---\n',
      '| 1 | 2 | 3 | 4 | 5 | 6 |\n|---|\n',
    ]) assert.deepEqual(parseLegacyLessons(alternate + legacy9003), [rows[0]]);
    for (const source of [legacy9003.replace('Status: queued', 'Status: strange'), legacy9003.replace('9003', '9007199254740992'), legacy9003.replace('9003', '-9003'), legacy9003 + legacy9003.replace('Guard', 'Change'), '| 9007 | broken |\n']) {
      assert.throws(() => parseLegacyLessons(source), error => error.lessonError.code === 'lesson-import-invalid');
    }
    const fallback = parseLegacyLessons(header + '| 9008 | 2000-01-02 | Incident. | Only fix. |\n| 9009 | 2000-01-02 | | Rule: Keep input. | Status: queued |\n');
    assert.equal(fallback[0].rule, 'Incident.');
    assert.equal(fallback[0].fix, 'Only fix.');
    assert.equal(fallback[1].evidence, 'legacy lesson 9009');
    assert.equal(fallback[1].fix, 'Keep input.');
    const bold = parseLegacyLessons(header + '| 9010 | 2000-01-02 | Incident. | Fix: Keep **formatting** Status: queued |\n');
    assert.equal(bold[0].fix, 'Keep **formatting**');
  });

  test('routing preserves unrelated text and refuses invalid destinations before writes', async t => {
    const root = await lessonFixture(t);
    const prefix = '---\nname: fixture-skill\n---\nIntro\n## Lessons\n\n- Previous.\n';
    const suffix = '## Next\nUnchanged.\n';
    await put(root, skillFile, prefix + suffix);
    await runLessonCore(root, { ...add, area: 'fixture-skill' }, { now });
    assert.equal(await fs.readFile(path.join(root, skillFile), 'utf8'), prefix + '- Validate input. (lesson 9002)\n' + suffix);
    const before = await fs.readFile(path.join(root, store));
    for (const area of ['../outside', 'missing', 'Fixture']) await refuses(() => runLessonCore(root, { ...add, area }, { now }), { code: 'lesson-area-invalid', field: 'area' });
    await put(root, skillFile, '## Lessons\n\n## Lessons\n');
    await refuses(() => runLessonCore(root, { ...add, area: 'fixture-skill' }, { now }), { code: 'lesson-route-invalid', field: 'area' });
    await put(root, '.swarm/gotchas.md', 'x'.repeat(16 * 1024));
    await refuses(() => runLessonCore(root, { ...add, area: 'gotchas' }, { now }), { code: 'lesson-route-invalid', field: 'area' });
    assert.deepEqual(await fs.readFile(path.join(root, store)), before);
    const target = await lessonFixture(t);
    await fs.mkdir(path.join(root, 'coordination/skills/linked'), { recursive: true });
    await fs.symlink(path.join(target, store), path.join(root, 'coordination/skills/linked/SKILL.md'));
    await refuses(() => runLessonCore(root, { ...add, area: 'linked' }, { now }), { code: 'lesson-route-invalid', field: 'area' });
    await fs.symlink(target, path.join(root, 'coordination/skills/escaped'), 'junction');
    await refuses(() => runLessonCore(root, { ...add, area: 'escaped' }, { now }), { code: 'lesson-route-invalid', field: 'area' });
    assert.deepEqual(await fs.readFile(path.join(root, store)), before);
  });

  test('write replacement locks, validates, and rolls route bytes back on ordinary failure', async t => {
    const root = await lessonFixture(t);
    await writeLessons(root, [shipped9002, queued9001]);
    assert.deepEqual(await readLessons(root), [shipped9002, queued9001]);
    const file = path.join(root, store);
    const lock = path.join(os.tmpdir(), `swarm-lesson-${createHash('sha256').update(file).digest('hex')}.lock`);
    await fs.writeFile(lock, '', { flag: 'wx' });
    t.after(() => fs.rm(lock, { force: true }));
    await refuses(() => runLessonCore(root, add, { now }), { code: 'lesson-io', field: 'file' });
    await fs.unlink(lock);
    await put(root, skillFile, 'Keep guidance.\n');
    const before = await fs.readFile(file), guidance = await fs.readFile(path.join(root, skillFile));
    // Fail only the second destination commit, after the route has been replaced.
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === file && from.endsWith('.tmp')) throw Object.assign(new Error('synthetic failure'), { code: 'EIO' });
      return rename(from, to);
    });
    await refuses(() => runLessonCore(root, { ...add, area: 'fixture-skill' }, { now }), { code: 'lesson-io', field: 'file' });
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readFile(path.join(root, skillFile)), guidance);
  });

  test('strict parser exposes the agreed options for every verb', () => {
    for (const command of ['add', 'list', 'set', 'manifest', 'check', 'publish', 'import']) assert.deepEqual(parseLessonArgs([command, '--help']), { command, help: true });
    assert.deepEqual(parseLessonArgs(['-h']), { help: true });
    assert.deepEqual(parseLessonArgs(['manifest', '9001', '--agent', 'claude', '--model', 'sonnet', '--tier', 'expensive', '--file', 'rows.jsonl', '--private-names', 'terms.txt']), { command: 'manifest', id: 9001, agent: 'claude', model: 'sonnet', tier: 'expensive', storeFile: 'rows.jsonl', privateNamesFile: 'terms.txt' });
    assert.deepEqual(parseLessonArgs(['check', '--stale-days', '0', '--installed', 'installed']), { command: 'check', staleDays: 0, installed: 'installed' });
    assert.deepEqual(parseLessonArgs(['publish', '--version', '1.41.0', '--file', 'public.md']), { command: 'publish', version: '1.41.0', publishFile: 'public.md' });
    assert.deepEqual(parseLessonArgs(['import', '--from', 'legacy.md']), { command: 'import', from: 'legacy.md' });
    assert.equal(parseLessonArgs(['list', '--older-than', '7']).olderThan, 7);
    for (const args of [[], ['unknown'], ['add', '--date', '2000-01-02'], ['add', '--id', '9001'], ['list', '--queued', '--shipped'], ['list', '--queued', '--queued'], ['list', '--area'], ['list', '--area=x'], ['list', '--older-than', '-1'], ['list', '--older-than', '1.5'], ['list', '--older-than', '9007199254740992'], ['set', '9001', '--status', 'invalid'], ['set', '9001', '--status', 'shipped', '--version', 'v1.41.0'], ['set', '9001', '--status', 'built', '--test', 'tests/../x.mjs'], ['manifest', '9001', '--agent', 'claude'], ['manifest', '9001', '--agent', 'claude', '--model', 'sonnet', '--tier', 'invalid'], ['check', '--force'], ['publish', '--version', '1.41.0', 'extra']]) {
      assert.throws(() => parseLessonArgs(args), error => error.lessonError.code === 'lesson-args');
    }
    for (const flag of ['--file', '--private-names', '--area', '--evidence', '--rule', '--fix', '--public', '--queued', '--shipped', '--older-than', '--status', '--version', '--test', '--agent', '--model', '--tier', '--stale-days', '--installed', '--from', '--help', '-h']) assert(LESSON_USAGE.includes(flag));
    assert.deepEqual(lessonError('lesson-args', { field: privateTerms9001 }).lessonError, { status: 'error', code: 'lesson-args', field: 'arguments' });
  });

  test('CLI add/list/set branches use root-relative files and safe exact envelopes', async t => {
    const root = await lessonFixture(t);
    const argv = ['add', '--area', 'gotchas', '--evidence', 'run-0000', '--rule', 'Validate input.', '--fix', 'Guard tools/example.mjs.'];
    const beforeDate = new Date().toISOString().slice(0, 10);
    const added = await cli(root, argv);
    const afterDate = new Date().toISOString().slice(0, 10);
    assert.equal(added.exitCode, 0); assert.equal(added.stderr, '');
    const result = JSON.parse(added.stdout);
    assert.equal(added.stdout, line(result));
    assert.equal(result.lesson.id, 9002);
    assert([beforeDate, afterDate].includes(result.lesson.date));
    assert.equal(result.routedTo, '.swarm/gotchas.md');
    const bytes = await fs.readFile(path.join(root, store)), guidance = await fs.readFile(path.join(root, '.swarm/gotchas.md'));
    const refused = await cli(root, [...argv.slice(0, -1), privateTerms9001]);
    assert.deepEqual(refused, { stdout: '', stderr: line({ status: 'error', code: 'private-name', field: 'fix' }), exitCode: 1 });
    assert.deepEqual(await fs.readFile(path.join(root, store)), bytes);
    assert.deepEqual(await fs.readFile(path.join(root, '.swarm/gotchas.md')), guidance);
    const set = await cli(root, ['set', '9002', '--status', 'built', '--version', '1.41.0', '--test', 'tests/field-lesson-9002.test.mjs']);
    assert.deepEqual(set, { stdout: line({ status: 'ok', lesson: { ...result.lesson, status: 'built', version: '1.41.0', test: 'tests/field-lesson-9002.test.mjs' } }), stderr: '', exitCode: 0 });
    assert.deepEqual(await cli(root, ['list', '--queued', '--area', 'tool']), { stdout: '#9001 2000-01-02 tool queued Validate input.\n', stderr: '', exitCode: 0 });
    assert.deepEqual(await cli(root, ['list', '--file', 'missing/rows.jsonl']), { stdout: '', stderr: '', exitCode: 0 });
    assert.deepEqual(await cli(root, ['list', '--date', '2000-01-02']), { stdout: '', stderr: line({ status: 'error', code: 'lesson-args', field: 'arguments' }), exitCode: 1 });
    assert.deepEqual(await cli(root, ['--help']), { stdout: LESSON_USAGE, stderr: '', exitCode: 0 });
  });
});
