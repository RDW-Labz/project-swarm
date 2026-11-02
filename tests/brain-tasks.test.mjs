// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { think, digest, triage, draftThenPolish, preflight, prefilterLog } from '../tools/brain-tasks.mjs';

const isCode = (re) => (e) => re.test(`${e.code ?? ''} ${e.message}`);
const J = (o) => JSON.stringify(o);
const opts = (n, p = 'o') => Array.from({ length: n }, (_, i) => ({ title: `${p}${i}`, reason: `r${i}` }));

function fakeAsk(replies) {
  const calls = [];
  const ask = async (req) => {
    calls.push(req);
    const r = typeof replies === 'function' ? replies(calls.length - 1, req) : replies.shift();
    if (r instanceof Error) throw r;
    return { text: r ?? '', via: 'local', usage: { inTokens: 1, outTokens: 1 }, paidUsd: 0, ms: 1 };
  };
  return { ask, calls };
}

test('think defaults to two rounds and returns at most three options', async () => {
  const { ask, calls } = fakeAsk([J({ options: opts(5) }), J({ options: opts(4) })]);
  const out = await think(ask, 'Q?');
  assert.equal(calls.length, 2);
  assert.equal(out.rounds, 2);
  assert.equal(out.top3.length, 3);
  assert.equal(out.via, 'local');
  assert.ok(out.savedTokens > 0);
});

test('think rejects rounds outside 1 to 4 before asking', async () => {
  const { ask, calls } = fakeAsk([]);
  for (const rounds of [0, 5, 2.5]) {
    await assert.rejects(think(ask, 'Q', { rounds }), isCode(/brain-request-invalid/));
  }
  assert.equal(calls.length, 0);
});

test('think runs the requested rounds and accepts fenced JSON', async () => {
  const { ask, calls } = fakeAsk(['```json\n' + J({ options: opts(2) }) + '\n```', J({ options: opts(2) }), J({ options: opts(1) })]);
  const out = await think(ask, 'Q', { rounds: 3 });
  assert.equal(calls.length, 3);
  assert.equal(out.top3.length, 1);
});

test('JSON is found between prose and the first to last brace', async () => {
  const { ask } = fakeAsk(['Here you go: ' + J({ options: opts(1, 'x') }) + ' thanks']);
  const out = await think(ask, 'Q', { rounds: 1 });
  assert.equal(out.top3[0].title, 'x0');
});

test('a bad critic reply keeps the previous options', async () => {
  const { ask } = fakeAsk([J({ options: opts(2, 'a') }), 'not json at all']);
  const out = await think(ask, 'Q', { rounds: 2 });
  assert.deepEqual(out.top3.map((o) => o.title), ['a0', 'a1']);
});

test('bad round-one output throws brain-bad-output', async () => {
  const { ask } = fakeAsk(['nope']);
  await assert.rejects(think(ask, 'Q'), isCode(/brain-bad-output/));
});

test('think caps titles and reasons and keeps them single line', async () => {
  const long = { title: 'T'.repeat(200) + '\nmore', reason: 'R'.repeat(500) };
  const { ask } = fakeAsk([J({ options: [long] })]);
  const [o] = (await think(ask, 'Q', { rounds: 1 })).top3;
  assert.ok(o.title.length <= 80);
  assert.ok(!o.title.includes('\n'));
  assert.ok(o.reason.length <= 200);
});

