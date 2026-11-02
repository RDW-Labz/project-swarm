// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUncovered, ignoreUncovered } from '../tools/uncovered-tests.mjs';

const PREFIX = 'Uncovered test references (add the test to context, or list it in ignoreTests with a reason in the prompt): ';
const LINE = (test) => '\nignoreTests: ' + test + ' \u2014 Existing test is outside this job\'s declared outputs; the coordinator runs it after integration.';

test('parseUncovered parses well-formed entries', () => {
  const message = PREFIX + 'build: out.js <- tests/a.test.mjs; lint: x.md <- tests/b.test.mjs';
  assert.deepEqual(parseUncovered(message), [
    { job: 'build', output: 'out.js', test: 'tests/a.test.mjs' },
    { job: 'lint', output: 'x.md', test: 'tests/b.test.mjs' },
  ]);
});

test('parseUncovered returns [] for other messages', () => {
  assert.deepEqual(parseUncovered('something else entirely'), []);
  assert.deepEqual(parseUncovered(''), []);
});

test('parseUncovered returns [] for an empty entry list', () => {
  assert.deepEqual(parseUncovered(PREFIX), []);
});

test('parseUncovered skips malformed entries', () => {
  const message = PREFIX + 'not an entry; build: out.js <- tests/a.test.mjs; bad-entry';
  assert.deepEqual(parseUncovered(message), [
    { job: 'build', output: 'out.js', test: 'tests/a.test.mjs' },
  ]);
});

test('ignoreUncovered adds sorted tests and exact prompt lines', () => {
  const jobs = [{ id: 'build', prompt: 'Do it.', ignoreTests: ['tests/z.test.mjs'] }];
  const refs = [{ job: 'build', output: 'out.js', test: 'tests/a.test.mjs' }];
  const [result] = ignoreUncovered(jobs, refs);
  assert.deepEqual(result.ignoreTests, ['tests/a.test.mjs', 'tests/z.test.mjs']);
  assert.equal(result.prompt, 'Do it.' + LINE('tests/a.test.mjs'));
});

test('ignoreUncovered does not duplicate an already-ignored test or its prompt line', () => {
  const jobs = [{ id: 'build', prompt: 'P', ignoreTests: ['tests/a.test.mjs'] }];
  const refs = [{ job: 'build', output: 'out.js', test: 'tests/a.test.mjs' }];
  const [result] = ignoreUncovered(jobs, refs);
  assert.deepEqual(result.ignoreTests, ['tests/a.test.mjs']);
  assert.equal(result.prompt, 'P');
});

test('ignoreUncovered leaves unnamed jobs unchanged and ignores unknown job refs', () => {
  const other = { id: 'other', prompt: 'O', ignoreTests: [] };
  const build = { id: 'build', prompt: 'B', ignoreTests: [] };
  const refs = [{ job: 'ghost', output: 'x', test: 'tests/a.test.mjs' }];
  const result = ignoreUncovered([other, build], refs);
  assert.deepEqual(result, [other, build]);
});

test('ignoreUncovered returns a new array and never mutates inputs', () => {
  const jobs = [{ id: 'build', prompt: 'P', ignoreTests: [] }];
  const snapshot = structuredClone(jobs);
  const refs = [{ job: 'build', output: 'out.js', test: 'tests/a.test.mjs' }];
  const result = ignoreUncovered(jobs, refs);
  assert.notEqual(result, jobs);
  assert.notEqual(result[0], jobs[0]);
  assert.deepEqual(jobs, snapshot);
  assert.deepEqual(refs, [{ job: 'build', output: 'out.js', test: 'tests/a.test.mjs' }]);
});
