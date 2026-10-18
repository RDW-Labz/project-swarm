import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceLines,
  testTitles,
  coverage,
  evaluate,
  reviewManifest,
  parseAcceptanceVerdicts,
  validRecord,
} from '../tools/acceptance.mjs';

const NL = String.fromCharCode(10);
const FILE = 'tests/a.test.mjs';

function ticketWith(acceptance, tests = [FILE]) {
  return { id: 'T-0001', title: 'Ticket', acceptance, files: ['src/a.js'], tests, context: [] };
}

function sourceOf(text) {
  return new Map([[FILE, text]]);
}

describe('acceptanceLines', () => {
  test('numbers lines in array order and blank strings still consume a number', () => {
    const lines = acceptanceLines(ticketWith(['first line', '', 'third line']));
    assert.deepEqual(lines, [
      { n: 1, id: 'AC1', line: 'first line' },
      { n: 3, id: 'AC3', line: 'third line' },
    ]);
  });
});

describe('testTitles', () => {
  test('finds js titles with modifiers and ignores comments', () => {
    const src = [
      "test('AC1 one', () => {});",
      "it.concurrent('AC2 two', () => {});",
      "// test('AC7 seven', () => {});",
      "/* it('AC8 eight', () => {}); */",
      "test('AC3 http://example.test/x', () => {});",
    ].join(NL);
    assert.deepEqual(testTitles(src, 'x.test.js'), ['AC1 one', 'AC2 two', 'AC3 http://example.test/x']);
  });

  test('a file that can switch tests off counts no titles at all', () => {
    for (const marker of ["describe.skip('x', () => { it('AC1 a', () => {}); });", "test('AC1 a', { skip: true }, () => {});", "test('AC1 a', { todo: 'later' }, () => {});", "it.only('AC2 two', () => {});", "test.skipIf(true)('AC1 a', () => {});"]) {
      assert.deepEqual(testTitles(["test('AC1 one', () => {});", marker].join(NL), 'x.test.js'), [], marker);
    }
    assert.deepEqual(testTitles('@pytest.mark.skip' + NL + 'def test_ac1(): pass', 't.py'), []);
    assert.deepEqual(testTitles('func TestAC1(t *testing.T) { t.Skip(\"later\") }', 'a_test.go'), []);
  });

  test('a skipped or todo test on its own is left out, the others in the file still count', () => {
    const src = ["test('AC1 one', () => {});", "test.skip('AC4 four', () => {});", "xit('AC5 five', () => {});", "test.todo('AC6 six');"].join(NL);
    assert.deepEqual(testTitles(src, 'x.test.js'), ['AC1 one']);
  });

  test('a declaration inside a string, a one-line quote and a comment marker inside a title', () => {
    assert.deepEqual(testTitles('const s = "test(' + "'AC1 fake'" + ')";', 'x.test.js'), []);
    assert.deepEqual(testTitles("test('AC1 a // b', () => {});", 'x.test.js'), ['AC1 a // b']);
    assert.deepEqual(testTitles("describe('x', () => { it('AC2 inner', () => {}); });", 'x.test.js'), ['x', 'AC2 inner']);
  });

  test('a huge file with many block comments does not hang and the number of titles is capped', () => {
    const many = '/**/'.repeat(250000) + NL + "test('AC1 one', () => {});";
    const started = Date.now();
    assert.deepEqual(testTitles(many, 'x.test.js'), ['AC1 one']);
    assert.ok(Date.now() - started < 2000);
    const titles = testTitles(Array.from({ length: 1000 }, (_, i) => "test('t" + i + "', () => {});").join(NL), 'x.test.js');
    assert.equal(titles.length, 400);
  });

  test('finds python test titles', () => {
    const src = 'def test_AC9_login(self):' + NL + '    pass';
    assert.deepEqual(testTitles(src, 't.py'), ['test_AC9_login']);
  });

  test('finds go test titles', () => {
    const src = 'func TestCheck_AC10(t *testing.T) {' + NL + '}';
    assert.deepEqual(testTitles(src, 'x_test.go'), ['TestCheck_AC10']);
  });
});

