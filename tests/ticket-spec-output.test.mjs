// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCheckArgv } from '../tools/init.mjs';
import {
  firstFailingTest,
  formatTicketSpecRetryNote,
  redactNote,
  runTicketSpec,
  RETRY_NOTE_MAX,
  TICKET_SPEC_RETRY_TAIL,
} from '../tools/scope-commands.mjs';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-spec-output-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test('runCheckArgv timeout error carries partial stdout and stderr', async t => {
  const cwd = await tmp(t);
  const script = [
    "process.stdout.write('stdout-partial');",
    "process.stderr.write('stderr-partial');",
    "setTimeout(() => {}, 60000);",
  ].join('');
  let caught;
  try {
    await runCheckArgv([process.execPath, '-e', script], { cwd, timeoutMs: 400 });
    assert.fail('expected timeout');
  } catch (error) {
    caught = error;
  }
  assert.match(caught.message, /timed out after 400 ms/);
  assert.match(String(caught.stdout), /stdout-partial/);
  assert.match(String(caught.stderr), /stderr-partial/);
});

test('runTicketSpec tail on timeout includes partial output', async t => {
  const root = await tmp(t);
  const outcome = await runTicketSpec(root, 'tests/a.test.ts', {
    profile: { verify: { command: ['npm', 'test', '--', '{tests}'] } },
    timeoutMs: 50,
    run: async () => {
      const error = new Error('timed out after 50 ms');
      error.stdout = 'partial-from-runner';
      error.stderr = 'stderr-from-runner';
      throw error;
    },
  });
  assert.equal(outcome.failed, true);
  assert.match(outcome.tail, /timed out/);
  assert.match(outcome.tail, /partial-from-runner/);
  assert.match(outcome.tail, /stderr-from-runner/);
});

test('formatTicketSpecRetryNote keeps the last 4000 characters and redacts secrets', () => {
  const marker = 'TAIL-MARKER-END';
  const tail = `${'noise line.\n'.repeat(900)}${marker}`;
  const leak = `${'z'.repeat(20)}LEAK${'z'.repeat(20)}`;
  const withSecret = `${tail}\nnot ok 1 - boom\n${leak}`;
  const note = redactNote(formatTicketSpecRetryNote('tests/long.test.ts', withSecret)).slice(0, RETRY_NOTE_MAX);
  assert.ok(note.includes(marker));
  assert.ok(!note.includes('noise line.\n'.repeat(400)));
  assert.match(note, /first failing test: boom/);
  assert.doesNotMatch(note, /LEAK/);
  assert.match(note, /\*\*\*/);
  const tailSection = note.split('; ').pop();
  assert.ok(tailSection.length <= TICKET_SPEC_RETRY_TAIL + 50);
});

test('formatTicketSpecRetryNote leaves short output unchanged', () => {
  const tail = 'Error: expected true to be false';
  assert.equal(
    formatTicketSpecRetryNote('tests/short.test.ts', tail),
    'failed checks: ticket spec tests/short.test.ts; Error: expected true to be false',
  );
});

test('firstFailingTest parses runner samples and ignores plain text', () => {
  assert.equal(firstFailingTest('not ok 3 - widget renders'), 'widget renders');
  assert.equal(
    firstFailingTest('FAILED tests/test_api.py::test_create_user'),
    'tests/test_api.py::test_create_user',
  );
  assert.equal(
    firstFailingTest(' × src/foo.test.ts > suite > rejects bad input'),
    'src/foo.test.ts > suite > rejects bad input',
  );
  assert.equal(
    firstFailingTest('FAIL tests/bar.test.js > does the thing'),
    'tests/bar.test.js > does the thing',
  );
  assert.equal(
    firstFailingTest('1) [chromium] › e2e/login.spec.ts › should sign in'),
    '1) [chromium] › e2e/login.spec.ts › should sign in',
  );
  assert.equal(firstFailingTest('plain log line\nanother line'), null);
});
