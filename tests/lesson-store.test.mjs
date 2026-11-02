// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeLesson } from '../tools/lesson-schema.mjs';
import {
  listLessons,
  readLessons,
  nextLessonId,
  writeLesson,
  filterLessons,
  lessonStats,
} from '../tools/lesson-store.mjs';

const MAX_BYTES = 64 * 1024;

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lesson-store-'));
}

function sample(overrides = {}) {
  const base = {
    version: 1,
    id: 'L-0001',
    project: 'swarm',
    date: '2026-10-16',
    stage: 'build',
    what: 'Worker followed a symlink into the wrong folder.',
    rule: 'Never follow symlinks when reading lesson files.',
    caughtBy: 'test',
    cost: { retries: 1, minutes: 5, usd: 0.2 },
    laneModel: null,
    fix: '',
    guard: { kind: 'lint', text: '', status: 'proposed' },
    tags: ['symlink', 'path-safety'],
    source: { kind: 'manual' },
  };
  return normalizeLesson({ ...base, ...overrides });
}

test('writeLesson writes a lesson that listLessons reads back', async () => {
  const root = await tempRoot();
  const rel = await writeLesson(root, sample());
  assert.equal(rel, 'lessons/swarm/L-0001.json');
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(invalid, []);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].id, 'L-0001');
});

test('writeLesson refuses to overwrite unless asked', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  await assert.rejects(writeLesson(root, sample()), { code: 'lesson-exists' });
  await writeLesson(root, sample({ what: 'Updated text for the same lesson.' }), { overwrite: true });
  const { lessons } = await listLessons(root);
  assert.equal(lessons[0].what, 'Updated text for the same lesson.');
});

test('writeLesson is atomic: no temp files remain and the file is complete JSON', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  const names = await fs.readdir(path.join(root, 'lessons', 'swarm'));
  assert.deepEqual(names, ['L-0001.json']);
  const text = await fs.readFile(path.join(root, 'lessons', 'swarm', 'L-0001.json'), 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.equal(JSON.parse(text).id, 'L-0001');
});

test('writeLesson rejects an invalid lesson and writes nothing', async () => {
  const root = await tempRoot();
  await assert.rejects(writeLesson(root, sample({ stage: 'nowhere' })), { code: 'lesson-invalid' });
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons, []);
  assert.deepEqual(invalid, []);
});

test('listLessons skips symlinked files and reports them as invalid', async t => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  const folder = path.join(root, 'lessons', 'swarm');
  try {
    await fs.symlink(path.join(folder, 'L-0001.json'), path.join(folder, 'L-0002.json'));
  } catch {
    t.skip('symlinks are not available here');
    return;
  }
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons.map(l => l.id), ['L-0001']);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].file, /L-0002[.]json$/);
  assert.deepEqual(invalid[0].errors, ['symlink']);
});

test('listLessons reports a symlink swapped into the folder even when its target is a valid lesson', async t => {
  const root = await tempRoot();
  await writeLesson(root, sample({ id: 'L-0001' }));
  const outside = await tempRoot();
  const outsideFile = path.join(outside, 'L-0002.json');
  await fs.writeFile(outsideFile, JSON.stringify(sample({ id: 'L-0002' }), null, 2) + '\n');
  try {
    await fs.symlink(outsideFile, path.join(root, 'lessons', 'swarm', 'L-0002.json'));
  } catch {
    t.skip('symlinks are not available here');
    return;
  }
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons.map(l => l.id), ['L-0001']);
  assert.deepEqual(invalid, [{ file: 'lessons/swarm/L-0002.json', errors: ['symlink'] }]);
});

test('listLessons skips a symlinked project folder', async t => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  const outside = await tempRoot();
  try {
    await fs.symlink(outside, path.join(root, 'lessons', 'linked'));
  } catch {
    t.skip('symlinks are not available here');
    return;
  }
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons.map(l => l.id), ['L-0001']);
  assert.deepEqual(invalid, [{ file: 'lessons/linked', errors: ['symlink'] }]);
});

test('listLessons refuses to read files over 64 KB', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  const big = path.join(root, 'lessons', 'swarm', 'L-0009.json');
  await fs.writeFile(big, ' '.repeat(MAX_BYTES + 1));
  const { invalid } = await listLessons(root);
  const hit = invalid.find(i => i.file.endsWith('L-0009.json'));
  assert.ok(hit);
  assert.deepEqual(hit.errors, ['too-large']);
});

test('listLessons still reads a lesson of exactly 64 KB', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  const text = JSON.stringify(sample(), null, 2) + '\n';
  const padded = text + ' '.repeat(MAX_BYTES - Buffer.byteLength(text));
  assert.equal(Buffer.byteLength(padded), MAX_BYTES);
  await fs.writeFile(path.join(root, 'lessons', 'swarm', 'L-0001.json'), padded);
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(invalid, []);
  assert.deepEqual(lessons.map(l => l.id), ['L-0001']);
});

