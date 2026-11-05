// SPDX-License-Identifier: Apache-2.0
// macOS answers EPERM (not ESRCH) for a process group whose only members are exited, unreaped
// zombies. stopChild must treat that short window as "gone", and still report a real EPERM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { stopChild } from '../tools/swarm.mjs';

const eperm = () => Object.assign(new Error('denied'), { code: 'EPERM' });
const esrch = () => Object.assign(new Error('gone'), { code: 'ESRCH' });

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('a short EPERM after the leader exits (zombie-only group) is a clean stop', async () => {
  const child = fakeChild(), calls = [];
  let probes = 0;
  const pending = stopChild(child, { killImpl: (target, signal) => {
    calls.push(signal);
    if (signal === 0) { probes += 1; if (probes <= 2) throw eperm(); throw esrch(); }
  } });
  child.exitCode = 0;
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.error, null);
  assert.deepEqual(calls, ['SIGTERM', 0, 0, 0]);
});

test('a short EPERM on the first SIGTERM is retried, then a clean stop', async () => {
  const child = fakeChild(), calls = [];
  const result = await stopChild(child, { killImpl: (target, signal) => {
    calls.push(signal);
    if (calls.length === 1) throw eperm();
    throw esrch();
  } });
  assert.equal(result.error, null);
  assert.deepEqual(calls, ['SIGTERM', 'SIGTERM']);
});

test('a live group after a short EPERM still gets SIGKILL', async () => {
  const child = fakeChild(), calls = [];
  let killed = false;
  const result = await stopChild(child, { killImpl: (target, signal) => {
    calls.push(signal);
    if (killed) throw esrch();
    if (signal === 'SIGKILL') { killed = true; return; }
    if (signal === 0 && calls.filter(call => call === 0).length === 1) throw eperm();
  } });
  child.emit('close', 0);
  assert.equal(result.error, null);
  assert.ok(calls.includes('SIGKILL'), `no SIGKILL in ${JSON.stringify(calls)}`);
});

test('an EPERM that outlasts the grace window is still reported', async () => {
  const child = fakeChild();
  let clock = 0;
  const result = await stopChild(child, { epermGraceMs: 50, now: () => (clock += 20), killImpl: () => { throw eperm(); } });
  assert.match(result.error, /Owned worker cleanup failed \(EPERM\) while sending SIGTERM/);
});

test('real process groups with a killed background child stop cleanly', { skip: process.platform === 'win32' }, async () => {
  // Before the fix about 1 in 4 of these hit EPERM on macOS while launchd reaped the zombie.
  for (let index = 0; index < 20; index++) {
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 0.05'], { detached: true, stdio: 'ignore' });
    await new Promise(resolve => child.once('spawn', resolve));
    await new Promise(resolve => child.once('exit', resolve));
    const result = await stopChild(child);
    assert.equal(result.error, null, `run ${index}: ${result.error}`);
  }
});
