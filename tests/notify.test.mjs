// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingNotifications, macNotify } from '../tools/notify.mjs';

const NOON = new Date(2024, 4, 10, 12).getTime();
const NEXT_DAY = new Date(2024, 4, 11, 12).getTime();

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (original) Object.defineProperty(process, 'platform', original);
  });
}

test('item below threshold produces no message', () => {
  const r = pendingNotifications([{ id: 'R:a', unblocks: 19 }], null, { now: NOON });
  assert.deepEqual(r.messages, ['Needs you: 1 items, unblocking 19 jobs']);
  assert.deepEqual(r.notified.items, []);
});

test('item at threshold is notified', () => {
  const r = pendingNotifications([{ id: 'R:a', unblocks: 20 }], null, { now: NOON });
  assert.ok(r.messages.some(m => m.includes('R:a (20 jobs)')));
  assert.deepEqual(r.notified.items, ['R:a']);
});

test('custom threshold is honoured', () => {
  const r = pendingNotifications([{ id: 'x', unblocks: 3 }], null, { now: NOON, threshold: 3 });
  assert.ok(r.messages.some(m => m.includes('x (3 jobs)')));
});

test('several new items go out as one grouped message', () => {
  const r = pendingNotifications([{ id: 'A', unblocks: 25 }, { id: 'B', unblocks: 30 }], null, { now: NOON });
  const grouped = r.messages.filter(m => m.includes('A (25 jobs)') || m.includes('B (30 jobs)'));
  assert.equal(grouped.length, 1);
  assert.ok(grouped[0].includes('A (25 jobs)') && grouped[0].includes('B (30 jobs)'));
});

test('zero-unblock items never produce a message, even with threshold 0', () => {
  const r = pendingNotifications([{ id: 'Z', unblocks: 0 }], null, { now: NOON, threshold: 0 });
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.notified, { items: [], digestDay: null });
});

test('notified items are not repeated', () => {
  const r = pendingNotifications([{ id: 'A', unblocks: 25 }], { items: ['A'], digestDay: '2024-05-10' }, { now: NOON });
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.notified.items, ['A']);
});

test('digest is sent once per local day', () => {
  const items = [{ id: 'A', unblocks: 5 }, { id: 'B', unblocks: 7 }];
  const first = pendingNotifications(items, null, { now: NOON });
  assert.ok(first.messages.includes('Needs you: 2 items, unblocking 12 jobs'));
  assert.equal(first.notified.digestDay, '2024-05-10');
  const second = pendingNotifications(items, first.notified, { now: NOON });
  assert.equal(second.messages.filter(m => m.startsWith('Needs you: 2 items')).length, 0);
  const nextDay = pendingNotifications(items, first.notified, { now: NEXT_DAY });
  assert.ok(nextDay.messages.includes('Needs you: 2 items, unblocking 12 jobs'));
  assert.equal(nextDay.notified.digestDay, '2024-05-11');
});

test('no digest when there are no items', () => {
  const r = pendingNotifications([], null, { now: NOON });
  assert.deepEqual(r.messages, []);
  assert.equal(r.notified.digestDay, null);
});

test('no digest when the items unblock nothing', () => {
  const r = pendingNotifications([{ id: 'Z', unblocks: 0 }], null, { now: NOON });
  assert.deepEqual(r.messages, []);
  assert.equal(r.notified.digestDay, null);
});

test('pendingNotifications does not mutate its inputs', () => {
  const notified = { items: ['A'], digestDay: null };
  pendingNotifications([{ id: 'B', unblocks: 30 }], notified, { now: NOON });
  assert.deepEqual(notified, { items: ['A'], digestDay: null });
});

test('macNotify returns false and runs nothing off darwin', async () => {
  let called = false;
  await withPlatform('linux', async () => {
    const ok = await macNotify('hi', { run: async () => { called = true; } });
    assert.equal(ok, false);
  });
  assert.equal(called, false);
});

test('macNotify on darwin passes argv only and escapes the message', async () => {
  const calls = [];
  await withPlatform('darwin', async () => {
    const ok = await macNotify('say "hi" \\ now', { run: async (file, args) => { calls.push({ file, args }); } });
    assert.equal(ok, true);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  assert.ok(Array.isArray(calls[0].args));
  assert.ok(calls[0].args.every(arg => typeof arg === 'string'));
  assert.ok(!calls[0].args.some(arg => arg.includes('sh -c')));
  assert.ok(calls[0].args[1].includes('say \\"hi\\" \\\\ now'));
});

test('macNotify returns false when the runner fails', async () => {
  await withPlatform('darwin', async () => {
    const ok = await macNotify('x', { run: async () => { throw new Error('boom'); } });
    assert.equal(ok, false);
  });
});
