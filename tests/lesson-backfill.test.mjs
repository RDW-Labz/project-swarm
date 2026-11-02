import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactText, validateLesson } from '../tools/lesson-schema.mjs';
import { writeLesson, listLessons } from '../tools/lesson-store.mjs';
import { parseFieldLessons, lessonFromFieldEntry, backfill } from '../tools/lesson-backfill.mjs';

const LINK = 'https://example.com/guides/config';
const EMAIL = ['dev', 'example.org'].join('@');
const HOME = ['', 'Users', 'alice'].join('/');

const FIELD_MD = [
  '# Lessons',
  '',
  '1. **Scope check was skipped.** The worker edited [the config](' + LINK + ') outside its ticket.',
  '   Rule: Check the ticket scope before every edit.',
  '   Enforcement: scope-check runs in CI.',
  '',
  '2. **Flaky timeout in merge queue.** The queue bisect hit a timeout',
  '   on a slow host.',
  '',
  '3. **Path check missed a leak.** Logs showed ' + EMAIL + ' and ' + HOME + '/work.',
  ''
].join('\n');

const STORE_ROWS = [
  {
    id: 1, date: '2026-10-15', area: 'tool',
    evidence: 'Remote hosts never ran a job because the transport sent no command.',
    rule: 'A feature that talks to another machine is not done until a test runs it against a real host.',
    fix: 'Send the command in the request and add a test against a real host.',
    public: 'Remote hosts were only tested with stub transports.',
    status: 'queued', test: null, version: null
  },
  {
    id: 2, date: '2026-10-15', area: 'process',
    evidence: 'An update ran the previous release installer.',
    rule: 'An updater must run the installer of the version it installs, in a fresh process.',
    fix: 'Run the new installer in a child process and add a test.',
    public: 'swarm update now runs the new installer.',
    status: 'shipped', test: null, version: null
  }
];

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'lesson-backfill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'coordination'), { recursive: true });
  await writeFile(join(root, 'docs', 'lessons.md'), FIELD_MD, 'utf8');
  await writeFile(
    join(root, 'coordination', 'swarm-lessons.jsonl'),
    STORE_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );
  return root;
}

async function makeDocRoot(t, md) {
  const root = await mkdtemp(join(tmpdir(), 'lesson-backfill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', 'lessons.md'), md, 'utf8');
  return root;
}

const DUP_MD = [
  '1. **Alpha check failed.** Rule: Do alpha things.',
  '',
  '1. **Beta check failed.** Rule: Do beta things.',
  '',
  '2. **Gamma check.** Rule: Do gamma things.',
  ''
].join('\n');

test('parseFieldLessons splits numbered entries and keeps multi-line bodies', () => {
  const entries = parseFieldLessons(FIELD_MD);
  assert.deepEqual(entries.map((e) => e.number), [1, 2, 3]);
  assert.equal(entries[0].title, 'Scope check was skipped');
  assert.equal(
    entries[0].body,
    'The worker edited the config outside its ticket. Rule: Check the ticket scope before every edit. Enforcement: scope-check runs in CI.'
  );
  assert.equal(entries[1].title, 'Flaky timeout in merge queue');
  assert.equal(entries[1].body, 'The queue bisect hit a timeout on a slow host.');
});

