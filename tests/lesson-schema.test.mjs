import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLesson, findUnsafeText, redactText, lessonPath, normalizeLesson } from '../tools/lesson-schema.mjs';

const base = () => ({
  version: 1,
  id: 'L-0001',
  project: 'swarm',
  date: '2026-10-16',
  stage: 'build',
  what: 'Shipped a helper without a test.',
  rule: 'Write a failing test before the fix.',
  caughtBy: 'review',
  cost: { retries: 1, minutes: 5, usd: 0.2 },
  laneModel: 'sonnet',
  fix: 'Added the test.',
  guard: { kind: 'test-template', text: '', status: 'proposed' },
  tags: ['testing', 'ci'],
  source: { kind: 'manual' }
});

const kindsOf = (t) => findUnsafeText(t).map((f) => f.kind);
const SECRET = ['sk', 'ant', 'AbCd1234EfGh5678IjKl9012MnOp3456QrSt'].join('-');
const EMAIL = ['dev', 'example.com'].join('@');
const HOME = ['/Users', 'alice', 'src'].join('/');
const URL_PW = ['https://bot', 'changeme@git.example.com/repo'].join(':');
const IP = ['8', '8', '8', '8'].join('.');
const RUN = ['1765432109876', 'abcdef12'].join('-');
const TOKEN = 'a1B2'.repeat(10);