test('prefilterLog keeps head, tail and error lines of a long log', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ` + 'x'.repeat(10));
  lines[1000] = 'ERROR: boom in middle';
  const text = lines.join('\n');
  const cut = prefilterLog(text, { maxChars: 12000 });
  assert.ok(cut.length < text.length);
  assert.ok(cut.includes('line 0 '));
  assert.ok(cut.includes('line 1999 '));
  assert.ok(cut.includes('ERROR: boom in middle'));
  assert.ok(cut.includes('omitted'));
});

test('digest sends a prefiltered log and returns at most 15 lines', async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `row ${i} ` + 'y'.repeat(12)).join('\n');
  const reply = Array.from({ length: 20 }, (_, i) => `finding ${i}`).join('\n');
  const { ask, calls } = fakeAsk([reply]);
  const out = await digest(ask, big);
  assert.ok(calls[0].user.includes('omitted'));
  assert.ok(calls[0].user.length < big.length);
  assert.equal(out.lines.length, 15);
  assert.equal(out.reduced, true);
  assert.ok(out.savedTokens >= 0);
});

test('digest honours maxLines, drops blanks and cuts long lines', async () => {
  const reply = ['a', '', 'b', 'c'.repeat(300), 'd', 'e'].join('\n');
  const { ask } = fakeAsk([reply]);
  const out = await digest(ask, 'short log', { maxLines: 3 });
  assert.equal(out.lines.length, 3);
  assert.ok(out.lines.every((l) => l.length <= 200));
  assert.deepEqual(out.lines.slice(0, 2), ['a', 'b']);
  assert.equal(out.reduced, false);
});

const base = { jobId: 'j1', status: 'failed', error: 'boom', tail: 'tail', agent: 'codex' };

test('a valid retry verdict passes through', async () => {
  const { ask } = fakeAsk([J({ verdict: 'retry', hint: 'rerun it' })]);
  const out = await triage(ask, { ...base, attempts: 0 });
  assert.equal(out.verdict, 'retry');
  assert.equal(out.hint, 'rerun it');
  assert.equal(out.via, 'local');
});

test('bad JSON, unknown verdict and empty reply give needs-human', async () => {
  for (const reply of ['garbage', J({ verdict: 'maybe', hint: 'x' }), '']) {
    const { ask } = fakeAsk([reply]);
    const out = await triage(ask, base);
    assert.equal(out.verdict, 'needs-human');
    assert.equal(out.hint, '');
  }
});

test('attempts of two or more never retry', async () => {
  for (const attempts of [2, 3]) {
    const { ask } = fakeAsk([J({ verdict: 'retry', hint: 'again' })]);
    const out = await triage(ask, { ...base, attempts });
    assert.equal(out.verdict, 'escalate');
  }
  const { ask } = fakeAsk([J({ verdict: 'needs-human', hint: 'x' })]);
  assert.equal((await triage(ask, { ...base, attempts: 5 })).verdict, 'needs-human');
});

test('hint is one line and capped; error and tail are cut before asking', async () => {
  const { ask, calls } = fakeAsk([J({ verdict: 'escalate', hint: 'h'.repeat(400) + '\nextra' })]);
  const out = await triage(ask, { ...base, error: 'E'.repeat(1000), tail: 'T'.repeat(5000), sensitive: true });
  assert.ok(out.hint.length <= 300);
  assert.ok(!out.hint.includes('\n'));
  assert.ok(!calls[0].user.includes('E'.repeat(700)));
  assert.ok(!calls[0].user.includes('T'.repeat(2100)));
  assert.equal(calls[0].sensitive, true);
});

test('draft without a polisher is returned unpolished with a note', async () => {
  const { ask } = fakeAsk(['A draft text.']);
  const out = await draftThenPolish(ask, null, { kind: 'docs', brief: 'b' });
  assert.equal(out.text, 'A draft text.');
  assert.equal(out.polished, false);
  assert.match(out.polishNote, /^not polished/);
  assert.equal(out.savedTokens, Math.ceil('A draft text.'.length / 4));
});

test('a throwing polisher falls back to the draft with its code', async () => {
  const { ask } = fakeAsk(['Draft.']);
  const polish = async () => { throw Object.assign(new Error('x'), { code: 'brain-unavailable' }); };
  const out = await draftThenPolish(ask, polish, { kind: 'pr', brief: 'b' });
  assert.equal(out.text, 'Draft.');
  assert.equal(out.polished, false);
  assert.match(out.polishNote, /^not polished: brain-unavailable/);
});

test('a polisher result replaces the draft, is sanitized and capped', async () => {
  const { ask } = fakeAsk(['Draft.']);
  const seen = [];
  const polish = async (draft, o) => {
    seen.push([draft, o]);
    return { text: 'Final sk-' + 'a'.repeat(24) + '\u0007 ' + 'z'.repeat(30000), note: 'fixed' };
  };
  const out = await draftThenPolish(ask, polish, { kind: 'plan', brief: 'B' });
  assert.equal(seen[0][0], 'Draft.');
  assert.deepEqual(seen[0][1], { kind: 'plan', brief: 'B' });
  assert.equal(out.polished, true);
  assert.ok(!out.text.includes('sk-' + 'a'.repeat(24)));
  assert.ok(!out.text.includes('\u0007'));
  assert.ok(out.text.length <= 20000);
});

test('context is cut to 20000 characters before drafting', async () => {
  const { ask, calls } = fakeAsk(['ok']);
  await draftThenPolish(ask, null, { kind: 'docs', brief: 'b', context: 'lorem ipsum '.repeat(3000) });
  assert.ok(calls[0].user.length < 20000 + 2000, 'cut before drafting');
  assert.ok(calls[0].user.includes('lorem ipsum lorem ipsum'));
});

test('preflight returns only jobs with issues and tolerates bad answers', async () => {
  const jobs = [
    { id: 'a', prompt: 'JOB-a do it' },
    { id: 'b', prompt: 'JOB-b do it BAD' },
    { id: 'c', prompt: 'JOB-c do it' },
  ];
  const replies = (_, req) => {
    if (req.user.includes('BAD')) return 'garbage';
    if (req.user.includes('JOB-a')) return J({ issues: ['missing context'] });
    return J({ issues: [] });
  };
  const { ask } = fakeAsk(replies);
  const out = await preflight(ask, jobs);
  assert.deepEqual(out.map((r) => r.job.id), ['a', 'b']);
  assert.deepEqual(out[0].issues, ['missing context']);
  assert.match(out[1].issues[0], /could not read/);
});

test('preflight checks at most 30 jobs and keeps at most 5 issues each', async () => {
  const jobs = Array.from({ length: 35 }, (_, i) => ({ id: `j${i}`, prompt: `P${i}` }));
  const { ask, calls } = fakeAsk(() => J({ issues: ['1', '2', '3', '4', '5', '6', '7'] }));
  const out = await preflight(ask, jobs);
  assert.equal(calls.length, 30);
  assert.equal(out.length, 30);
  assert.equal(out[0].issues.length, 5);
  assert.ok(out.every((r) => r.issues.every((s) => typeof s === 'string')));
});
