// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTestsAfterBuild } from '../tools/wiring.mjs';

const ticket = (id, type, extra = {}) => ({
  id,
  type,
  status: 'todo',
  scopeRefs: ['R-001'],
  dependsOn: [],
  ...extra,
});

test('a build ticket that owns its test does not wait on the separate test ticket', () => {
  const build = ticket('T-0007', 'build', {
    tests: ['tests/widget.test.mjs'],
    dependsOn: ['T-0009'],
  });
  const separateTest = ticket('T-0009', 'test', { files: ['tests/widget.test.mjs'] });

  const notes = orderTestsAfterBuild([build, separateTest]);

  assert.deepEqual(build.dependsOn, []);
  assert.deepEqual(separateTest.dependsOn, ['T-0007']);
  assert.ok(notes.includes('T-0007: owns its tests; no longer waits on T-0009'));
  assert.ok(notes.some(note => note.startsWith('T-0009: test ticket now waits for T-0007')));
});

test('a separate test ticket still waits for its build module when the build starts unordered', () => {
  const build = ticket('T-0007', 'build', { tests: ['tests/widget.test.mjs'] });
  const separateTest = ticket('T-0009', 'test', { files: ['tests/widget.test.mjs'] });

  const notes = orderTestsAfterBuild([separateTest, build]);

  assert.deepEqual(build.dependsOn, []);
  assert.deepEqual(separateTest.dependsOn, ['T-0007']);
  assert.deepEqual(notes, ['T-0009: test ticket now waits for T-0007 (a test runs after the module it tests)']);
});