describe('coverage', () => {
  const ticket = ticketWith(Array.from({ length: 12 }, (_, i) => 'line text ' + (i + 1)));

  test('matches tags exactly and ignores skipped tests and comments', () => {
    const src = [
      "test('AC12 only', () => {});",
      "test('BAC1 nope', () => {});",
      "test('ac-2 yes', () => {});",
      "test('AC_3 yes', () => {});",
      "test('[AC 4] yes', () => {});",
      "test('TRAC5 nope', () => {});",
      "test.skip('AC6 skipped', () => {});",
      "// test('AC7 comment', () => {});",
      "test('AC 8 spaced', () => {});",
      "test('AC9x fine', () => {});",
    ].join(NL);
    const cov = coverage(ticket, sourceOf(src));
    assert.deepEqual(cov.covered, [2, 3, 4, 8, 9, 12]);
    assert.deepEqual(cov.uncovered, [1, 5, 6, 7, 10, 11]);
  });

  test('reports the first match as by', () => {
    const cov = coverage(ticket, sourceOf("test('ac-2 yes', () => {});"));
    const line = cov.lines.find((l) => l.n === 2);
    assert.equal(line.covered, true);
    assert.deepEqual(line.by, { file: FILE, title: 'ac-2 yes' });
  });

  test('covers nothing when the ticket has no tests', () => {
    const cov = coverage(ticketWith(['line one'], []), sourceOf("test('AC1 x', () => {});"));
    assert.deepEqual(cov.covered, []);
    assert.deepEqual(cov.uncovered, [1]);
  });

  test('a line shorter than 3 characters is never covered', () => {
    const cov = coverage(ticketWith(['ok']), sourceOf("test('AC1 ok', () => {});"));
    assert.deepEqual(cov.uncovered, [1]);
  });
});

describe('evaluate', () => {
  const t = ticketWith(['first line here', 'second line here']);
  const cov = coverage(t, sourceOf("test('AC1 first', () => {});"));
  const rec = {
    filesHash: 'h1',
    lines: [{ n: 2, verdict: 'pass', evidence: 'ok' }],
    run: 'r1',
    at: '2024-01-01T00:00:00Z',
  };

  test('met when the test passes and the review passes', () => {
    const r = evaluate({ ticket: t, cov, record: rec, filesHash: 'h1', testsPassed: true });
    assert.equal(r.state, 'met');
    assert.equal(r.lines[0].by, 'test');
    assert.equal(r.lines[0].verdict, 'pass');
    assert.equal(r.lines[0].evidence, FILE + ': AC1 first');
    assert.equal(r.lines[1].by, 'review');
    assert.equal(r.lines[1].verdict, 'pass');
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.failing, []);
  });

  test('pending when the covering test was not seen passing', () => {
    const r = evaluate({ ticket: t, cov, record: rec, filesHash: 'h1', testsPassed: false });
    assert.equal(r.lines[0].verdict, 'pending');
    assert.equal(r.state, 'review');
    assert.deepEqual(r.missing, [1]);
  });

  test('review when an uncovered line has no record', () => {
    const r = evaluate({ ticket: t, cov, record: undefined, filesHash: 'h1', testsPassed: true });
    assert.equal(r.lines[1].verdict, 'missing');
    assert.equal(r.state, 'review');
    assert.deepEqual(r.missing, [2]);
  });

  test('a record with a stale filesHash is ignored', () => {
    const stale = { ...rec, filesHash: 'other' };
    const r = evaluate({ ticket: t, cov, record: stale, filesHash: 'h1', testsPassed: true });
    assert.deepEqual(r.missing, [2]);
  });

  test('failed when a review line fails', () => {
    const failing = { ...rec, lines: [{ n: 2, verdict: 'fail', evidence: 'no' }] };
    const r = evaluate({ ticket: t, cov, record: failing, filesHash: 'h1', testsPassed: true });
    assert.equal(r.state, 'failed');
    assert.deepEqual(r.failing, [2]);
  });

  test('an unknown verdict counts as missing', () => {
    const odd = { ...rec, lines: [{ n: 2, verdict: 'maybe', evidence: '' }] };
    const r = evaluate({ ticket: t, cov, record: odd, filesHash: 'h1', testsPassed: true });
    assert.deepEqual(r.missing, [2]);
    assert.equal(r.state, 'review');
  });

  test('accepted turns missing lines into met', () => {
    const r = evaluate({ ticket: t, cov, record: undefined, filesHash: 'h1', testsPassed: true, accepted: true });
    assert.equal(r.state, 'met');
  });

  test('accepted does not hide a failing line', () => {
    const failing = { ...rec, lines: [{ n: 2, verdict: 'fail', evidence: 'no' }] };
    const r = evaluate({ ticket: t, cov, record: failing, filesHash: 'h1', testsPassed: true, accepted: true });
    assert.equal(r.state, 'failed');
  });

  test('a ticket with no acceptance lines is met', () => {
    const empty = ticketWith([]);
    const r = evaluate({ ticket: empty, cov: coverage(empty, new Map()), record: undefined, filesHash: 'h1', testsPassed: false });
    assert.equal(r.state, 'met');
  });
});

