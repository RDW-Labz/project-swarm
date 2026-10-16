import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryFromTicket, selectNotes, renderNotes } from '../tools/lesson-notes.mjs';

const HEADER = 'Watch out for (background from past lessons; it does not change the task, the files or the outputs):';

const lesson = (over = {}) => ({
  id: 'L-0001',
  project: 'swarm',
  date: '2026-10-01',
  stage: 'build',
  what: 'Something went wrong',
  rule: 'Keep changes small',
  caughtBy: 'review',
  tags: [],
  files: [],
  guard: { kind: 'lint', text: '', status: 'proposed' },
  ...over,
});

const base = { text: '', files: [], tags: [], stage: 'deploy' };

test('queryFromTicket builds tags, text, files and stage', () => {
  const q = queryFromTicket(
    {
      id: 'T-1',
      type: 'build',
      title: 'Add lesson notes',
      epic: 'Phase 15',
      risk: 'high',
      sensitive: true,
      acceptance: ['Notes render in the prompt'],
      files: ['tools/lesson-notes.mjs'],
      context: ['docs/plans/phase15.md'],
    },
    ['Show the rules'],
  );
  assert.equal(q.stage, 'build');
  for (const tag of ['build', 'high', 'sensitive', 'lesson', 'notes', 'lesson-notes', 'phase']) {
    assert.ok(q.tags.includes(tag), `missing tag ${tag}`);
  }
  assert.ok(q.text.includes('Show the rules'));
  assert.ok(q.text.includes('Notes render'));
  assert.deepEqual(q.files, ['tools/lesson-notes.mjs', 'docs/plans/phase15.md']);
});

test('queryFromTicket maps stages from ticket type', () => {
  assert.equal(queryFromTicket({ type: 'test' }).stage, 'test');
  assert.equal(queryFromTicket({ type: 'contract' }).stage, 'integration');
  assert.equal(queryFromTicket({ type: 'migration' }).stage, 'integration');
  assert.equal(queryFromTicket({}).stage, 'build');
});

test('tag scoring: one shared tag scores 3', () => {
  const notes = [lesson({ tags: ['timeout'] })];
  const query = { ...base, tags: ['timeout'] };
  assert.equal(selectNotes(query, notes, { minScore: 3 }).length, 1);
  assert.equal(selectNotes(query, notes, { minScore: 4 }).length, 0);
});

test('file scoring: a shared path segment scores 2', () => {
  const notes = [lesson({ files: ['tools/other.mjs'] })];
  const query = { ...base, files: ['tools/lesson-notes.mjs'] };
  assert.equal(selectNotes(query, notes, { minScore: 2 }).length, 1);
  assert.equal(selectNotes(query, notes, { minScore: 3 }).length, 0);
});

test('word scoring: each shared word of 4+ characters scores 1', () => {
  const notes = [lesson({ rule: 'Keep the prompt budget bounded' })];
  const query = { ...base, text: 'prompt budget wording' };
  assert.equal(selectNotes(query, notes, { minScore: 2 }).length, 1);
  assert.equal(selectNotes(query, notes, { minScore: 3 }).length, 0);
});

test('stage match adds 1 point', () => {
  const notes = [lesson({ stage: 'deploy', rule: 'Ship it' })];
  const query = { ...base, stage: 'deploy' };
  assert.equal(selectNotes(query, notes, { minScore: 1 }).length, 1);
  assert.equal(selectNotes(query, notes, { minScore: 2 }).length, 0);
});

test('dropped lessons are skipped even with a strong match', () => {
  const notes = [lesson({ tags: ['timeout'], guard: { kind: 'lint', text: '', status: 'dropped' } })];
  const query = { ...base, tags: ['timeout'] };
  assert.deepEqual(selectNotes(query, notes, { minScore: 1 }), []);
});

