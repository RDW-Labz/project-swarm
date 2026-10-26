// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  parseFailedTests,
  buildRerunArgv,
  rerunFailed,
  redactRerunTail,
} from '../tools/gate-rerun.mjs';

const SUMMARY_LINE = '=========================== short test summary info ===========================';

const PYTEST_OUT = [
  'some earlier failure noise',
  SUMMARY_LINE,
  'FAILED tests/test_wheel.py::test_one - AssertionError',
  'ERROR tests/test_wheel.py::test_two - boom',
  'FAILED tests/test_wheel.py::test_three',
  '============================== 2 failed in 0.1s ==============================',
].join('\n');

test('parseFailedTests reads pytest FAILED and ERROR lines from short summary only', () => {
  const got = parseFailedTests(PYTEST_OUT, 'pytest');
  assert.deepEqual(got.map(entry => entry.id), [
    'tests/test_wheel.py::test_one',
    'tests/test_wheel.py::test_two',
    'tests/test_wheel.py::test_three',
  ]);
  const noSummary = [
    'FAILED tests/ignored.py::test_x - AssertionError',
  ].join('\n');
  assert.deepEqual(parseFailedTests(noSummary, 'pytest'), []);
});

test('parseFailedTests rejects unsafe pytest ids in short summary', () => {
  const out = [
    SUMMARY_LINE,
    'FAILED -evil.py::test_x - x',
    'FAILED ../escape.py::test_y - x',
    'FAILED /abs/test_z.py::test_z - x',
    'FAILED tests/../other.py::test_w - x',
    'FAILED tests/ok.py::test_ok - x',
  ].join('\n');
  assert.deepEqual(parseFailedTests(out, 'pytest').map(e => e.id), ['tests/ok.py::test_ok']);
});

test('parseFailedTests handles realistic quoted absolute TAP locations', () => {
  const insideAbs = path.resolve('tests/inside.test.mjs');
  const outsideAbs = path.resolve(process.cwd(), '..', 'peer-outside.test.mjs');
  const out = [
    'TAP version 13',
    'not ok 1 - inside quoted abs',
    `  location: '${insideAbs}:2:1'`,
    '  failureType: testCodeFailure',
    '  error: boom',
    '  code: ERR_TEST_FAILURE',
    'not ok 2 - outside quoted abs',
    `  location: '${outsideAbs}:2:1'`,
    '  failureType: testCodeFailure',
    'not ok 3 - no location',
  ].join('\n');
  const got = parseFailedTests(out, 'node-test');
  assert.deepEqual(
    got.filter(entry => entry.file),
    [{ id: 'tests/inside.test.mjs::inside quoted abs', name: 'inside quoted abs', file: 'tests/inside.test.mjs' }],
  );
  assert.equal(got.find(entry => entry.name === 'outside quoted abs')?.file, undefined);
});

