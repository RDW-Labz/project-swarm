// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseFailedTests,
  buildRerunArgv,
  rerunFailed,
  redactRerunTail,
} from '../tools/gate-rerun.mjs';

const PYTEST_OUT = [
  'FAILED tests/test_wheel.py::test_one - AssertionError',
  'ERROR tests/test_wheel.py::test_two - boom',
  'FAILED tests/test_wheel.py::test_three',
  '2 failed',
].join('\n');

test('parseFailedTests reads pytest FAILED and ERROR lines', () => {
  const got = parseFailedTests(PYTEST_OUT, 'pytest');
  assert.deepEqual(got.map(entry => entry.id), [
    'tests/test_wheel.py::test_one',
    'tests/test_wheel.py::test_two',
    'tests/test_wheel.py::test_three',
  ]);
});

test('parseFailedTests reads node:test TAP with location', () => {
  const out = [
    'not ok 1 - alpha fails',
    '  location: tests/a.test.mjs:12:5',
    'not ok 2 - beta fails',
    '  test at tests/b.test.mjs:3:1',
  ].join('\n');
  const got = parseFailedTests(out, 'node-test');
  assert.deepEqual(got, [
    { id: 'tests/a.test.mjs::alpha fails', name: 'alpha fails', file: 'tests/a.test.mjs' },
    { id: 'tests/b.test.mjs::beta fails', name: 'beta fails', file: 'tests/b.test.mjs' },
  ]);
});

test('parseFailedTests auto detects pytest vs node:test', () => {
  assert.equal(parseFailedTests(PYTEST_OUT, 'auto')[0].id, 'tests/test_wheel.py::test_one');
  assert.equal(parseFailedTests('not ok 1 - only name', 'auto')[0].name, 'only name');
});

test('parseFailedTests caps at fifty ids', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`FAILED tests/t.py::test_${i} - x`);
  assert.equal(parseFailedTests(lines.join('\n'), 'pytest').length, 50);
});

test('buildRerunArgv builds pytest rerun argv', () => {
  const argv = ['python3', '-m', 'pytest', '-q', 'tests/', '{affected}', '--maxfail=1'];
  const failed = ['tests/a.py::test_x'];
  assert.deepEqual(buildRerunArgv(argv, failed, 'pytest'), [
    'python3', '-m', 'pytest', '--maxfail=1', '-rA', '-p', 'no:cacheprovider', 'tests/a.py::test_x',
  ]);
});

test('buildRerunArgv builds node:test rerun argv', () => {
  const argv = [
    process.execPath,
    '--import',
    './tests/_isolate-config.mjs',
    '--test',
    '--test-reporter=spec',
    'tests/a.test.mjs',
    'tests/b.test.mjs',
  ];
  const failed = [
    { id: 'tests/a.test.mjs::alpha', name: 'alpha', file: 'tests/a.test.mjs' },
    { id: 'beta', name: 'beta', file: 'tests/b.test.mjs' },
  ];
  const got = buildRerunArgv(argv, failed, 'node-test');
  assert.ok(got.includes('--test'));
  assert.ok(got.includes('--test-name-pattern=alpha'));
  assert.ok(got.includes('--test-name-pattern=beta'));
  assert.ok(got.includes('tests/a.test.mjs'));
  assert.ok(got.includes('tests/b.test.mjs'));
  assert.equal(got.filter(a => a === 'tests/a.test.mjs').length, 1);
});

test('buildRerunArgv returns null for unsafe argv', () => {
  assert.equal(buildRerunArgv(['bash', '-c', 'pytest'], ['x'], 'pytest'), null);
  assert.equal(buildRerunArgv(['node', '-e', '1'], [{ id: 'n', name: 'n' }], 'node-test'), null);
  assert.equal(buildRerunArgv(['pytest'], [], 'pytest'), null);
});

test('redactRerunTail redacts env values and bearer or sk patterns', () => {
  const value1 = ['sk', '-'].join('') + 'a'.repeat(24);
  const value2 = ['sk', '-'].join('') + 'b'.repeat(24);
  const envName = ['API', '_', 'TOK', 'EN'].join('');
  const env = { [envName]: value1, PLAIN: 'visible' };
  const raw = `before ${value1} Authorization: Bearer abc.def.ghi stray ${value2} keep-visible`;
  const tail = redactRerunTail(raw, env);
  assert.ok(!tail.includes(value1));
  assert.ok(!tail.includes(value2));
  assert.match(tail, /Bearer \[redacted\]/);
  assert.match(tail, /sk-\[redacted\]/);
  assert.match(tail, /keep-visible/);
});

test('rerunFailed trims output to maxBytes', async () => {
  const chunk = 'x'.repeat(40);
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 4242,
      stdout: { on: (ev, fn) => { handlers.stdout = fn; }, destroy() {} },
      stderr: { on: (ev, fn) => { handlers.stderr = fn; }, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill() {},
    };
    setImmediate(() => {
      handlers.stdout?.(chunk.repeat(5));
      handlers.exit?.(1, null);
    });
    return child;
  };
  const result = await rerunFailed({
    argv: ['pytest', 'tests/a.py::t'],
    failed: ['tests/a.py::t'],
    kind: 'pytest',
    spawnImpl,
    maxBytes: 50,
    timeoutMs: 5000,
  });
  assert.equal(result.tail.length, 50);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
});

test('rerunFailed kills the process group on timeout', async () => {
  const signals = [];
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 5150,
      stdout: { on: () => {}, destroy() {} },
      stderr: { on: () => {}, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill(sig) { signals.push(['child', sig]); },
    };
    return child;
  };
  const realKill = process.kill.bind(process);
  process.kill = (pid, sig) => {
    signals.push([pid, sig]);
    if (pid === -5150) return;
    return realKill(pid, sig);
  };
  try {
    const result = await rerunFailed({
      argv: ['pytest', 'tests/a.py::t'],
      failed: ['tests/a.py::t'],
      kind: 'pytest',
      spawnImpl,
      timeoutMs: 30,
      maxBytes: 1024,
    });
    assert.equal(result.timedOut, true);
    assert.ok(signals.some(([pid, sig]) => pid === -5150 && sig === 'SIGTERM'));
    assert.ok(signals.some(([pid, sig]) => pid === -5150 && sig === 'SIGKILL'));
  } finally {
    process.kill = realKill;
  }
});

test('rerunFailed returns null argv when rerun cannot be built', async () => {
  const result = await rerunFailed({
    argv: ['bash', '-c', 'pytest'],
    failed: ['tests/a.py::t'],
    kind: 'pytest',
    spawnImpl: () => { throw new Error('should not spawn'); },
  });
  assert.equal(result.argv, null);
  assert.equal(result.ok, false);
});