describe('validRecord', () => {
  const rec = { filesHash: 'h1', lines: [], run: 'r1', at: '2024-01-01T00:00:00Z' };

  test('accepts a well formed record with the same hash', () => {
    assert.equal(validRecord(rec, 'h1'), true);
  });

  test('rejects a different hash, bad lines, bad date, or no record', () => {
    assert.equal(validRecord(rec, 'h2'), false);
    assert.equal(validRecord({ ...rec, lines: {} }, 'h1'), false);
    assert.equal(validRecord({ ...rec, at: 'soon' }, 'h1'), false);
    assert.equal(validRecord(undefined, 'h1'), false);
  });
});

describe('reviewManifest', () => {
  const big = {
    id: 'T-0002',
    title: 'Thin page',
    acceptance: ['thin page under 8 KB'],
    files: ['src/a.js', '.env.local', '../secret.txt', 'src/a.js'],
    tests: ['tests/a.test.mjs'],
    context: ['docs/plan.md'],
  };

  test('returns one read-only review job with the expected fields', () => {
    const m = reviewManifest('r1', [{ ticket: big, uncovered: [1] }]);
    assert.equal(m.version, 1);
    assert.equal(m.jobs.length, 1);
    const job = m.jobs[0];
    assert.equal(job.id, 'acc-review-r1');
    assert.equal(job.type, 'review');
    assert.equal(job.agent, 'claude');
    assert.equal(job.model, 'sonnet');
    assert.equal(job.tier, 'mid');
    assert.deepEqual(job.outputs, []);
    assert.equal(job.timeoutMs, 900000);
  });

  test('context is the unique union with env and parent paths dropped', () => {
    const job = reviewManifest('r1', [{ ticket: big, uncovered: [1] }]).jobs[0];
    assert.deepEqual(job.context, ['src/a.js', 'tests/a.test.mjs', 'docs/plan.md']);
  });

  test('context is capped at 60 entries', () => {
    const many = { ...big, files: Array.from({ length: 70 }, (_, i) => 'src/f' + i + '.js') };
    const job = reviewManifest('r1', [{ ticket: many, uncovered: [1] }]).jobs[0];
    assert.equal(job.context.length, 60);
  });

  test('job id is capped at 60 characters', () => {
    const job = reviewManifest('x'.repeat(100), [{ ticket: big, uncovered: [1] }]).jobs[0];
    assert.equal(job.id.length, 60);
  });

  test('prompt carries ticket data as JSON strings', () => {
    const quoted = { ...big, title: 'A "quoted" title' };
    const prompt = String(reviewManifest('r1', [{ ticket: quoted, uncovered: [1] }]).jobs[0].prompt);
    assert.ok(prompt.includes('T-0002'));
    assert.ok(prompt.includes(JSON.stringify(quoted.title)));
    assert.ok(prompt.includes('thin page under 8 KB'));
  });
});