test('parseFailedTests unescapes TAP hash in test names', () => {
  const out = [
    'not ok 1 - a \\# b',
    '  location: tests/hash.test.mjs:1:1',
  ].join('\n');
  const got = parseFailedTests(out, 'node-test');
  assert.equal(got[0].name, 'a # b');
  assert.equal(got[0].id, 'tests/hash.test.mjs::a # b');
  const argv = ['node', '--test', 'tests/hash.test.mjs'];
  const rerun = buildRerunArgv(argv, got, 'node-test');
  assert.ok(rerun.includes('--test-name-pattern=^a # b$'));
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

test('parseFailedTests rejects unsafe node:test file paths', () => {
  const out = [
    'not ok 1 - bad path',
    '  location: -evil.test.mjs:1:1',
    'not ok 2 - parent escape',
    '  test at tests/../outside.test.mjs:1:1',
    'not ok 3 - absolute outside cwd',
    `  location: ${path.resolve(process.cwd(), '..', 'outside.test.mjs')}:1:1`,
    'not ok 4 - not a test file',
    '  location: tests/_isolate-config.mjs:1:1',
    'not ok 5 - good',
    '  location: tests/safe.test.mjs:2:3',
  ].join('\n');
  const got = parseFailedTests(out, 'node-test');
  for (const entry of got) {
    if (!entry.file) continue;
    assert.ok(!entry.file.startsWith('-'));
    assert.ok(!entry.file.includes('..'));
    assert.ok(!path.isAbsolute(entry.file));
    assert.match(entry.file, /\.test\.(mjs|cjs|js|ts)$/i);
  }
  assert.deepEqual(
    got.filter(entry => entry.file),
    [{ id: 'tests/safe.test.mjs::good', name: 'good', file: 'tests/safe.test.mjs' }],
  );
});

test('parseFailedTests auto detects pytest vs node:test', () => {
  assert.equal(parseFailedTests(PYTEST_OUT, 'auto')[0].id, 'tests/test_wheel.py::test_one');
  assert.equal(parseFailedTests('not ok 1 - only name', 'auto')[0].name, 'only name');
});

test('parseFailedTests caps at fifty ids', () => {
  const lines = [SUMMARY_LINE];
  for (let i = 0; i < 60; i++) lines.push(`FAILED tests/t.py::test_${i} - x`);
  assert.equal(parseFailedTests(lines.join('\n'), 'pytest').length, 50);
});

test('buildRerunArgv builds pytest rerun argv with -- before ids', () => {
  const argv = ['python3', '-m', 'pytest', '-q', 'tests/', '{affected}', '--maxfail=1'];
  const failed = ['tests/a.py::test_x'];
  assert.deepEqual(buildRerunArgv(argv, failed, 'pytest'), [
    'python3', '-m', 'pytest', '--maxfail=1', '-rA', '-p', 'no:cacheprovider', '--', 'tests/a.py::test_x',
  ]);
});

test('buildRerunArgv keeps pytest path options and drops test path positionals', () => {
  const basetemp = ['/tmp', 'bt'].join('/');
  const argv = ['pytest', '--basetemp', basetemp, 'tests/'];
  const failed = ['tests/a.py::test_x'];
  assert.deepEqual(buildRerunArgv(argv, failed, 'pytest'), [
    'pytest',
    '--basetemp',
    basetemp,
    '-rA',
    '-p',
    'no:cacheprovider',
    '--',
    'tests/a.py::test_x',
  ]);
});

test('buildRerunArgv filters unsafe pytest ids from failed list', () => {
  const argv = ['pytest'];
  const failed = ['-evil.py::t', 'tests/../x.py::t', 'tests/good.py::t'];
  assert.deepEqual(buildRerunArgv(argv, failed, 'pytest'), [
    'pytest', '-rA', '-p', 'no:cacheprovider', '--', 'tests/good.py::t',
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
  assert.ok(got.includes('--test-name-pattern=^alpha$'));
  assert.ok(got.includes('--test-name-pattern=^beta$'));
  assert.ok(got.includes('tests/a.test.mjs'));
  assert.ok(got.includes('tests/b.test.mjs'));
  assert.ok(got.includes('./tests/_isolate-config.mjs'));
  assert.equal(got.filter(a => a === 'tests/a.test.mjs').length, 1);
});

test('buildRerunArgv preserves --import and drops placeholder for node:test', () => {
  const argv = [
    'node',
    '--import',
    './tests/_isolate-config.mjs',
    '--test',
    '{affected}',
  ];
  const failed = [{ id: 'tests/x.test.mjs::case', name: 'case', file: 'tests/x.test.mjs' }];
  assert.deepEqual(buildRerunArgv(argv, failed, 'node-test'), [
    'node',
    '--import',
    './tests/_isolate-config.mjs',
    '--test',
    '--test-name-pattern=^case$',
    'tests/x.test.mjs',
  ]);
});

test('buildRerunArgv anchors regex metacharacters in test name patterns', () => {
  const argv = ['node', '--test', 'tests/a.test.mjs'];
  const failed = [{ id: 'tests/a.test.mjs::a*b', name: 'a*b', file: 'tests/a.test.mjs' }];
  const got = buildRerunArgv(argv, failed, 'node-test');
  assert.ok(got.includes('--test-name-pattern=^a\\*b$'));
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
      stdout: { setEncoding() {}, on: (ev, fn) => { handlers.stdout = fn; }, destroy() {} },
      stderr: { setEncoding() {}, on: (ev, fn) => { handlers.stderr = fn; }, destroy() {} },
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
  assert.equal(Buffer.byteLength(result.tail, 'utf8'), 50);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
});

test('rerunFailed kills the process group on timeout', async () => {
  const signals = [];
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 5150,
      stdout: { setEncoding() {}, on: () => {}, destroy() {} },
      stderr: { setEncoding() {}, on: () => {}, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill(sig) { signals.push(['child', sig]); },
    };
    return child;
  };
  const killImpl = (pid, sig) => {
    signals.push([pid, sig]);
  };
  const result = await rerunFailed({
    argv: ['pytest', 'tests/a.py::t'],
    failed: ['tests/a.py::t'],
    kind: 'pytest',
    spawnImpl,
    killImpl,
    timeoutMs: 30,
    maxBytes: 1024,
  });
  assert.equal(result.timedOut, true);
  assert.ok(signals.some(([pid, sig]) => pid === -5150 && sig === 'SIGTERM'));
  assert.ok(signals.some(([pid, sig]) => pid === -5150 && sig === 'SIGKILL'));
});

test('rerunFailed does not kill a negative process group for invalid pid', async () => {
  const groupKills = [];
  const childKills = [];
  for (const pid of [undefined, 0, 1, 1.5, '2']) {
    const spawnImpl = () => ({
      pid,
      stdout: { setEncoding() {}, on: () => {}, destroy() {} },
      stderr: { setEncoding() {}, on: () => {}, destroy() {} },
      on(ev, fn) {
        if (ev === 'exit') setImmediate(() => fn(0, null));
      },
      kill(sig) { childKills.push([pid, sig]); },
    });
    await rerunFailed({
      argv: ['pytest', 'tests/a.py::t'],
      failed: ['tests/a.py::t'],
      kind: 'pytest',
      spawnImpl,
      killImpl: (p, sig) => { groupKills.push([p, sig]); },
      timeoutMs: 5000,
      maxBytes: 1024,
    });
  }
  assert.equal(groupKills.length, 0);
  assert.ok(childKills.length > 0);
});

test('redactRerunTail skips short env secret values', () => {
  const shortVal = 'x'.repeat(5);
  const envKey = ['MY', '_', 'SEC', 'RET'].join('');
  const env = { [envKey]: shortVal };
  const raw = `leak ${shortVal} end`;
  assert.match(redactRerunTail(raw, env), new RegExp(`leak ${shortVal} end`));
});

test('redactRerunTail redacts new token patterns and case-insensitive bearer', () => {
  const ghp = ['ghp', '_'].join('') + 'A'.repeat(20);
  const gho = ['gho', '_'].join('') + 'B'.repeat(20);
  const ghu = ['ghu', '_'].join('') + 'F'.repeat(20);
  const githubPat = ['github', '_pat', '_'].join('') + 'C'.repeat(20);
  const xox = ['xox', 'b', '-'].join('') + 'D'.repeat(12);
  const xoxs = ['xox', 's', '-'].join('') + 'G'.repeat(12);
  const akia = 'AKIA' + 'E'.repeat(16);
  const urlCred = ['https', '://', 'alice', ':', 's3cr3t', '@', 'example.com', '/path'].join('');
  const raw = [
    ghp,
    gho,
    ghu,
    githubPat,
    xox,
    xoxs,
    akia,
    urlCred,
    'auth: BeArEr tok.en.value',
  ].join(' ');
  const tail = redactRerunTail(raw, {});
  assert.ok(!tail.includes(ghp));
  assert.ok(!tail.includes(gho));
  assert.ok(!tail.includes(ghu));
  assert.ok(!tail.includes(githubPat));
  assert.ok(!tail.includes(xox));
  assert.ok(!tail.includes(xoxs));
  assert.ok(!tail.includes(akia));
  assert.ok(!tail.includes('alice'));
  assert.ok(!tail.includes('s3cr3t'));
  assert.match(tail, /Bearer \[redacted\]/);
  assert.match(tail, /ghp_\[redacted\]/);
  assert.match(tail, /gho_\[redacted\]/);
  assert.match(tail, /ghu_\[redacted\]/);
  assert.match(tail, /github_pat_\[redacted\]/);
  assert.match(tail, /AKIA\[redacted\]/);
  assert.match(tail, /https:\/\/\[redacted\]@example\.com\/path/);
});

test('redactRerunTail redacts credential URLs from URL-named env values', () => {
  const user = 'svc';
  const pass = 'p'.repeat(12);
  const host = 'db.internal';
  const value = ['postgres', '://', user, ':', pass, '@', host, '/app'].join('');
  const envKey = ['DATABASE', '_', 'URL'].join('');
  const env = { [envKey]: value };
  const tail = redactRerunTail(`connect ${value} done`, env);
  assert.ok(!tail.includes(pass));
  assert.ok(!tail.includes(user));
  assert.match(tail, /\[redacted\]/);
});

test('rerunFailed drops env secret fragments when value was cut at stream head', async () => {
  const secret = 'Q'.repeat(32);
  const envKey = ['GATE', '_', 'API', '_', 'TOKEN'].join('');
  const env = { [envKey]: secret };
  const filler = 'z'.repeat(200);
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 9002,
      stdout: { setEncoding() {}, on: (ev, fn) => { handlers.stdout = fn; }, destroy() {} },
      stderr: { setEncoding() {}, on: () => {}, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill() {},
    };
    setImmediate(() => {
      handlers.stdout?.(secret + filler);
      handlers.exit?.(1, null);
    });
    return child;
  };
  const result = await rerunFailed({
    argv: ['pytest', 'tests/a.py::t'],
    failed: ['tests/a.py::t'],
    kind: 'pytest',
    env,
    spawnImpl,
    maxBytes: 80,
    timeoutMs: 5000,
  });
  assert.ok(!result.tail.includes(secret));
  for (let len = 4; len <= secret.length; len++) {
    assert.ok(!result.tail.includes(secret.slice(0, len)), `leaked prefix len ${len}`);
  }
  assert.equal(Buffer.byteLength(result.tail, 'utf8'), 80);
});

test('rerunFailed redacts before byte trim so split secrets do not leak', async () => {
  const secret = ['sk', '-'].join('') + 'z'.repeat(24);
  const pad = 'p'.repeat(80);
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 9001,
      stdout: { setEncoding() {}, on: (ev, fn) => { handlers.stdout = fn; }, destroy() {} },
      stderr: { setEncoding() {}, on: (ev, fn) => { handlers.stderr = fn; }, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill() {},
    };
    setImmediate(() => {
      handlers.stdout?.(pad + secret.slice(0, 12));
      handlers.stderr?.(secret.slice(12) + pad);
      handlers.exit?.(1, null);
    });
    return child;
  };
  const result = await rerunFailed({
    argv: ['pytest', 'tests/a.py::t'],
    failed: ['tests/a.py::t'],
    kind: 'pytest',
    spawnImpl,
    maxBytes: 40,
    timeoutMs: 5000,
  });
  assert.ok(!result.tail.includes(secret));
  assert.doesNotMatch(result.tail, /sk-[A-Za-z0-9_-]{4,}/);
  assert.match(result.tail, /sk-\[redacted\]/);
  assert.equal(Buffer.byteLength(result.tail, 'utf8'), 40);
});

test('rerunFailed reports ok false when node rerun matches zero tests', async () => {
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 6060,
      stdout: { setEncoding() {}, on: (ev, fn) => { handlers.stdout = fn; }, destroy() {} },
      stderr: { setEncoding() {}, on: () => {}, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill() {},
    };
    setImmediate(() => {
      handlers.stdout?.([
        '# tests 0',
        '# pass 0',
        '# fail 0',
      ].join('\n'));
      handlers.exit?.(0, null);
    });
    return child;
  };
  const failed = [{ id: 'tests/x.test.mjs::missing', name: 'missing', file: 'tests/x.test.mjs' }];
  const result = await rerunFailed({
    argv: ['node', '--test', 'tests/x.test.mjs'],
    failed,
    kind: 'node-test',
    spawnImpl,
    timeoutMs: 5000,
    maxBytes: 4096,
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, 'rerun ran no matching tests');
});

test('rerunFailed reports ok false when pytest rerun output has no pass or fail summary', async () => {
  const spawnImpl = () => {
    const handlers = {};
    const child = {
      pid: 7070,
      stdout: { setEncoding() {}, on: (ev, fn) => { handlers.stdout = fn; }, destroy() {} },
      stderr: { setEncoding() {}, on: () => {}, destroy() {} },
      on: (ev, fn) => { handlers[ev] = fn; },
      kill() {},
    };
    setImmediate(() => {
      handlers.stdout?.('collected 0 items\n\n');
      handlers.exit?.(0, null);
    });
    return child;
  };
  const result = await rerunFailed({
    argv: ['pytest', 'tests/a.py::t'],
    failed: ['tests/a.py::t'],
    kind: 'pytest',
    spawnImpl,
    timeoutMs: 5000,
    maxBytes: 4096,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rerun ran no matching tests');
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
