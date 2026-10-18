// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importLessons, projectNameFor, readProjectLessons } from '../tools/lesson-import.mjs';
import { runLessonsCommand } from '../tools/lessons-commands.mjs';
import { listLessons } from '../tools/lesson-store.mjs';

const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lesson-import-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const row = (id, extra = {}) => ({ id, date: '2026-10-16', area: 'tool', evidence: `evidence number ${id}: the split job produced bad output for ticket ${id}`, rule: `rule number ${id} must be followed by the split step`, fix: 'fix it', public: null, status: 'queued', test: null, version: null, ...extra });
async function other(t, rows, name = 'Parts App') {
  const base = await tmp(t);
  const dir = path.join(base, name);
  await fs.mkdir(path.join(dir, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(dir, 'coordination', 'swarm-lessons.jsonl'), rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return dir;
}

test('imports new rows once; the other project is not changed; a second run skips what exists', async t => {
  const root = await tmp(t);
  const dir = await other(t, [row(1), row(2), row(3)]);
  const before = await fs.readFile(path.join(dir, 'coordination/swarm-lessons.jsonl'), 'utf8');
  const dry = await importLessons(root, dir, { dryRun: true });
  assert.deepEqual(dry.written, ['L-0001', 'L-0002', 'L-0003']);
  assert.equal((await listLessons(root, { project: 'parts-app' })).lessons.length, 0, 'a dry run writes nothing');
  const first = await importLessons(root, dir);
  assert.equal(first.project, 'parts-app');
  assert.deepEqual(first.written, ['L-0001', 'L-0002', 'L-0003']);
  assert.equal(first.failed.length, 0);
  const second = await importLessons(root, dir);
  assert.deepEqual(second.written, []);
  assert.equal(second.skipped.length, 3);
  assert.equal(await fs.readFile(path.join(dir, 'coordination/swarm-lessons.jsonl'), 'utf8'), before, 'read only');
  const { lessons } = await listLessons(root, { project: 'parts-app' });
  assert.equal(lessons[0].project, 'parts-app');
  assert.equal(lessons[0].guard.status, 'proposed');
});

test('a row whose rule already exists under another id is skipped; ids already present are skipped', async t => {
  const root = await tmp(t);
  const dir = await other(t, [row(1)]);
  await importLessons(root, dir);
  const dir2 = await other(t, [row(1), row(7, { rule: 'Rule number 1 must be followed by the split step!' }), row(8)], 'Parts App');
  const r = await importLessons(root, dir2);
  assert.deepEqual(r.written, ['L-0008']);
  assert.deepEqual(r.skipped.sort(), ['L-0001', 'L-0007']);
});

test('bad rows are reported, never written; secrets are redacted or refused', async t => {
  const root = await tmp(t);
  const dir = await other(t, [row(1), 'not json', row(2, { id: 'x' }), row(3), row(3), row(4, { evidence: 'the key was sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in the log and the owner mail was a.b@example.com' })]);
  const r = await importLessons(root, dir);
  const text = JSON.stringify((await listLessons(root, { project: 'parts-app' })).lessons);
  assert.ok(r.failed.some(f => f.reason === 'invalid-json'));
  assert.ok(r.failed.some(f => f.reason === 'id-collision'), 'a repeated id is refused');
  assert.ok(r.failed.length >= 3);
  assert.ok(!text.includes('AAAAAAAAAAAA'), 'the secret is never written (only the public prefix and a <token> marker are)');
  assert.ok(text.includes('<token>'));
  assert.ok(!/a[.]b@/.test(text) && text.includes('<email>'), 'the email is never written');
  assert.ok(r.written.includes('L-0001'));
});

test('refuses: a symlinked lessons file, a huge file, a missing file, the name swarm, a bad name', async t => {
  const root = await tmp(t);
  const dir = await other(t, [row(1)]);
  const file = path.join(dir, 'coordination/swarm-lessons.jsonl');
  await fs.rename(file, `${file}.real`);
  await fs.symlink(`${file}.real`, file);
  await assert.rejects(() => importLessons(root, dir), /import-path/);
  await fs.rm(file);
  await assert.rejects(() => importLessons(root, dir), /import-missing/);
  await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(() => readProjectLessons(dir), /import-too-large/);
  await assert.rejects(() => importLessons(root, path.join(dir, 'nope')), /import-path/);
  await fs.writeFile(file, JSON.stringify(row(1)) + '\n');
  await assert.rejects(() => importLessons(root, dir, { project: 'swarm' }), /import-project/);
  await assert.rejects(() => importLessons(root, dir, { project: 'Bad Name' }), /import-project/);
  assert.equal(projectNameFor('/x/Parts Request App!'), 'parts-request-app');
});

test('stage and tags come from the text for area tool', async t => {
  const root = await tmp(t);
  const dir = await other(t, [row(1, { evidence: 'scope check listed a service the scope never names', rule: 'the scope check must skip out-of-scope text' })]);
  await importLessons(root, dir);
  const lesson = (await listLessons(root, { project: 'parts-app' })).lessons[0];
  assert.equal(lesson.stage, 'scope');
  assert.ok(lesson.tags.includes('scope'));
});

test('swarm lessons import: usage, dry run, a write, a failure exit code', async t => {
  const root = await tmp(t);
  const dir = await other(t, [row(1), 'broken']);
  assert.equal((await runLessonsCommand(root, 'lessons', ['import'], {})).exitCode, 1);
  const dry = await runLessonsCommand(root, 'lessons', ['import', dir, '--dry-run'], {});
  assert.match(dry.stdout, /would write 1 \(L-0001\)/);
  const real = await runLessonsCommand(root, 'lessons', ['import', dir, '--project', 'parts-request-app'], {});
  assert.match(real.stdout, /parts-request-app: wrote 1/);
  assert.equal(real.exitCode, 1, 'a row that failed makes the exit code 1');
  assert.match(real.stdout, /failed coordination\/swarm-lessons\.jsonl:2: invalid-json/);
  assert.equal((await listLessons(root, { project: 'parts-request-app' })).lessons.length, 1);
});

test('review findings: symlinked folder, fifo, hostile date, split secret, id conflict, odd ids, proto keys, non-Latin rules, bare --project', async t => {
  const root = await tmp(t);
  // a symlinked coordination folder
  const base = await tmp(t);
  const real = path.join(base, 'real');
  await fs.mkdir(real, { recursive: true });
  await fs.writeFile(path.join(real, 'swarm-lessons.jsonl'), JSON.stringify(row(1)) + '\n');
  const linked = path.join(base, 'Linked');
  await fs.mkdir(linked);
  await fs.symlink(real, path.join(linked, 'coordination'));
  await assert.rejects(() => readProjectLessons(linked), /import-path/);
  // a fifo is not a regular file (and the open does not hang)
  const fifoDir = await other(t, [row(1)], 'Fifo');
  const fifo = path.join(fifoDir, 'coordination/swarm-lessons.jsonl');
  await fs.rm(fifo);
  const made = spawnSync('mkfifo', [fifo]);
  if (made.status === 0) await assert.rejects(() => readProjectLessons(fifoDir), /import-path/);
  // hostile rows fail alone
  const longEvidence = `${'x'.repeat(590)} key sk-ant-api03-Zq8Lm2Xv9RtY4pWb7NcJd3HgKe6FsUa1VoTi5MnBx0QyLrCw8DzEhPjSfGkAtUv-xy and more`;
  const dir = await other(t, [
    row(1, { date: '9999-99-99' }), row(2, { id: '0x7' }), row(3, { id: 1e1 + 0.5 }), row(4, { id: true }), row(5, { id: [3] }),
    row(6, { area: '__proto__', status: 'constructor' }), row(7, { evidence: longEvidence }),
    row(8, { rule: 'Правило номер восемь должно выполняться шагом split' }), row(9, { rule: 'Правило номер девять должно выполняться шагом split' }),
    row('12'),
  ]);
  const r = await importLessons(root, dir);
  const all = JSON.stringify((await listLessons(root, { project: 'parts-app' })).lessons);
  assert.ok(!all.includes('Zq8Lm2Xv9RtY'), 'a secret at the cut is never written, whole or in part');
  assert.ok(!r.written.includes('L-0001'), 'a hostile date fails that row only');
  for (const id of ['L-0007', 'L-0010', 'L-0012']) assert.ok(r.written.includes(id) || r.failed.length, id);
  assert.ok(r.written.includes('L-0006'), 'proto-named area and status do not break the row');
  assert.ok(r.written.includes('L-0008') && r.written.includes('L-0009'), 'two different non-Latin rules are not the same rule');
  assert.ok(r.written.includes('L-0012'), 'a short digit string is a valid id');
  assert.equal(r.written.filter(id => ['L-0002', 'L-0003', 'L-0004', 'L-0005'].includes(id)).length, 0, 'odd ids are refused');
  // an existing id with another rule is a conflict
  const dir2 = await other(t, [row(6, { rule: 'a completely different rule for six' })]);
  const conflict = await importLessons(root, dir2);
  assert.ok(conflict.failed.some(f => f.reason === 'id-conflict'));
  // a duplicate rule names the lesson it duplicates
  const dir3 = await other(t, [row(30, { rule: 'rule number 6 must be followed by the split step' })]);
  const dup = await importLessons(root, dir3);
  assert.deepEqual(dup.duplicates, [{ id: 'L-0030', of: 'L-0006' }]);
  await assert.rejects(() => importLessons(root, dir, { project: true }), /import-project/);
});
