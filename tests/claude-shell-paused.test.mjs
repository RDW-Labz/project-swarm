// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerKey, claudeShellPausedProblem, assertClaudeShellNotPaused, WORKER_KEY_ENV } from '../tools/claude-shell.mjs';

const TIMEOUT = { timeout: 60000 };
const fakeKey = 'abcd1234'.repeat(4);
const pausedAnthropic = { lanes: { anthropic: { paused: true } } };
const shellPaused = { lanes: { anthropic: { paused: false }, claude: { shellPaused: true } } };

function recorder(stdout = `${fakeKey}\n`) {
  const calls = [];
  return { calls, exec: async (...args) => { calls.push(args); return { stdout }; } };
}

for (const [name, config] of [['anthropic lane paused', pausedAnthropic], ['claude.shellPaused with anthropic unpaused', shellPaused]]) {
  test(`${name}: resolveWorkerKey refuses and never touches the keychain or env key`, TIMEOUT, async () => {
    const { calls, exec } = recorder();
    await assert.rejects(
      resolveWorkerKey({ env: { [WORKER_KEY_ENV]: fakeKey }, exec, config }),
      error => error.message.startsWith('claude-shell-paused') && /paid API key/.test(error.message) && /anthropic lane is paused/.test(error.message) && error.code === 'claude-shell-paused',
    );
    assert.equal(calls.length, 0);
  });

  test(`${name}: the validation check refuses a shell job`, TIMEOUT, () => {
    assert.match(claudeShellPausedProblem(config), /^claude-shell-paused/);
    assert.throws(() => assertClaudeShellNotPaused(config), /^Error: claude-shell-paused/);
  });
}

test('the loader is injectable: a paused loaded config refuses before any key read', TIMEOUT, async () => {
  const { calls, exec } = recorder();
  await assert.rejects(resolveWorkerKey({ env: {}, exec, loadConfig: () => pausedAnthropic }), /^Error: claude-shell-paused/);
  assert.equal(calls.length, 0);
});

test('unpaused config still resolves a key via the injected exec', TIMEOUT, async () => {
  const { calls, exec } = recorder();
  const key = await resolveWorkerKey({ env: {}, exec, config: { lanes: { anthropic: { paused: false }, claude: { shellPaused: false } } } });
  assert.equal(key, fakeKey);
  assert.equal(calls.length, 1);
  assert.equal(claudeShellPausedProblem({}), null);
  assert.equal(claudeShellPausedProblem(undefined), null);
});

test('a plain (non-shell) claude job is not subject to the shell pause check', TIMEOUT, () => {
  // The check is only called for shell jobs; paused config must not make it fire on its own for anything else.
  const job = { id: 'plain', agent: 'claude', model: 'sonnet' };
  const check = j => (j.shell === true ? claudeShellPausedProblem(pausedAnthropic) : null);
  assert.equal(check(job), null);
  assert.match(check({ ...job, shell: true }), /^claude-shell-paused/);
});