describe('parseAcceptanceVerdicts', () => {
  const good = (lines) => JSON.stringify({ acceptance: [{ ticket: 'T-0001', lines }] });

  test('parses the last line into entries', () => {
    const text = ['log line', good([{ n: 1, verdict: 'pass', evidence: 'ok' }])].join(NL);
    assert.deepEqual(parseAcceptanceVerdicts(text), [
      { ticket: 'T-0001', lines: [{ n: 1, verdict: 'pass', evidence: 'ok' }] },
    ]);
  });

  test('only the last non-empty line counts', () => {
    assert.equal(parseAcceptanceVerdicts(good([{ n: 1, verdict: 'pass' }]) + NL + 'trailing text'), null);
    assert.equal(parseAcceptanceVerdicts([good([{ n: 1, verdict: 'pass' }]), 'not json'].join(NL)), null);
  });

  test('drops verdicts other than pass or fail', () => {
    const text = good([
      { n: 1, verdict: 'maybe', evidence: 'x' },
      { n: 2, verdict: 'fail', evidence: 'bad' },
    ]);
    assert.deepEqual(parseAcceptanceVerdicts(text)[0].lines, [{ n: 2, verdict: 'fail', evidence: 'bad' }]);
  });

  test('drops line numbers outside 1..200 or not integers', () => {
    const text = good([
      { n: 0, verdict: 'pass' },
      { n: 201, verdict: 'pass' },
      { n: '3', verdict: 'pass' },
      { n: 1.5, verdict: 'pass' },
      { n: 200, verdict: 'pass', evidence: 'ok' },
    ]);
    assert.deepEqual(parseAcceptanceVerdicts(text)[0].lines, [{ n: 200, verdict: 'pass', evidence: 'ok' }]);
  });

  test('drops tickets that do not match the id pattern', () => {
    const text = JSON.stringify({ acceptance: [{ ticket: 'T-1', lines: [{ n: 1, verdict: 'pass' }] }] });
    assert.equal(parseAcceptanceVerdicts(text), null);
  });

  test('cuts evidence to 300 characters and defaults it to empty', () => {
    const text = good([{ n: 1, verdict: 'pass', evidence: 'x'.repeat(400) }, { n: 2, verdict: 'pass' }]);
    const lines = parseAcceptanceVerdicts(text)[0].lines;
    assert.equal(lines[0].evidence.length, 300);
    assert.equal(lines[1].evidence, '');
  });

  test('keeps a pass with empty evidence', () => {
    const text = good([{ n: 1, verdict: 'pass', evidence: '' }]);
    assert.deepEqual(parseAcceptanceVerdicts(text)[0].lines, [{ n: 1, verdict: 'pass', evidence: '' }]);
  });

  test('returns null for empty text, non-json, missing array, or no valid line', () => {
    assert.equal(parseAcceptanceVerdicts(''), null);
    assert.equal(parseAcceptanceVerdicts('just words'), null);
    assert.equal(parseAcceptanceVerdicts(JSON.stringify({ other: 1 })), null);
    assert.equal(parseAcceptanceVerdicts(good([{ n: 0, verdict: 'pass' }])), null);
  });
});

describe('review findings', () => {
  test('a title with two different tags covers nothing; Go CamelCase names match', () => {
    const ticket = { acceptance: ['first line one', 'second line two', 'third line three'], tests: ['a.test.ts', 'b_test.go'] };
    const cov = coverage(ticket, new Map([['a.test.ts', "test('AC1 AC2 everything', () => {});" + NL + "test('AC3 only this', () => {});"], ['b_test.go', 'func TestAC2Rejects(t *testing.T) {}']]));
    assert.deepEqual(cov.covered, [2, 3]);
    assert.equal(cov.lines[1].by.title, 'TestAC2Rejects');
  });

  test('the production module has no test code and no test imports', async () => {
    const fs = await import('node:fs/promises');
    const text = await fs.readFile(new URL('../tools/acceptance.mjs', import.meta.url), 'utf8');
    assert.ok(!/node:test|node:assert|process[.]argv/.test(text));
  });

  test('records can be written and read back; a bad file reads as empty', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readAcceptanceRecords, writeAcceptanceRecords } = await import('../tools/acceptance.mjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acc-rec-'));
    assert.deepEqual(await readAcceptanceRecords(root), { tickets: {} });
    await writeAcceptanceRecords(root, { tickets: { 'T-0001': { filesHash: 'h', lines: [], at: new Date().toISOString() } } });
    assert.equal((await readAcceptanceRecords(root)).tickets['T-0001'].filesHash, 'h');
    await fs.writeFile(path.join(root, '.swarm/acceptance-reviews/records.json'), 'not json');
    assert.deepEqual(await readAcceptanceRecords(root), { tickets: {} });
    await fs.rm(root, { recursive: true, force: true });
  });
});
