// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as swarm from '../tools/swarm.mjs';

const job = extra => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Review the supplied input.', context: ['input.txt'], outputs: [], ...extra });
const manifest = jobs => ({ version: 1, jobs });
async function put(root, file, bytes) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), bytes);
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'prompt-wild-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await put(root, 'input.txt', 'source');
  await put(root, 'tests/foo-a.test.mjs', 'x');
  await put(root, 'uncovered/a.py', 'x');
  return root;
}
const warn = (root, prompt, opts = {}) => swarm.promptPathsNotInWorkspaceWarnings(root, job({ prompt }), ['input.txt'], opts);

test('wildcard words in prose give no hit', async t => {
  const root = await fixture(t);
  for (const prompt of ['Run tests/foo-*.test.mjs now.', 'Options --ctx-* and --out-* are described.', 'Read uncovered/*.py and uncovered/**/*.py please.']) {
    assert.deepEqual(await warn(root, prompt), [], prompt);
  }
});

test('a covered tracked file followed by sentence punctuation gives no hit', async t => {
  const root = await fixture(t);
  const opts = { trackedFiles: ['tests/foo-a.test.mjs'] };
  for (const prompt of ['See tests/foo-a.test.mjs.', 'See tests/foo-a.test.mjs: it matters.', 'See (tests/foo-a.test.mjs), then stop.', 'See "tests/foo-a.test.mjs".', 'See tests/foo-a.test.mjs; done.']) {
    assert.deepEqual(await warn(root, prompt, opts), [], prompt);
  }
});

test('an uncovered existing plain path still gives a hit, with or without trailing punctuation', async t => {
  const root = await fixture(t);
  for (const prompt of ['Read uncovered/a.py carefully.', 'Read uncovered/a.py.', 'Read uncovered/a.py, then stop.']) {
    const hits = await warn(root, prompt);
    assert.equal(hits.length, 1, prompt);
    assert.match(hits[0], /prompt-path-not-in-workspace/);
    assert.match(hits[0], /exists on disk but is neither tracked/);
  }
});

test('traversal spelling is skipped by the prompt-path check, as before; the plain spelling still refuses', async t => {
  const root = await fixture(t);
  // A candidate whose spelling makes relative() throw is skipped (never a hit); only the plain spelling is reported.
  for (const prompt of ['See uncovered/../uncovered/a.py.', 'See ../uncovered/a.py.']) {
    assert.deepEqual(await warn(root, prompt), [], prompt);
  }
  assert.equal((await warn(root, 'See uncovered/a.py.')).length, 1);
  await assert.rejects(swarm.validateProject(root, manifest([job({ prompt: 'Read uncovered/a.py.' })])), /prompt-path-not-in-workspace/);
});

test('text between triple angle brackets stays ignored', async t => {
  const root = await fixture(t);
  assert.deepEqual(await warn(root, 'Note <<< uncovered/a.py >>> end.'), []);
});

test('validate passes for a prompt with a test file pattern and an option name ending in an asterisk', async t => {
  const root = await fixture(t);
  const prompt = 'Run tests/foo-*.test.mjs and describe the --ctx-* options. Then read input.txt.';
  await assert.doesNotReject(swarm.validateProject(root, manifest([job({ prompt })])));
});