test('listLessons reports a lesson whose id differs from its file name', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample({ id: 'L-0001' }));
  await fs.rename(
    path.join(root, 'lessons', 'swarm', 'L-0001.json'),
    path.join(root, 'lessons', 'swarm', 'L-0002.json'),
  );
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons, []);
  assert.deepEqual(invalid, [{ file: 'lessons/swarm/L-0002.json', errors: ['id-mismatch'] }]);
});

test('listLessons reports a lesson whose project differs from its folder', async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, 'lessons', 'other'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'lessons', 'other', 'L-0001.json'),
    JSON.stringify(sample(), null, 2) + '\n',
  );
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons, []);
  assert.deepEqual(invalid, [{ file: 'lessons/other/L-0001.json', errors: ['project-mismatch'] }]);
});

test('listLessons reports files that are not valid JSON', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample());
  await fs.writeFile(path.join(root, 'lessons', 'swarm', 'L-0003.json'), '{ broken');
  const { lessons, invalid } = await listLessons(root);
  assert.deepEqual(lessons.map(l => l.id), ['L-0001']);
  assert.equal(invalid.length, 1);
  assert.ok(invalid[0].errors.length > 0);
});

test('listLessons returns lessons sorted by id', async () => {
  const root = await tempRoot();
  await writeLesson(root, sample({ id: 'L-0003' }));
  await writeLesson(root, sample({ id: 'L-0001' }));
  await writeLesson(root, sample({ id: 'L-0002' }));
  const { lessons } = await listLessons(root, { project: 'swarm' });
  assert.deepEqual(lessons.map(l => l.id), ['L-0001', 'L-0002', 'L-0003']);
});

test('nextLessonId starts at L-0001 and continues above the highest id', async () => {
  const root = await tempRoot();
  assert.equal(await nextLessonId(root, { project: 'swarm' }), 'L-0001');
  await writeLesson(root, sample({ id: 'L-0001' }));
  await writeLesson(root, sample({ id: 'L-0007' }));
  assert.equal(await nextLessonId(root, { project: 'swarm' }), 'L-0008');
});

test('nextLessonId rejects a bad project name', async () => {
  const root = await tempRoot();
  await assert.rejects(nextLessonId(root, { project: 'Bad Project' }), { code: 'lesson-id' });
});

test('readLessons merges valid lessons from several roots', async () => {
  const a = await tempRoot();
  const b = await tempRoot();
  await writeLesson(a, sample({ id: 'L-0001' }));
  await writeLesson(b, sample({ id: 'L-0002' }));
  const merged = await readLessons([a, b]);
  assert.deepEqual(merged.map(l => l.id).sort(), ['L-0001', 'L-0002']);
});

test('filterLessons filters by stage, tag, caughtBy, project and case-insensitive text', () => {
  const lessons = [
    sample({ id: 'L-0001', stage: 'build', tags: ['symlink', 'path-safety'], caughtBy: 'test', what: 'Symlink escape found.' }),
    sample({ id: 'L-0002', stage: 'review', tags: ['lint-rule'], caughtBy: 'review', rule: 'Check the lint rule before merge.' }),
    sample({ id: 'L-0003', project: 'other', stage: 'build', tags: ['lint-rule'], caughtBy: 'missed', fix: 'Add a lint check.' }),
  ];
  assert.deepEqual(filterLessons(lessons, { stage: 'build' }).map(l => l.id), ['L-0001', 'L-0003']);
  assert.deepEqual(filterLessons(lessons, { tag: 'lint-rule' }).map(l => l.id), ['L-0002', 'L-0003']);
  assert.deepEqual(filterLessons(lessons, { caughtBy: 'review' }).map(l => l.id), ['L-0002']);
  assert.deepEqual(filterLessons(lessons, { project: 'other' }).map(l => l.id), ['L-0003']);
  assert.deepEqual(filterLessons(lessons, { text: 'ESCAPE FOUND' }).map(l => l.id), ['L-0001']);
  assert.deepEqual(filterLessons(lessons, { text: 'lint check' }).map(l => l.id), ['L-0003']);
  assert.equal(filterLessons(lessons, {}).length, 3);
});

test('lessonStats counts stages, caughtBy, missed and tags', () => {
  const lessons = [
    sample({ id: 'L-0001', stage: 'build', caughtBy: 'missed', tags: ['ci', 'lint-rule'] }),
    sample({ id: 'L-0002', stage: 'build', caughtBy: 'production', tags: ['ci'] }),
    sample({ id: 'L-0003', stage: 'review', caughtBy: 'test', tags: ['lane-routing'] }),
  ];
  const stats = lessonStats(lessons);
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byStage, { build: 2, review: 1 });
  assert.deepEqual(stats.byCaughtBy, { missed: 1, production: 1, test: 1 });
  assert.equal(stats.missed, 2);
  assert.deepEqual(stats.byTag, [['ci', 2], ['lane-routing', 1], ['lint-rule', 1]]);
});

test('lessonStats handles an empty list', () => {
  const stats = lessonStats([]);
  assert.deepEqual(stats, { total: 0, byStage: {}, byCaughtBy: {}, byTag: [], missed: 0 });
});
