// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFieldData, writeFieldExport } from '../tools/field-export.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-export-'));
  const lessonDir = path.join(root, 'lessons', 'abcdef12');
  await fs.mkdir(lessonDir, { recursive: true });
  await fs.writeFile(path.join(lessonDir, 'L-0001.json'), JSON.stringify({
    id: 'L-0001', project: 'abcdef12', what: 'A field observation',
    rule: 'Keep the useful rule text private', fix: 'Use metadata only',
    stage: 'built', caughtBy: 'test', area: 'tool', status: 'shipped',
    version: '1.0.0', createdAt: '2026-10-21T12:00:00.000Z', tags: ['field', 'safe'],
  }));
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'run-1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'run-1', 'state.json'), JSON.stringify({
    lane: 'fast', jobs: [
      { status: 'passed', durationMinutes: 2 },
      { status: 'failed', durationMinutes: 4 },
    ],
  }));
  return root;
}

test('exports metadata only and aggregates run outcomes', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  assert.match(data.projectId, /^[a-f0-9]{64}$/);
  assert.notEqual(data.projectId, 'sample-project');
  assert.deepEqual(data.lessons, [{
    id: 'L-0001', area: 'tool', status: 'shipped', version: '1.0.0',
    createdAt: '2026-10-21T12:00:00.000Z', ruleLength: 33, tags: ['field', 'safe'],
  }]);
  assert.deepEqual(data.runs, [{ lane: 'fast', jobs: 2, pass: 1, fail: 1, medianMinutes: 3 }]);
  assert.equal(JSON.stringify(data).includes('Keep the useful rule text private'), false);
  assert.equal(JSON.stringify(data).includes(root), false);
});

test('refuses PII and runtime-built secret material in source lessons', async () => {
  const root = await fixture();
  const lessonFile = path.join(root, 'lessons', 'abcdef12', 'L-0001.json');
  const lesson = JSON.parse(await fs.readFile(lessonFile, 'utf8'));
  lesson.rule = `Contact field@example.test; ${['sk', '-'].join('')}${'a'.repeat(32)}`;
  await fs.writeFile(lessonFile, JSON.stringify(lesson));
  await assert.rejects(
    exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' }),
    error => error.code === 'field-export-unsafe' && error.findings.includes('email') && error.findings.includes('secret')
      && !error.message.includes('field@example.test'),
  );
});

test('writes exports with mode 600', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const file = await writeFieldExport(root, data);
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(path.basename(file), `2026-10-21-${data.projectId}.json`);
});

test('refuses exports when secret scanning skips content', async () => {
  const root = await fixture();
  const lessonFile = path.join(root, 'lessons', 'abcdef12', 'L-0001.json');
  const lesson = JSON.parse(await fs.readFile(lessonFile, 'utf8'));
  lesson.what = 'x'.repeat(1_000_001);
  await fs.writeFile(lessonFile, JSON.stringify(lesson));
  await assert.rejects(
    exportFieldData(root, {
      now: new Date('2026-10-21T15:30:00.000Z'),
      projectId: 'abcdef12',
      scan: () => ({ findings: [], skipped: [{ path: 'field-export.json', reason: 'too large to scan' }] }),
    }),
    error => error.code === 'field-export-unsafe' && error.reason === 'scan-skipped',
  );
});

test('refuses project path traversal', async () => {
  const root = await fixture();
  await assert.rejects(
    exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: '../x' }),
    error => error.code === 'field-export-bad-project',
  );
});

test('refuses serialized exports over the size cap before scanning', async () => {
  const root = await fixture();
  const lessonFile = path.join(root, 'lessons', 'abcdef12', 'L-0001.json');
  const lesson = JSON.parse(await fs.readFile(lessonFile, 'utf8'));
  lesson.version = 'v'.repeat(512 * 1024);
  await fs.writeFile(lessonFile, JSON.stringify(lesson));
  await assert.rejects(
    exportFieldData(root, {
      now: new Date('2026-10-21T15:30:00.000Z'),
      projectId: 'abcdef12',
      scan: () => { throw new Error('scanner should not run'); },
    }),
    error => error.code === 'field-export-unsafe' && error.reason === 'export-too-large',
  );
});

test('sanitizes lesson identifiers, categories, lanes, and tags', async () => {
  const root = await fixture();
  const lessonFile = path.join(root, 'lessons', 'abcdef12', 'L-0001.json');
  const lesson = JSON.parse(await fs.readFile(lessonFile, 'utf8'));
  lesson.id = 'not safe/lesson';
  lesson.area = 'Not Safe';
  lesson.tags = ['safe-tag', 'Not Safe', 'also-safe', { value: 'object' }, 'third-safe'];
  await fs.writeFile(lessonFile, JSON.stringify(lesson));
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'run-1', 'state.json'), JSON.stringify({ lane: 'Not Safe', jobs: [] }));
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  assert.match(data.lessons[0].id, /^[a-f0-9]{12}$/);
  assert.equal(data.lessons[0].area, 'other');
  assert.deepEqual(data.lessons[0].tags, ['safe-tag', 'also-safe', 'third-safe']);
  assert.equal(data.runs[0].lane, 'other');
});
