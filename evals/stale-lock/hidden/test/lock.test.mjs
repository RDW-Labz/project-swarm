import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../src/lock.mjs';

async function withTmp(run) {
  const dir = await mkdtemp(join(tmpdir(), 'lock-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeLock(p, ageMs) {
  await writeFile(p, 'held');
  const t = new Date(Date.now() - ageMs);
  await utimes(p, t, t);
}

const isBusy = (e) => e.code === 'busy';

test('returns the result of fn and removes the lock', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  const out = await withLock(lock, async () => 42);
  assert.equal(out, 42);
  assert.equal(await exists(lock), false);
}));

test('lock file exists while fn runs', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  let seen = false;
  await withLock(lock, async () => {
    seen = await exists(lock);
  });
  assert.equal(seen, true);
  assert.equal(await exists(lock), false);
}));

test('fn error propagates and lock is removed', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  const boom = new Error('boom');
  await assert.rejects(withLock(lock, async () => { throw boom; }), (e) => e === boom);
  assert.equal(await exists(lock), false);
}));

test('sequential calls both run', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  let count = 0;
  await withLock(lock, async () => { count++; });
  await withLock(lock, async () => { count++; });
  assert.equal(count, 2);
}));

test('fresh lock: rejects with code busy and does not run fn', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  await makeLock(lock, 1000);
  let called = false;
  await assert.rejects(withLock(lock, async () => { called = true; }), isBusy);
  assert.equal(called, false);
  assert.equal(await exists(lock), true);
}));

test('busy lock file content is left untouched', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  await makeLock(lock, 1000);
  await assert.rejects(withLock(lock, async () => {}), isBusy);
  assert.equal(await readFile(lock, 'utf8'), 'held');
}));

test('a lock held by a running call makes a second call busy', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  let release;
  let started;
  const ready = new Promise((r) => { started = r; });
  const first = withLock(lock, () => {
    started();
    return new Promise((r) => { release = r; });
  });
  await ready;
  await assert.rejects(withLock(lock, async () => {}), isBusy);
  release();
  await first;
  assert.equal(await exists(lock), false);
}));

test('stale lock older than default staleMs is taken over', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  await makeLock(lock, 700000);
  let ran = false;
  const out = await withLock(lock, async () => { ran = true; return 'taken'; });
  assert.equal(out, 'taken');
  assert.equal(ran, true);
  assert.equal(await exists(lock), false);
}));

test('custom staleMs decides staleness', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  await makeLock(lock, 5000);
  await assert.rejects(withLock(lock, async () => {}, { staleMs: 60000 }), isBusy);
  let ran = false;
  await withLock(lock, async () => { ran = true; }, { staleMs: 1000 });
  assert.equal(ran, true);
}));

test('stale takeover still removes the lock when fn throws', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  await makeLock(lock, 700000);
  await assert.rejects(withLock(lock, async () => { throw new Error('inner'); }), /inner/);
  assert.equal(await exists(lock), false);
}));

test('a fresh lock is never overwritten by a second acquire attempt', () => withTmp(async (dir) => {
  const lock = join(dir, 'a.lock');
  await makeLock(lock, 0);
  await assert.rejects(withLock(lock, async () => {}, { staleMs: 600000 }), isBusy);
  assert.equal(await readFile(lock, 'utf8'), 'held');
}));
