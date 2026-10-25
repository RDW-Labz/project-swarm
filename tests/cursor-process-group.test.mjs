import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { execute, killCursorProcessGroup } from '../tools/swarm/core-41.mjs';

const envelope = JSON.stringify({ files_changed: [], notes: [] });
const cursorLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: envelope });

function fakeCursorChild(pid = 6000) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end() {}, on() {}, destroy() {} };
  return child;
}

function cursorJob(overrides = {}) {
  return { agent: 'cursor', model: 'composer-2.5', context: [], outputs: [], timeoutMs: 200, ...overrides };
}

const launch = { profile: '/repo/sandbox.sb', bin: '/opt/cursor/cursor-agent', worktree: '/repo/wt', env: {} };

function spawnCursorChild(child, { complete = false, hang = false } = {}) {
  return () => {
    if (complete) {
      setTimeout(() => {
        child.stdout.write(`${cursorLine}\n`);
        child.emit('close', 0);
      }, 5);
    } else if (!hang) {
      setTimeout(() => child.emit('close', 0), 5);
    }
    return child;
  };
}

test('killCursorProcessGroup refuses invalid pids and never signals', async () => {
  let called = false;
  const killImpl = () => { called = true; };
  assert.deepEqual(await killCursorProcessGroup(0, { killImpl, sleep: () => Promise.resolve() }), { refused: true, error: null });
  assert.deepEqual(await killCursorProcessGroup(1, { killImpl, sleep: () => Promise.resolve() }), { refused: true, error: null });
  assert.equal(called, false);
});

test('killCursorProcessGroup refuses our own process group', async () => {
  let called = false;
  assert.deepEqual(await killCursorProcessGroup(process.pid, { killImpl: () => { called = true; }, sleep: () => Promise.resolve() }), { refused: true, error: null });
  assert.equal(called, false);
});

test('killCursorProcessGroup treats an already-dead group as success', async () => {
  const calls = [];
  const killImpl = (target, signal) => {
    calls.push({ target, signal });
    if (signal === 'SIGTERM') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  const result = await killCursorProcessGroup(4242, { killImpl, sleep: () => Promise.resolve() });
  assert.deepEqual(result, { refused: false, error: null });
  assert.deepEqual(calls, [{ target: -4242, signal: 'SIGTERM' }]);
});

test('killCursorProcessGroup escalates to SIGKILL only when the group survives SIGTERM', async () => {
  const calls = [];
  const killImpl = (target, signal) => { calls.push({ target, signal }); };
  await killCursorProcessGroup(5000, { killImpl, sleep: () => Promise.resolve() });
  assert.deepEqual(calls, [
    { target: -5000, signal: 'SIGTERM' },
    { target: -5000, signal: 0 },
    { target: -5000, signal: 'SIGKILL' },
  ]);
});

test('killCursorProcessGroup skips SIGKILL when SIGTERM already cleared the group', async () => {
  const calls = [];
  const killImpl = (target, signal) => {
    calls.push({ target, signal });
    if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  await killCursorProcessGroup(5001, { killImpl, sleep: () => Promise.resolve() });
  assert.deepEqual(calls, [
    { target: -5001, signal: 'SIGTERM' },
    { target: -5001, signal: 0 },
  ]);
});

test('execute cursor jobs kill the recorded group on complete', async () => {
  const child = fakeCursorChild(6100);
  const groups = [];
  const result = await execute(cursorJob({ timeoutMs: 5000 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { complete: true }),
    cursor: launch,
    killGroupImpl: pid => { groups.push(pid); return Promise.resolve({ refused: false, error: null }); },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(groups, [6100]);
});

function killImplEndsChild(child) {
  return (target, signal) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 0) {
      setImmediate(() => child.emit('close', null));
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }
  };
}

test('execute cursor jobs kill the recorded group on timeout', async () => {
  const child = fakeCursorChild(6200);
  const groups = [];
  const result = await execute(cursorJob({ timeoutMs: 30 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { hang: true }),
    cursor: launch,
    killImpl: killImplEndsChild(child),
    killGroupImpl: pid => { groups.push(pid); return Promise.resolve({ refused: false, error: null }); },
  });
  assert.equal(result.status, 'timeout');
  assert.deepEqual(groups, [6200]);
});

test('execute cursor jobs kill the recorded group on cancel', async () => {
  const child = fakeCursorChild(6300);
  const groups = [];
  const controller = new AbortController();
  const pending = execute(cursorJob({ timeoutMs: 5000 }), '/tmp', 'go', {
    spawnImpl: spawnCursorChild(child, { hang: true }),
    cursor: launch,
    signal: controller.signal,
    killImpl: killImplEndsChild(child),
    killGroupImpl: pid => { groups.push(pid); return Promise.resolve({ refused: false, error: null }); },
  });
  setTimeout(() => controller.abort(), 20);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(groups, [6300]);
});