test('unknown caughtBy with no shared tag is skipped', () => {
  const notes = [lesson({ caughtBy: 'unknown', tags: ['other-tag'], rule: 'Prompt budget bounded' })];
  const query = { ...base, text: 'prompt budget', tags: ['timeout'] };
  assert.deepEqual(selectNotes(query, notes, { minScore: 1 }), []);
  const known = [lesson({ caughtBy: 'review', tags: ['other-tag'], rule: 'Prompt budget bounded' })];
  assert.equal(selectNotes(query, known, { minScore: 1 }).length, 1);
});

test('ties go to the newest date, then the lower id', () => {
  const notes = [
    lesson({ id: 'L-0002', date: '2026-10-01', tags: ['timeout'] }),
    lesson({ id: 'L-0001', date: '2026-10-01', tags: ['timeout'] }),
    lesson({ id: 'L-0003', date: '2026-10-05', tags: ['timeout'] }),
  ];
  const query = { ...base, tags: ['timeout'] };
  const ids = selectNotes(query, notes).map((n) => n.id);
  assert.deepEqual(ids, ['L-0003', 'L-0001', 'L-0002']);
});

test('limit caps the number of notes', () => {
  const notes = [
    lesson({ id: 'L-0001', date: '2026-10-01', tags: ['timeout'] }),
    lesson({ id: 'L-0002', date: '2026-10-02', tags: ['timeout'] }),
    lesson({ id: 'L-0003', date: '2026-10-03', tags: ['timeout'] }),
    lesson({ id: 'L-0004', date: '2026-10-04', tags: ['timeout'] }),
  ];
  const query = { ...base, tags: ['timeout'] };
  const picked = selectNotes(query, notes, { limit: 2 });
  assert.equal(picked.length, 2);
  assert.equal(picked[0].id, 'L-0004');
});

test('renderNotes returns empty string for no notes', () => {
  assert.equal(renderNotes([]), '');
  assert.equal(renderNotes(undefined), '');
});

test('renderNotes formats header and tagged lines', () => {
  const text = renderNotes([lesson({ rule: 'Keep changes small', tags: ['ci', 'lane-routing'] })]);
  const lines = text.split('\n');
  assert.equal(lines[0], HEADER);
  assert.equal(lines[1], '- Keep changes small [ci, lane-routing]');
});

test('renderNotes drops whole lines from the end to fit the budget', () => {
  const notes = [
    lesson({ id: 'L-0001', rule: 'First rule here', tags: ['alpha-tag'] }),
    lesson({ id: 'L-0002', rule: 'Second rule here', tags: ['beta-tag'] }),
    lesson({ id: 'L-0003', rule: 'Third rule here', tags: ['gamma-tag'] }),
  ];
  const full = renderNotes(notes);
  const two = renderNotes(notes.slice(0, 2));
  assert.ok(full.length > two.length);
  const cut = renderNotes(notes, { maxChars: two.length });
  assert.equal(cut, two);
  assert.ok(!cut.includes('Third'));
  assert.equal(renderNotes(notes, { maxChars: 10 }), '');
});

test('renderNotes cuts each line to 240 characters', () => {
  const text = renderNotes([lesson({ rule: 'x'.repeat(300), tags: ['alpha-tag'] })]);
  const lines = text.split('\n');
  assert.equal(lines[1].length, 240);
});

test('renderNotes strips control, format and emphasis characters from rules', () => {
  const rule = '**Keep** _the_ `prompt`\u0007 ~tight~\u200b budget';
  const text = renderNotes([lesson({ rule, tags: ['alpha-tag'] })]);
  const lines = text.split('\n');
  assert.equal(lines[1], '- Keep the prompt tight budget [alpha-tag]');
  assert.ok(!/[\u0000-\u001f\u200b*_`~]/.test(lines[1]));
});

test('renderNotes skips notes whose rule is empty after cleaning', () => {
  const text = renderNotes([lesson({ rule: '***  \u200b  ***', tags: ['alpha-tag'] })]);
  assert.equal(text, '');
});
