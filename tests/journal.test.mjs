// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KINDS, journalPath, appendEvent, readJournal, sanitizeText, openItems } from '../tools/journal.mjs';

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'journal-test-'));
}

test('exports the kinds and the journal path', async () => {
  assert.equal(KINDS.length, 12);
  assert.ok(KINDS.includes('checkpoint'));
  const root = await tempRoot();
  assert.equal(journalPath(root), path.join(root, '.swarm', 'project', 'journal.ndjson'));
});

test('rejects an unknown kind', async () => {
  const root = await tempRoot();
  await assert.rejects(appendEvent(root, { kind: 'bogus', text: 'x' }), /journal-kind-invalid: bogus/);
});

test('appends one line, sets ts from now and ignores a caller ts', async () => {
  const root = await tempRoot();
  const stored = await appendEvent(root, { kind: 'note', text: 'hi', ts: '1999-01-01T00:00:00.000Z' }, { now: () => 1700000000000 });
  assert.equal(stored.ts, new Date(1700000000000).toISOString());
  const raw = await fs.readFile(journalPath(root), 'utf8');
  assert.equal(raw, JSON.stringify(stored) + '\n');
});

test('appends in order to the same file', async () => {
  const root = await tempRoot();
  await appendEvent(root, { kind: 'note', text: 'one' });
  await appendEvent(root, { kind: 'note', text: 'two' });
  const lines = (await fs.readFile(journalPath(root), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).text, 'two');
});

test('sanitizes every string at any depth', async () => {
  const root = await tempRoot();
  const stored = await appendEvent(root, { kind: 'note', text: 'a\u0001b', nested: { deep: ['x\u0002y'] } });
  assert.equal(stored.text, 'a b');
  assert.equal(stored.nested.deep[0], 'x y');
});

test('refuses invalid keys and more than 30 top-level keys', async () => {
  const root = await tempRoot();
  await assert.rejects(appendEvent(root, { kind: 'note', 'bad-key': 1 }), /journal-key-invalid: bad-key/);
  await assert.rejects(appendEvent(root, { kind: 'note', ['a'.repeat(41)]: 1 }), /journal-key-invalid/);
  const exactly30 = { kind: 'note' };
  for (let i = 0; i < 29; i++) exactly30[`k${i}`] = i;
  await appendEvent(root, exactly30);
  const tooMany = { kind: 'note' };
  for (let i = 0; i < 30; i++) tooMany[`k${i}`] = i;
  await assert.rejects(appendEvent(root, tooMany), /journal-too-many-keys/);
});

test('sanitizeText replaces control characters but keeps newline and tab', () => {
  assert.equal(sanitizeText('a\u0001b\nc\td\u007fe'), 'a b\nc\td e');
});

test('sanitizeText cuts to 2000 characters with an ellipsis', () => {
  assert.equal(sanitizeText('hello'), 'hello');
  const out = sanitizeText('ab '.repeat(1000));
  assert.equal([...out].length, 2000);
  assert.ok(out.endsWith('…'));
});

test('sanitizeText redacts secrets and assignments', () => {
  const cases = [
    ['key sk-abcdefghijklmnopqrstuv', 'key [redacted]'],
    ['sk-ant-abcdefghijklmnop1234', '[redacted]'],
    ['sk-or-abcdefghijklmnop1234', '[redacted]'],
    ['Authorization Bearer abcdefghijklmnop1234', 'Authorization Bearer [redacted]'],
    ['authorization: bearer abcdefghijklmnop1234', 'authorization: Bearer [redacted]'],
    ['ghs_abcdefghijklmnopqrst and gho_abcdefghijklmnopqrst', '[redacted] and [redacted]'],
    ['ASIAABCDEFGHIJKLMNOP', '[redacted]'],
    ['AIzaSyA-abcdefghijklmnopqrstuvwxyz012345', '[redacted]'],
    ['TOKEN=abc', 'TOKEN=[redacted]'],
    ['API_KEY: abc', 'API_KEY: [redacted]'],
    ['API_KEY = abc', 'API_KEY = [redacted]'],
    ['{"api_key":"abc def"}', '{"api_key":[redacted]}'],
    ['PASSWORD="two words here" next', 'PASSWORD=[redacted] next'],
    ['https://user:pa55@example.invalid/x', 'https://[redacted]@example.invalid/x'],
    ['ghp_abcdefghijklmnop1234', '[redacted]'],
    ['github_pat_abcdefghijklmnop', '[redacted]'],
    ['AKIAABCDEFGHIJKLMNOP', '[redacted]'],
    ['MY_TOKEN=hunter2', 'MY_TOKEN=[redacted]'],
    ['db_password=xyz', 'db_password=[redacted]'],
    ['a'.repeat(40), '[redacted]'],
    ['deadbeef'.repeat(5), '[redacted]'],
    ['sk-short stays', 'sk-short stays'],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeText(input), expected, input);
});

