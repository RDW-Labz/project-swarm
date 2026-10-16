// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BEST_OF_MAX,
  bestOfCount,
  candidateSize,
  selectBest,
  isTestFile,
  createTestChecker,
} from '../tools/best-of.mjs';

function fakeExec({ exitCode = 0, stderr = '', reject = false, onNode } = {}) {
  const calls = [];
  const exec = async (argv, options) => {
    calls.push({ argv, options });
    if (argv[0] === 'git' && argv.includes('worktree') && argv.includes('add')) {
      fs.mkdirSync(argv[argv.indexOf('--detach') + 1], { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (argv[0] === 'node') {
      if (onNode) onNode(options);
      if (reject) throw new Error('timed out');
      return { exitCode, stdout: '', stderr };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bo-root-'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'a.test.mjs'), 'hello');
  return root;
}

function addedPath(calls) {
  const add = calls.find((c) => c.argv[0] === 'git' && c.argv.includes('add'));
  return add.argv[add.argv.indexOf('--detach') + 1];
}

test('BEST_OF_MAX is 8', () => {
  assert.equal(BEST_OF_MAX, 8);
});

test('bestOfCount uses job.bestOf, clamps to 1..8, and falls back to default', () => {
  assert.equal(bestOfCount({ agent: 'rented', bestOf: 4 }, 2), 4);
  assert.equal(bestOfCount({ agent: 'rented', bestOf: 0 }, 2), 1);
  assert.equal(bestOfCount({ agent: 'rented', bestOf: 99 }, 2), 8);
  assert.equal(bestOfCount({ agent: 'rented', bestOf: 'x' }, 3), 3);
  assert.equal(bestOfCount({ agent: 'rented' }, 5), 5);
  assert.equal(bestOfCount({ agent: 'rented' }, 'bad'), 1);
  assert.equal(bestOfCount({ agent: 'local', bestOf: 6 }, 6), 1);
});

test('candidateSize sums file contents and edit replacements, treating missing arrays as empty', () => {
  assert.equal(
    candidateSize({
      files: [{ path: 'a', content: 'abc' }, { path: 'b', content: 'de' }],
      edits: [{ path: 'c', find: 'zz', replace: 'wxyz' }],
    }),
    9,
  );
  assert.equal(candidateSize({}), 0);
  assert.equal(candidateSize({ files: [{ path: 'a', content: 'abc' }] }), 3);
});

test('isTestFile recognises test paths and rejects others', () => {
  assert.equal(isTestFile('tests/x.mjs'), true);
  assert.equal(isTestFile('test/x.mjs'), true);
  assert.equal(isTestFile('src/__tests__/x.js'), true);
  assert.equal(isTestFile('src/foo.test.mjs'), true);
  assert.equal(isTestFile('src/foo.spec.ts'), true);
  assert.equal(isTestFile('src/foo_test.py'), true);
  assert.equal(isTestFile('test_foo.py'), true);
  assert.equal(isTestFile('src/latest.mjs'), false);
  assert.equal(isTestFile('src/contest/x.mjs'), false);
});

test('selectBest picks the smallest passing candidate and breaks ties by lowest index', async () => {
  const candidates = [
    { envelope: { files: [{ path: 'a', content: 'xxxxx' }] }, text: 'a' },
    { envelope: { files: [{ path: 'a', content: 'xx' }] }, text: 'b' },
    { envelope: { files: [{ path: 'a', content: 'yy' }] }, text: 'c' },
    { envelope: { files: [{ path: 'a', content: 'x' }] }, text: 'd' },
  ];
  const check = async (c, i) => ({ ok: i !== 3 ? true : false, detail: 'd' + i });
  const out = await selectBest(candidates, check);
  assert.equal(out.chosen, 1);
  assert.deepEqual(out.results.map((r) => r.index), [0, 1, 2, 3]);
  assert.equal(out.results[1].size, 2);
  assert.equal(out.results[1].ok, true);
  assert.equal(out.results[1].detail, 'd1');
});

test('selectBest falls back to the smallest null candidate and returns null when all fail', async () => {
  const cands = [
    { envelope: { files: [{ path: 'a', content: 'aaaa' }] }, text: 'a' },
    { envelope: { files: [{ path: 'a', content: 'bb' }] }, text: 'b' },
    { envelope: { files: [{ path: 'a', content: 'c' }] }, text: 'c' },
  ];
  const nulls = await selectBest(cands, async (c) => ({ ok: c.text === 'c' ? false : null }));
  assert.equal(nulls.chosen, 1);

  const allFalse = await selectBest(cands, async () => ({ ok: false }));
  assert.equal(allFalse.chosen, null);

  const empty = await selectBest([], async () => ({ ok: true }));
  assert.equal(empty.chosen, null);
  assert.deepEqual(empty.results, []);
});

test('selectBest treats a throwing check as false with its message as detail', async () => {
  const cands = [
    { envelope: {}, text: 'a' },
    { envelope: {}, text: 'b' },
  ];
  const out = await selectBest(cands, async (c, i) => {
    if (i === 0) throw new Error('boom');
    return { ok: true };
  });
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[0].detail, 'boom');
  assert.equal(out.chosen, 1);
});

test('selectBest respects the concurrency limit', async () => {
  let running = 0;
  let max = 0;
  const check = async () => {
    running++;
    max = Math.max(max, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return { ok: false };
  };
  const cands = Array.from({ length: 7 }, (_, i) => ({ envelope: {}, text: String(i) }));
  await selectBest(cands, check, { concurrency: 2 });
  assert.equal(max, 2);
});

test('createTestChecker returns ok null with no tests and runs no exec', async () => {
  const root = setupRoot();
  const { exec, calls } = fakeExec();
  const check = createTestChecker({ root, exec, fsImpl: fsp });
  const res = await check({ job: { context: ['src/x.mjs'] }, envelope: { files: [] } });
  assert.deepEqual(res, { ok: null, detail: 'no tests in context' });
  assert.equal(calls.length, 0);
});

test('createTestChecker passing run applies the envelope, uses the worktree, and removes it afterwards', async () => {
  const root = setupRoot();
  let seenSrc = null;
  let seenTest = null;
  let nodeCwd = null;
  const { exec, calls } = fakeExec({
    onNode: (options) => {
      nodeCwd = options.cwd;
      seenSrc = fs.readFileSync(path.join(options.cwd, 'src', 'x.mjs'), 'utf8');
      seenTest = fs.readFileSync(path.join(options.cwd, 'tests', 'a.test.mjs'), 'utf8');
    },
  });
  const check = createTestChecker({ root, exec, fsImpl: fsp, timeoutMs: 1234 });
  const res = await check({
    job: { context: ['tests/a.test.mjs', 'src/x.mjs'] },
    envelope: {
      files: [{ path: 'src/x.mjs', content: 'export const x = 1;' }],
      edits: [{ path: 'tests/a.test.mjs', find: 'hello', replace: 'bye' }],
    },
  });
  assert.equal(res.ok, true);
  assert.equal(seenSrc, 'export const x = 1;');
  assert.equal(seenTest, 'bye');

  const nodeCall = calls.find((c) => c.argv[0] === 'node');
  assert.deepEqual(nodeCall.argv, ['node', '--test', 'tests/a.test.mjs']);
  assert.equal(nodeCall.options.timeoutMs, 1234);
  assert.equal(nodeCall.options.cwd, nodeCwd);

  const tmp = addedPath(calls);
  assert.equal(nodeCwd, tmp);
  assert.ok(calls.some((c) => c.argv.includes('remove') && c.argv.includes('--force')));
  assert.equal(fs.existsSync(tmp), false);
});

test('createTestChecker exit code 1 gives ok false with output in detail', async () => {
  const root = setupRoot();
  const { exec } = fakeExec({ exitCode: 1, stderr: 'assertion failed here' });
  const check = createTestChecker({ root, exec, fsImpl: fsp });
  const res = await check({
    job: { context: ['tests/a.test.mjs'] },
    envelope: {},
  });
  assert.equal(res.ok, false);
  assert.ok(res.detail.includes('assertion failed here'));
});

test('createTestChecker rejects unsafe paths with ok false', async () => {
  const root = setupRoot();
  const { exec } = fakeExec();
  const check = createTestChecker({ root, exec, fsImpl: fsp });
  const res = await check({
    job: { context: ['tests/a.test.mjs'] },
    envelope: { files: [{ path: '../escape.mjs', content: 'x' }] },
  });
  assert.deepEqual(res, { ok: false, detail: 'unsafe path' });
});

test('createTestChecker reports an edit whose find text is missing as ok false', async () => {
  const root = setupRoot();
  const { exec } = fakeExec();
  const check = createTestChecker({ root, exec, fsImpl: fsp });
  const res = await check({
    job: { context: ['tests/a.test.mjs'] },
    envelope: { edits: [{ path: 'tests/a.test.mjs', find: 'nope', replace: 'y' }] },
  });
  assert.deepEqual(res, { ok: false, detail: 'edit does not apply' });
});

test('createTestChecker treats a rejecting exec as ok false with timeout detail', async () => {
  const root = setupRoot();
  const { exec, calls } = fakeExec({ reject: true });
  const check = createTestChecker({ root, exec, fsImpl: fsp });
  const res = await check({
    job: { context: ['tests/a.test.mjs'] },
    envelope: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.detail, 'timeout');
  assert.ok(calls.some((c) => c.argv.includes('remove')));
});
