// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatBaseCheck,
  formatBaseRedWarningMessage,
  formatFailingBaseCheckDetails,
} from '../tools/init-profile.mjs';
import { sanitizeText } from '../tools/journal.mjs';

const ISO = '2026-10-15T00:00:00.000Z';

test('red base with two failing checks prints names, exit codes, tails, and keeps first line', () => {
  const baseCheck = {
    status: 'red',
    ranAt: ISO,
    checks: [
      {
        name: 'test',
        ok: false,
        exitCode: 1,
        tail: 'ignored\nfirst fail line\nsecond fail line\nthird fail line',
      },
      {
        name: 'lint',
        ok: false,
        exitCode: null,
        tail: 'spawn ENOENT\nlint never ran',
      },
      { name: 'build', ok: true, exitCode: 0, tail: '' },
    ],
  };
  const text = formatBaseCheck(baseCheck);
  const [first, ...rest] = text.split('\n');
  assert.equal(first, 'Base checks: RED, already failing before any change: test, lint');
  const body = rest.join('\n');
  assert.match(body, /test \(exit 1\)/);
  assert.match(body, /lint \(did not start\)/);
  assert.match(body, /first fail line/);
  assert.match(body, /second fail line/);
  assert.match(body, /third fail line/);
  assert.match(body, /lint never ran/);
  assert.doesNotMatch(body, /ignored/);
});

test('long tail lines are cut to 160 characters', () => {
  const longLine = 'x'.repeat(200);
  const details = formatFailingBaseCheckDetails([
    { name: 'test', ok: false, exitCode: 1, tail: longLine },
  ]);
  assert.match(details, /^  test \(exit 1\)\n    x{160}$/);
  assert.doesNotMatch(details, /x{161}/);
});

test('more than five failing checks prints and N more', () => {
  const failing = Array.from({ length: 7 }, (_, index) => ({
    name: `check-${index}`,
    ok: false,
    exitCode: 1,
    tail: `error ${index}`,
  }));
  const details = formatFailingBaseCheckDetails(failing);
  assert.match(details, /check-0/);
  assert.match(details, /check-4/);
  assert.doesNotMatch(details, /check-5/);
  assert.match(details, /and 2 more/);
});

test('red base with failing checks that have no exitCode and no tail stays one line', () => {
  const baseCheck = {
    status: 'red',
    ranAt: ISO,
    checks: [
      { name: 'test', ok: false },
      { name: 'lint', ok: false },
      { name: 'build', ok: true },
    ],
  };
  assert.equal(
    formatBaseCheck(baseCheck),
    'Base checks: RED, already failing before any change: test, lint',
  );
  const warning = formatBaseRedWarningMessage(baseCheck);
  assert.equal(warning, 'base-red: checks already fail before any change: test, lint');
  assert.equal(warning.split('\n').length, 1);
});

test('green, none, and skipped stay one line', () => {
  const green = formatBaseCheck({ status: 'green', ranAt: ISO, checks: [{ ok: true }, { ok: true }] });
  assert.match(green, /^Base checks: green \(2 checks, 2026-10-15T/);
  assert.equal(formatBaseCheck({ status: 'skipped', ranAt: null, checks: [] }), 'Base checks: not run');
  assert.equal(formatBaseCheck({ status: 'none', ranAt: null, checks: [] }), 'Base checks: none defined');
  assert.equal(green.split('\n').length, 1);
});

test('init base-red warning keeps first line and carries detail', () => {
  const baseCheck = {
    status: 'red',
    checks: [
      { name: 'test', ok: false, exitCode: 1, tail: 'boom' },
    ],
  };
  const warning = formatBaseRedWarningMessage(baseCheck);
  const [first, ...rest] = warning.split('\n');
  assert.equal(first, 'base-red: checks already fail before any change: test');
  assert.match(rest.join('\n'), /test \(exit 1\)/);
  assert.match(rest.join('\n'), /boom/);
});

test('sanitized tail masks secret-looking text in formatted output', () => {
  const raw = 'Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456';
  const tail = sanitizeText(raw);
  const details = formatFailingBaseCheckDetails([
    { name: 'test', ok: false, exitCode: 1, tail },
  ]);
  assert.doesNotMatch(details, /sk-live-/);
  assert.match(details, /\[redacted\]/i);
});