test('keeps each stored line within 8192 bytes by truncating long strings', async () => {
  const root = await tempRoot();
  const big = 'a b '.repeat(2000);
  const stored = await appendEvent(root, { kind: 'note', text: big, a: big, b: big, c: big, d: big });
  assert.equal(stored.truncated, true);
  assert.equal(stored.kind, 'note');
  const raw = await fs.readFile(journalPath(root), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 8192);
});

test('an event too big because of nested content keeps its small fields and omits the nested value', async () => {
  const root = await tempRoot();
  const stored = await appendEvent(root, { kind: 'note', text: 'kept', data: { items: Array(10).fill('a b '.repeat(2000)) } });
  assert.equal(stored.text, 'kept');
  assert.equal(stored.data, '[omitted: too large]');
  assert.equal(stored.truncated, true);
  assert.ok((await fs.readFile(journalPath(root), 'utf8')).length < 8192);
});

test('forbidden keys are refused and the journal never follows a symlink out of the project', async () => {
  const root = await tempRoot();
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(appendEvent(root, JSON.parse(`{"kind":"note","${key}":"x"}`)), /journal-key-invalid/);
  }
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-outside-'));
  await fs.mkdir(path.join(root, '.swarm'));
  await fs.symlink(outside, path.join(root, '.swarm', 'project'));
  await assert.rejects(appendEvent(root, { kind: 'note', text: 'x' }), /journal-path-unsafe/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.rm(path.join(root, '.swarm', 'project'));
  await fs.mkdir(path.join(root, '.swarm', 'project'));
  await fs.writeFile(path.join(outside, 'target'), 'keep');
  await fs.symlink(path.join(outside, 'target'), path.join(root, '.swarm', 'project', 'journal.ndjson'));
  await assert.rejects(appendEvent(root, { kind: 'note', text: 'x' }));
  assert.equal(await fs.readFile(path.join(outside, 'target'), 'utf8'), 'keep');
  await fs.rm(outside, { recursive: true, force: true });
});

test('best mode swallows journal I/O failures; default throws; kind is still validated', async () => {
  const root = await tempRoot();
  const blocked = path.join(root, 'not-a-dir');
  await fs.writeFile(blocked, 'x');
  const stored = await appendEvent(blocked, { kind: 'note', text: 'still returns' }, { best: true });
  assert.equal(stored.text, 'still returns');
  await assert.rejects(appendEvent(blocked, { kind: 'note', text: 'x' }));
  await assert.rejects(appendEvent(root, { kind: 'bogus' }, { best: true }), /journal-kind-invalid/);
});

test('readJournal returns newest events oldest first, honours kinds, and skips corrupt lines', async () => {
  const root = await tempRoot();
  assert.deepEqual(await readJournal(root), []);
  for (const text of ['n1', 'n2', 'n3', 'n4', 'n5']) await appendEvent(root, { kind: 'note', text });
  await appendEvent(root, { kind: 'goal', text: 'ship' });
  await fs.appendFile(journalPath(root), 'not json\n[1,2]\n\n');
  const last = await readJournal(root, { limit: 2 });
  assert.deepEqual(last.map(e => e.text), ['n5', 'ship']);
  const goals = await readJournal(root, { kinds: ['goal'] });
  assert.deepEqual(goals.map(e => e.text), ['ship']);
  assert.equal((await readJournal(root)).length, 6);
});

test('openItems returns unresolved blockers and human tasks, newest first, using the latest event per id', () => {
  const events = [
    { kind: 'blocker', id: 'b1', text: 'x' },
    { kind: 'blocker', id: 'b2', text: 'y' },
    { kind: 'blocker', id: 'b2', text: 'y', resolved: true },
    { kind: 'human', id: 'h1', text: 'do' },
    { kind: 'human', id: 'h2', text: 'do2', done: true },
    { kind: 'human', id: 'h1', text: 'do again' },
    { kind: 'note', id: 'n1', text: 'ignored' },
  ];
  const open = openItems(events);
  assert.deepEqual(open.map(e => e.id), ['h1', 'b1']);
  assert.equal(open[0].text, 'do again');
});