test('markdown links are reduced to their text and no URL remains in the body', () => {
  const [first] = parseFieldLessons(FIELD_MD);
  assert.equal(new URL(LINK).hostname, 'example.com');
  assert.equal(/\]\(|https?:\/\//.test(first.body), false);
  assert.ok(first.body.includes('the config'));
});

test('lessonFromFieldEntry maps fields of an entry with a Rule label', () => {
  const [entry] = parseFieldLessons(FIELD_MD);
  const { lesson, warnings } = lessonFromFieldEntry(entry, { date: '2026-10-01' });
  assert.ok(lesson, 'lesson expected, warnings: ' + warnings.join('; '));
  assert.equal(lesson.id, 'L-0001');
  assert.equal(lesson.project, 'swarm');
  assert.equal(lesson.date, '2026-10-01');
  assert.equal(lesson.stage, 'scope');
  assert.equal(lesson.caughtBy, 'unknown');
  assert.ok(lesson.rule.startsWith('Check the ticket scope before every edit'));
  assert.ok(lesson.what.startsWith('Scope check was skipped'));
  assert.ok(lesson.what.includes('outside its ticket'));
  assert.equal(lesson.what.includes('Rule:'), false);
  assert.ok(lesson.fix.includes('scope-check runs in CI'));
  assert.equal(lesson.guard.status, 'shipped');
  assert.equal(lesson.guard.text, '');
  assert.equal(lesson.guard.kind, 'lint');
  assert.deepEqual(lesson.source, { kind: 'backfill', ref: 'docs/lessons.md#1' });
  assert.ok(lesson.tags.includes('scope'));
  assert.equal(validateLesson(lesson).ok, true);
});

test('lessonFromFieldEntry maps an entry without a Rule label and keeps the id offset', () => {
  const entries = parseFieldLessons(FIELD_MD);
  const { lesson } = lessonFromFieldEntry(entries[1], { date: '2026-10-01', idOffset: 0 });
  assert.ok(lesson);
  assert.equal(lesson.id, 'L-0002');
  assert.equal(lesson.stage, 'merge');
  assert.equal(lesson.guard.status, 'proposed');
  assert.ok(lesson.tags.includes('flaky-test'));
  assert.ok(lesson.tags.includes('timeout'));
  assert.ok(typeof lesson.rule === 'string' && lesson.rule.length > 0 && lesson.rule.length <= 300);
  assert.equal(validateLesson(lesson).ok, true);
});

test('redaction removes an email and a home path from an entry', () => {
  const entries = parseFieldLessons(FIELD_MD);
  const { lesson } = lessonFromFieldEntry(entries[2], { date: '2026-10-01', idOffset: 0 });
  assert.ok(lesson);
  assert.ok(lesson.what.includes('<email>'));
  assert.ok(lesson.what.includes('<home>'));
  assert.equal(lesson.what.includes(EMAIL), false);
  assert.equal(lesson.what.includes(HOME), false);
  assert.equal(validateLesson(lesson).ok, true);
});

test('redactText replaces email and home path and leaves clean text unchanged', () => {
  const dirty = 'mail ' + EMAIL + ' in ' + HOME + '/notes';
  const clean = redactText(dirty);
  assert.ok(clean.includes('<email>'));
  assert.ok(clean.includes('<home>'));
  assert.equal(clean.includes(EMAIL), false);
  assert.equal(clean.includes(HOME), false);
  assert.equal(redactText('plain text with no secrets'), 'plain text with no secrets');
});

test('dry run reports entries but writes nothing', async (t) => {
  const root = await makeRoot(t);
  const result = await backfill(root, { project: 'swarm', dir: 'lessons', dryRun: true, date: '2026-10-01' });
  assert.equal(result.total, 5);
  assert.deepEqual(result.failed, []);
  const { lessons } = await listLessons(root, { dir: 'lessons' });
  assert.equal(lessons.length, 0);
});

test('running backfill twice writes nothing the second time', async (t) => {
  const root = await makeRoot(t);
  const first = await backfill(root, { project: 'swarm', dir: 'lessons', date: '2026-10-01' });
  assert.equal(first.written.length, 5);
  assert.deepEqual(first.failed, []);
  const after1 = await listLessons(root, { dir: 'lessons' });
  assert.equal(after1.lessons.length, 5);
  assert.deepEqual(after1.invalid, []);

  const second = await backfill(root, { project: 'swarm', dir: 'lessons', date: '2026-10-01' });
  assert.deepEqual(second.written, []);
  assert.equal(second.skipped.length, 5);
  const after2 = await listLessons(root, { dir: 'lessons' });
  assert.deepEqual(after2.lessons, after1.lessons);
});

test('backfill skips ids already in the store', async (t) => {
  const root = await makeRoot(t);
  await writeLesson(
    root,
    {
      version: 1,
      id: 'L-0002',
      project: 'swarm',
      date: '2026-10-01',
      stage: 'build',
      what: 'Existing lesson',
      rule: 'Keep it.',
      caughtBy: 'test',
      cost: { retries: 0, minutes: 0, usd: 0 },
      laneModel: null,
      fix: '',
      guard: { kind: 'none', text: '', status: 'proposed' },
      tags: ['existing-tag'],
      source: { kind: 'manual' }
    },
    { dir: 'lessons' }
  );
  const result = await backfill(root, { project: 'swarm', dir: 'lessons', date: '2026-10-01' });
  assert.ok(result.skipped.includes('L-0002'));
  assert.equal(result.written.includes('L-0002'), false);
  assert.equal(result.written.length, 4);
  const { lessons } = await listLessons(root, { dir: 'lessons' });
  assert.equal(lessons.length, 5);
});

test('two entries with one number are both refused and neither is written', async (t) => {
  const root = await makeDocRoot(t, DUP_MD);
  const result = await backfill(root, { project: 'swarm', dir: 'lessons', date: '2026-10-01' });
  assert.deepEqual(result.written, ['L-0002']);
  assert.deepEqual(result.failed, [
    { ref: 'docs/lessons.md#1', reason: 'id-collision' },
    { ref: 'docs/lessons.md#1', reason: 'id-collision' }
  ]);
  assert.equal(result.total, 3);
  const { lessons } = await listLessons(root, { dir: 'lessons' });
  assert.deepEqual(lessons.map((l) => l.id), ['L-0002']);
});

test('a field entry numbered 5000 or more is refused as id-collision', async (t) => {
  const md = [
    '4999. **Small entry.** Rule: Keep small numbers.',
    '',
    '5000. **Large entry.** Rule: Keep large numbers out.',
    ''
  ].join('\n');
  const root = await makeDocRoot(t, md);
  const result = await backfill(root, { project: 'swarm', dir: 'lessons', date: '2026-10-01' });
  assert.deepEqual(result.written, ['L-4999']);
  assert.deepEqual(result.failed, [{ ref: 'docs/lessons.md#5000', reason: 'id-collision' }]);
  assert.equal(result.total, 2);
  const { lessons } = await listLessons(root, { dir: 'lessons' });
  assert.deepEqual(lessons.map((l) => l.id), ['L-4999']);
});

test('dry run counts only entries that a real run would write', async (t) => {
  const root = await makeDocRoot(t, DUP_MD);
  const dry = await backfill(root, { project: 'swarm', dir: 'lessons', dryRun: true, date: '2026-10-01' });
  assert.deepEqual(dry.written, ['L-0002']);
  assert.equal(dry.failed.length, 2);
  const before = await listLessons(root, { dir: 'lessons' });
  assert.equal(before.lessons.length, 0);
  const real = await backfill(root, { project: 'swarm', dir: 'lessons', date: '2026-10-01' });
  assert.deepEqual(real.written, dry.written);
  assert.deepEqual(real.failed, dry.failed);
  assert.equal(real.total, dry.total);
});
