import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvNames, envNamesLine } from '../tools/env-names.mjs';

const NL = String.fromCharCode(10);
const PREFIX = 'Environment variable names this project reads (names only, values are not shared): ';

function parseOrThrow(value) {
  try {
    return parseEnvNames(value);
  } catch (e) {
    return 'threw';
  }
}

function lineOrThrow(value) {
  try {
    return envNamesLine(value);
  } catch (e) {
    return 'threw';
  }
}

test('empty text returns no names', () => {
  assert.deepEqual(parseEnvNames(''), []);
});

test('reads NAME=value lines', () => {
  assert.deepEqual(parseEnvNames(['A=1', 'B=2'].join(NL)), ['A', 'B']);
});

test('reads export NAME=value lines', () => {
  assert.deepEqual(parseEnvNames('export FOO=bar'), ['FOO']);
});

test('returns sorted unique names', () => {
  assert.deepEqual(parseEnvNames(['Z=1', 'A=2', 'Z=3'].join(NL)), ['A', 'Z']);
});

test('comment lines are ignored', () => {
  assert.deepEqual(parseEnvNames(['# SECRET=x', 'REAL=1'].join(NL)), ['REAL']);
});

test('values are never returned', () => {
  const result = parseEnvNames('API_KEY=supersecretvalue');
  assert.deepEqual(result, ['API_KEY']);
  assert.equal(JSON.stringify(result).indexOf('supersecretvalue'), -1);
});

test('lowercase names are not returned', () => {
  assert.deepEqual(parseEnvNames('lower=1'), []);
});

test('a name must start with a capital letter', () => {
  assert.deepEqual(parseEnvNames('1ABC=2'), []);
});

test('digits and underscores are allowed after the first character', () => {
  assert.deepEqual(parseEnvNames('A_1=2'), ['A_1']);
});

test('a 64-character name is accepted', () => {
  const name = 'A' + 'B'.repeat(63);
  assert.equal(name.length, 64);
  assert.deepEqual(parseEnvNames(name + '=1'), [name]);
});

test('a 65-character name is rejected', () => {
  const name = 'A' + 'B'.repeat(64);
  assert.equal(name.length, 65);
  assert.deepEqual(parseEnvNames(name + '=1'), []);
});

test('at most 100 names are returned', () => {
  const lines = [];
  for (let i = 0; i < 150; i++) {
    lines.push('V' + i + '=1');
  }
  const result = parseEnvNames(lines.join(NL));
  assert.equal(result.length, 100);
});

test('wrong input types give no names or a thrown error', () => {
  const values = [null, undefined, 42, {}, true];
  for (const value of values) {
    const r = parseOrThrow(value);
    assert.ok(r === 'threw' || (Array.isArray(r) && r.length === 0));
  }
});

test('envNamesLine returns an empty string for no names', () => {
  assert.equal(envNamesLine([]), '');
});

test('envNamesLine lists the names in the contract wording', () => {
  assert.equal(
    envNamesLine(['A', 'B', 'C']),
    PREFIX + 'A, B, C.'
  );
});

test('envNamesLine with one name', () => {
  assert.equal(envNamesLine(['ONLY']), PREFIX + 'ONLY.');
});

test('envNamesLine with wrong input types gives an empty string or a thrown error', () => {
  const values = [null, undefined, 42, 'A'];
  for (const value of values) {
    const r = lineOrThrow(value);
    assert.ok(r === 'threw' || r === '');
  }
});
