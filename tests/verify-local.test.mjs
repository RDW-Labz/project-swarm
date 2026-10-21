// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { validateVerifyConfig } from '../tools/verify-config.mjs';
import { runLocalVerify, prepareScratchVerify } from '../tools/verify-local.mjs';

const baseLocal = {
  agent: 'local',
  command: ['node', '--version'],
};

test('validateVerifyConfig accepts local with command', () => {
  const r = validateVerifyConfig(baseLocal);
  assert.equal(r.ok, true);
  assert.equal(r.value.agent, 'local');
  assert.equal(r.value.timeoutMs, 600_000);
  assert.deepEqual(r.value.command, ['node', '--version']);
});

test('validateVerifyConfig refuses local without command', () => {
  const r = validateVerifyConfig({ agent: 'local' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('verify.command')));
});

test('validateVerifyConfig refuses local with empty argv', () => {
  const r = validateVerifyConfig({ agent: 'local', command: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('verify.command')));
});

test('validateVerifyConfig refuses local with non-array command', () => {
  const r = validateVerifyConfig({ agent: 'local', command: 'npm test' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('verify.command')));
});

test('validateVerifyConfig refuses unknown agent with updated message', () => {
  const r = validateVerifyConfig({ agent: 'gpt', command: ['npm', 'test'] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e === 'verify.agent must be codex, claude, local or none'));
});

function fakeChild({ onSpawn, exitCode, stdout = '', stderr = '', error, hang = false }) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    onSpawn?.(child);
    if (error) {
      setImmediate(() => child.emit('error', error));
      return child;
    }
    if (hang) return child;
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('exit', exitCode);
    });
    return child;
  };
}

test('runLocalVerify returns pass on exit 0', async () => {
  const r = await runLocalVerify({
    worktree: '/tmp/wt',
    command: ['node', '-e', 'process.exit(0)'],
    spawnImpl: fakeChild({ exitCode: 0 }),
    now: () => 1000,
  });
  assert.equal(r.status, 'pass');
  assert.equal(r.exitCode, 0);
});

test('runLocalVerify returns fail on exit 1 with tail', async () => {
  const r = await runLocalVerify({
    worktree: '/tmp/wt',
    command: ['node', '-e', 'process.exit(1)'],
    spawnImpl: fakeChild({ exitCode: 1, stderr: 'tests failed\n' }),
    now: () => 0,
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.exitCode, 1);
  assert.ok(r.tail.includes('tests failed'));
});

test('runLocalVerify returns error on spawn failure', async () => {
  const r = await runLocalVerify({
    worktree: '/tmp/wt',
    command: ['missing-binary'],
    spawnImpl: fakeChild({ error: new Error('ENOENT') }),
    now: () => 0,
  });
  assert.equal(r.status, 'error');
});

test('runLocalVerify returns error on timeout', async () => {
  let killed = false;
  const r = await runLocalVerify({
    worktree: '/tmp/wt',
    command: ['node'],
    timeoutMs: 50,
    spawnImpl: fakeChild({
      hang: true,
      onSpawn: (child) => {
        child.kill = () => {
          killed = true;
          child.emit('exit', null);
        };
      },
    }),
    now: (() => {
      let t = 0;
      return () => {
        t += 100;
        return t;
      };
    })(),
  });
  assert.equal(r.status, 'error');
  assert.equal(killed, true);
});

test('runLocalVerify masks token-looking string in tail', async () => {
  const secret = ['sk', '-', 'ant', '-', 'api03', '-'].join('') + 'a'.repeat(24);
  const r = await runLocalVerify({
    worktree: '/tmp/wt',
    command: ['node'],
    spawnImpl: fakeChild({ exitCode: 1, stdout: `failed with ${secret}\n` }),
    now: () => 0,
  });
  assert.ok(!r.tail.includes(secret));
  assert.match(r.tail, /\[redacted\]/);
});

test('prepareScratchVerify cleans up on pass and returns verify shape', async () => {
  let cleaned = false;
  const runLocal = async () => ({
    status: 'pass',
    exitCode: 0,
    durationMs: 12,
    tail: 'ok',
  });
  const out = await prepareScratchVerify({
    root: '/proj',
    outputs: ['a.mjs'],
    integrateIntoScratch: async () => ({
      worktree: '/scratch',
      cleanup: async () => {
        cleaned = true;
      },
    }),
    runLocal,
  });
  assert.equal(cleaned, true);
  assert.deepEqual(out, {
    verify: { status: 'pass', mode: 'local', exitCode: 0, durationMs: 12, tail: 'ok' },
  });
});

test('prepareScratchVerify cleans up on fail', async () => {
  let cleaned = false;
  const out = await prepareScratchVerify({
    root: '/proj',
    outputs: [],
    integrateIntoScratch: async () => ({
      worktree: '/scratch',
      cleanup: async () => {
        cleaned = true;
      },
    }),
    runLocal: async () => ({
      status: 'fail',
      exitCode: 2,
      durationMs: 5,
      tail: 'nope',
    }),
  });
  assert.equal(cleaned, true);
  assert.equal(out.verify.status, 'fail');
  assert.equal(out.verify.mode, 'local');
});
