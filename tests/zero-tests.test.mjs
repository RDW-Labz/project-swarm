import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { countTests, isTestCheck, zeroTestGuard, detectTestCommand } from '../tools/zero-tests.mjs';

test('countTests: node:test prints # tests N', () => {
  assert.deepEqual(countTests('# tests 5'), { runner: 'node', count: 5 });
});

test('countTests: TAP 1..0 is count 0', () => {
  assert.deepEqual(countTests('1..0'), { runner: 'tap', count: 0 });
});

test('countTests: vitest Tests N passed', () => {
  assert.deepEqual(countTests('Tests  3 passed (3)'), { runner: 'vitest', count: 3 });
});

test('countTests: vitest Test Files N', () => {
  assert.deepEqual(countTests('Test Files  2 passed (2)'), { runner: 'vitest', count: 2 });
});

test('countTests: vitest No test files found is count 0', () => {
  assert.deepEqual(countTests('No test files found, exiting with code 1'), { runner: 'vitest', count: 0 });
});

test('countTests: jest Tests: N', () => {
  assert.deepEqual(countTests('Tests:       2 passed, 2 total'), { runner: 'jest', count: 2 });
});

test('countTests: jest No tests found is count 0', () => {
  assert.deepEqual(countTests('No tests found, exiting with code 1'), { runner: 'jest', count: 0 });
});

test('countTests: pytest sums passed and failed', () => {
  assert.deepEqual(countTests('=== 3 passed, 1 failed in 0.2s ==='), { runner: 'pytest', count: 4 });
});

test('countTests: pytest no tests ran is count 0', () => {
  assert.deepEqual(countTests('no tests ran in 0.01s'), { runner: 'pytest', count: 0 });
});

test('countTests: pytest collected 0 items is count 0', () => {
  assert.deepEqual(countTests('collected 0 items'), { runner: 'pytest', count: 0 });
});

test('countTests: go no test files is count 0', () => {
  assert.deepEqual(countTests('?   example/pkg [no test files]'.replace('[no test files]', 'no test files')), { runner: 'go', count: 0 });
});

test('countTests: matching is case-insensitive', () => {
  assert.deepEqual(countTests('NO TESTS FOUND'), { runner: 'jest', count: 0 });
});

test('countTests: unrelated text returns nulls', () => {
  assert.deepEqual(countTests('hello world'), { runner: null, count: null });
});

test('countTests: empty string returns nulls', () => {
  assert.deepEqual(countTests(''), { runner: null, count: null });
});

test('countTests: null input returns nulls (assumed, not in contract)', () => {
  assert.deepEqual(countTests(null), { runner: null, count: null });
});

test('countTests: non-string input returns nulls (assumed, not in contract)', () => {
  assert.deepEqual(countTests(42), { runner: null, count: null });
});

test('isTestCheck: test and tests are true', () => {
  assert.equal(isTestCheck('test'), true);
  assert.equal(isTestCheck('tests'), true);
});

test('isTestCheck: names starting with test: are true', () => {
  assert.equal(isTestCheck('test:unit'), true);
});

test('isTestCheck: unit is true only as stated? no, unit alone is not a test name', () => {
  assert.equal(isTestCheck('unit'), false);
});

test('isTestCheck: other names are false', () => {
  assert.equal(isTestCheck('lint'), false);
  assert.equal(isTestCheck('typecheck'), false);
  assert.equal(isTestCheck('testing'), false);
});

test('zeroTestGuard: non-test check is returned unchanged', () => {
  const result = { status: 'passed', tail: '# tests 0' };
  assert.equal(zeroTestGuard({ name: 'lint' }, result), result);
});

test('zeroTestGuard: failed test check is returned unchanged', () => {
  const result = { status: 'failed', tail: '# tests 0' };
  assert.equal(zeroTestGuard({ name: 'test' }, result), result);
});

test('zeroTestGuard: passed test check with tests run is unchanged', () => {
  const result = { status: 'passed', tail: '# tests 4' };
  assert.equal(zeroTestGuard({ name: 'tests' }, result), result);
});

test('zeroTestGuard: passed test check with 0 tests becomes failed', () => {
  const result = { status: 'passed', tail: 'No tests found, exiting with code 1' };
  const out = zeroTestGuard({ name: 'test:unit' }, result);
  assert.equal(out.status, 'failed');
  assert.equal(out.noTests, true);
  assert.ok(out.tail.startsWith('No tests found, exiting with code 1'));
  assert.ok(out.tail.includes('no-tests:'));
});

test('zeroTestGuard: keeps other result fields', () => {
  const result = { status: 'passed', tail: '1..0', exitCode: 0 };
  const out = zeroTestGuard({ name: 'test' }, result);
  assert.equal(out.exitCode, 0);
  assert.equal(out.status, 'failed');
});

test('zeroTestGuard: passed test check with unknown count is unchanged', () => {
  const result = { status: 'passed', tail: 'all good' };
  assert.equal(zeroTestGuard({ name: 'test' }, result), result);
});

test('detectTestCommand: vitest in devDependencies', () => {
  assert.deepEqual(detectTestCommand({ pkg: { devDependencies: { vitest: '^1.0.0' } } }), { runner: 'vitest', command: ['npx', 'vitest', 'run', '{tests}'] });
});

test('detectTestCommand: vitest in dependencies', () => {
  assert.deepEqual(detectTestCommand({ pkg: { dependencies: { vitest: '^1.0.0' } } }).runner, 'vitest');
});

test('detectTestCommand: jest', () => {
  assert.deepEqual(detectTestCommand({ pkg: { devDependencies: { jest: '^29.0.0' } } }), { runner: 'jest', command: ['npx', 'jest', '{tests}'] });
});

test('detectTestCommand: playwright', () => {
  assert.deepEqual(detectTestCommand({ pkg: { devDependencies: { '@playwright/test': '^1.40.0' } } }), { runner: 'playwright', command: ['npx', 'playwright', 'test', '{tests}'] });
});

test('detectTestCommand: node --test in scripts.test', () => {
  assert.deepEqual(detectTestCommand({ pkg: { scripts: { test: 'node --test' } } }), { runner: 'node', command: ['node', '--test', '{tests}'] });
});

test('detectTestCommand: pytest from pyproject.toml', () => {
  assert.deepEqual(detectTestCommand({ pkg: {}, files: ['pyproject.toml'] }), { runner: 'pytest', command: ['pytest', '{tests}'] });
});

test('detectTestCommand: pytest from pytest.ini', () => {
  assert.deepEqual(detectTestCommand({ pkg: {}, files: ['pytest.ini'] }).runner, 'pytest');
});

test('detectTestCommand: vitest wins over node --test', () => {
  const pkg = { devDependencies: { vitest: '^1.0.0' }, scripts: { test: 'node --test' } };
  assert.equal(detectTestCommand({ pkg }).runner, 'vitest');
});

test('detectTestCommand: vitest wins over jest', () => {
  const pkg = { devDependencies: { vitest: '^1.0.0', jest: '^29.0.0' } };
  assert.equal(detectTestCommand({ pkg }).runner, 'vitest');
});

test('detectTestCommand: nothing detected returns null', () => {
  assert.equal(detectTestCommand({ pkg: {}, files: [] }), null);
});

test('detectTestCommand: files defaults to empty', () => {
  assert.equal(detectTestCommand({ pkg: { scripts: { build: 'tsc' } } }), null);
});