test('a valid lesson passes', () => {
  const r = validateLesson(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('an unknown key fails', () => {
  assert.equal(validateLesson({ ...base(), extra: 1 }).ok, false);
});

test('a bad stage fails', () => {
  assert.equal(validateLesson({ ...base(), stage: 'ship' }).ok, false);
});

test('a bad id fails', () => {
  assert.equal(validateLesson({ ...base(), id: 'L-1' }).ok, false);
});

test('long text fails', () => {
  assert.equal(validateLesson({ ...base(), what: 'x'.repeat(601) }).ok, false);
});

test('a bad tag fails', () => {
  assert.equal(validateLesson({ ...base(), tags: ['Bad_Tag'] }).ok, false);
});

test('every unsafe kind is found', () => {
  assert.ok(kindsOf(`mail ${EMAIL}`).includes('email'));
  assert.ok(kindsOf(`see ${HOME}`).includes('home'));
  assert.ok(kindsOf(`at ${URL_PW}`).includes('url'));
  assert.ok(kindsOf(`host ${IP}`).includes('ip'));
  assert.ok(kindsOf(`run ${RUN}`).includes('run-id'));
  assert.ok(kindsOf(`tok ${TOKEN}`).includes('token'));
  assert.ok(kindsOf(`key ${SECRET}`).includes('secret'));
});

test('clean text and loopback addresses have no findings', () => {
  assert.deepEqual(findUnsafeText('Plain text with 127.0.0.1 only.'), []);
  assert.deepEqual(findUnsafeText('Bind to 0.0.0.0'), []);
});

test('redactText replaces the non-secret kinds', () => {
  assert.equal(redactText(`mail ${EMAIL}`), 'mail <email>');
  assert.equal(redactText(`see ${HOME}`), 'see <home>/src');
  assert.equal(redactText(`at ${URL_PW}`), 'at <token>git.example.com/repo');
  assert.equal(redactText(`host ${IP} up`), 'host <ip> up');
  assert.equal(redactText(`run ${RUN}`), 'run <run-id>');
  assert.equal(redactText(`tok ${TOKEN}`), 'tok <token>');
});

test('redactText never redacts a secret', () => {
  assert.equal(redactText(`key ${SECRET}`), `key ${SECRET}`);
});

test('validateLesson names the field and kind but not the matched text', () => {
  const r = validateLesson({ ...base(), fix: `Ask ${EMAIL} first` });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('fix') && e.includes('email')));
  assert.ok(!r.errors.some((e) => e.includes(EMAIL)));
});

test('lessonPath builds the path and rejects bad project or id', () => {
  assert.equal(lessonPath('swarm', 'L-0001'), 'lessons/swarm/L-0001.json');
  assert.throws(() => lessonPath('Bad/../x', 'L-0001'), { code: 'lesson-id' });
  assert.throws(() => lessonPath('swarm', 'X-1'), { code: 'lesson-id' });
});

test('normalizeLesson applies defaults, trims, dedupes and orders keys', () => {
  const out = normalizeLesson({
    id: ' L-0002 ',
    project: 'swarm',
    date: '2026-10-16',
    stage: 'test',
    what: '  Missed a flaky check.  ',
    rule: 'Rerun the check twice.',
    caughtBy: 'test',
    tags: ['b-tag', 'a-tag', 'b-tag'],
    source: { kind: 'manual' }
  });
  assert.deepEqual(Object.keys(out), ['version', 'id', 'project', 'date', 'stage', 'what', 'rule', 'caughtBy', 'cost', 'laneModel', 'fix', 'guard', 'tags', 'source']);
  assert.equal(out.id, 'L-0002');
  assert.equal(out.what, 'Missed a flaky check.');
  assert.deepEqual(out.tags, ['a-tag', 'b-tag']);
  assert.deepEqual(out.cost, { retries: 0, minutes: 0, usd: 0 });
  assert.equal(out.laneModel, null);
  assert.equal(out.fix, '');
  assert.deepEqual(out.guard, { kind: 'none', text: '', status: 'proposed' });
  assert.deepEqual(out.source, { kind: 'manual' });
  assert.equal(out.version, 1);
});

test('ticket and requirement are optional and length checked', () => {
  assert.equal(validateLesson({ ...base(), ticket: 'T-0001', requirement: 'R-001' }).ok, true);
  assert.equal(validateLesson({ ...base(), ticket: 'T'.repeat(41) }).ok, false);
  assert.equal(validateLesson({ ...base(), requirement: '' }).ok, false);
});

test('ticket and requirement are scanned for unsafe text', () => {
  const r = validateLesson({ ...base(), ticket: EMAIL });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ticket') && e.includes('email')));
  assert.ok(!r.errors.some((e) => e.includes(EMAIL)));
  const q = validateLesson({ ...base(), requirement: HOME });
  assert.equal(q.ok, false);
  assert.ok(q.errors.some((e) => e.includes('requirement') && e.includes('home')));
});

test('project, id and date values with unsafe text fail without echoing it', () => {
  const cases = [
    { ...base(), project: HOME },
    { ...base(), id: `L-${RUN}` },
    { ...base(), date: EMAIL }
  ];
  for (const lesson of cases) {
    const r = validateLesson(lesson);
    assert.equal(r.ok, false);
    assert.ok(!r.errors.some((e) => e.includes(HOME) || e.includes(RUN) || e.includes(EMAIL)));
  }
});

test('guard.ref of 120 characters passes and 121 fails', () => {
  const ok = { ...base(), guard: { kind: 'lint', text: '', status: 'proposed', ref: 'r'.repeat(120) } };
  const bad = { ...base(), guard: { kind: 'lint', text: '', status: 'proposed', ref: 'r'.repeat(121) } };
  assert.equal(validateLesson(ok).ok, true);
  assert.equal(validateLesson(bad).ok, false);
});

test('guard.ref is scanned for unsafe text', () => {
  const r = validateLesson({ ...base(), guard: { kind: 'lint', text: '', status: 'proposed', ref: EMAIL } });
  assert.equal(r.ok, false);
  assert.ok(!r.errors.some((e) => e.includes(EMAIL)));
});

test('an email with a zero-width character inside is found', () => {
  const zw = ['dev\u200b', 'example.com'].join('@');
  assert.ok(kindsOf(`mail ${zw}`).includes('email'));
});

test('an email with a fullwidth at sign is found', () => {
  const fw = ['dev', 'example.com'].join('\uFF20');
  assert.ok(kindsOf(`mail ${fw}`).includes('email'));
});

test('an upper-case home path is found', () => {
  const up = ['/USERS', 'alice', 'src'].join('/');
  assert.ok(kindsOf(`see ${up}`).includes('home'));
});

test('a C: slash home path is found', () => {
  const win = ['C:', 'Users', 'alice', 'src'].join('/');
  assert.ok(kindsOf(`see ${win}`).includes('home'));
});

test('an upper-case run id with a letter prefix is found', () => {
  const run = ['R' + '1765432109876', 'ABCDEF12'].join('-');
  assert.ok(kindsOf(`run ${run}`).includes('run-id'));
});

test('a hex run after an underscore is found as a token', () => {
  const hex = ['build', 'f00d'.repeat(8)].join('_');
  assert.ok(kindsOf(hex).includes('token'));
});

test('a token split by a space across two words is found', () => {
  const split = ['f00d'.repeat(4), 'f00d'.repeat(4)].join(' ');
  assert.ok(kindsOf(split).includes('token'));
});

test('error messages never contain unsafe text or unknown key names', () => {
  const unknownKey = ['secret', 'Note'].join('');
  const r = validateLesson({ ...base(), [unknownKey]: 1, fix: `Ask ${EMAIL} first` });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  for (const e of r.errors) {
    assert.ok(!e.includes(EMAIL));
    assert.ok(!e.includes(unknownKey));
  }
});
