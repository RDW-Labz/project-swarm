import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireChiefLock, releaseChiefLock, startChief } from '../tools/chief-lock.mjs';

const on = { chief_orchestrator: true };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chief-lock-'));
}

test('flag off by default: no lock is taken', () => {
  const dir = tmpDir();
  const result = acquireChiefLock({ dir, config: {} });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, 'flag-off');
  assert.equal(fs.existsSync(path.join(dir, 'chief.lock.json')), false);
});

test('flag must be exactly true: string value stays off', () => {
  const dir = tmpDir();
  const result = acquireChiefLock({ dir, config: { chief_orchestrator: 'true' } });
  assert.equal(result.reason, 'flag-off');
});

test('AC1: starting a second chief exits non-zero and leaves the first chief unchanged', () => {
  const dir = tmpDir();
  const first = acquireChiefLock({ dir, config: on, pid: process.pid, host: os.hostname(), isAlive: () => true });
  assert.equal(first.acquired, true);
  const lockFile = path.join(dir, 'chief.lock.json');
  const before = fs.readFileSync(lockFile, 'utf8');
  const codes = [];
  const logs = [];
  const second = startChief({ dir, config: on, exit: (code) => codes.push(code), log: (msg) => logs.push(msg) });
  assert.equal(second.started, false);
  assert.equal(second.reason, 'held');
  assert.deepEqual(codes, [1]);
  assert.equal(logs.length, 1);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), before);
});

test('a lock held by a live process is never taken over', () => {
  const dir = tmpDir();
  acquireChiefLock({ dir, config: on, pid: 4242, host: os.hostname(), isAlive: () => true });
  const result = acquireChiefLock({ dir, config: on, pid: 5555, host: os.hostname(), isAlive: () => true });
  assert.equal(result.acquired, false);
  assert.equal(result.owner.pid, 4242);
});

test('a stale lock from a dead process on this host is cleared', () => {
  const dir = tmpDir();
  acquireChiefLock({ dir, config: on, pid: 4242, host: os.hostname(), isAlive: () => true });
  const result = acquireChiefLock({ dir, config: on, pid: 5555, host: os.hostname(), isAlive: () => false });
  assert.equal(result.acquired, true);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, 'chief.lock.json'), 'utf8'));
  assert.equal(owner.pid, 5555);
});

test('a lock from another host is not cleared even if its pid looks dead', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'chief.lock.json'), JSON.stringify({ pid: 4242, host: 'elsewhere', at: 'x' }));
  const result = acquireChiefLock({ dir, config: on, pid: 5555, host: os.hostname(), isAlive: () => false });
  assert.equal(result.acquired, false);
  assert.equal(result.owner.host, 'elsewhere');
});

test('release removes the lock only when this process owns it', () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, 'chief.lock.json');
  acquireChiefLock({ dir, config: on, pid: 4242, host: os.hostname(), isAlive: () => true });
  releaseChiefLock({ dir, pid: 9999 });
  assert.equal(fs.existsSync(lockFile), true);
  releaseChiefLock({ dir, pid: 4242 });
  assert.equal(fs.existsSync(lockFile), false);
});

test('startChief with the flag on and no chief running starts and does not exit', () => {
  const dir = tmpDir();
  const codes = [];
  const started = startChief({ dir, config: on, exit: (code) => codes.push(code), log: () => {} });
  assert.equal(started.started, true);
  assert.equal(fs.existsSync(started.lockFile), true);
  assert.deepEqual(codes, []);
});
