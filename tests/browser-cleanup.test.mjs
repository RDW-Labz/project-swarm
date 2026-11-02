// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trackBrowser,
  descendantPids,
  closeBrowserFully,
  assertNoLeftoverBrowser,
} from './browser/browser-cleanup.mjs';

test('trackBrowser records pid from a BrowserServer', () => {
  const server = {
    process: () => ({ pid: 4242 }),
  };
  const tracked = trackBrowser(server);
  assert.equal(tracked.pid, 4242);
  assert.equal(tracked.closed, false);
});

test('trackBrowser accepts { server, browser } and uses the server pid', () => {
  const server = {
    process: () => ({ pid: 5150 }),
  };
  const browser = { close: async () => {} };
  const tracked = trackBrowser({ server, browser });
  assert.equal(tracked.pid, 5150);
});

test('trackBrowser rejects a plain object without server.process()', () => {
  assert.throws(
    () => trackBrowser({ close: async () => {} }),
    (err) => {
      assert.match(err.message, /BrowserServer|server\.process/i);
      return true;
    },
  );
});

test('descendantPids walks a multi-level tree and ignores unrelated rows', () => {
  const list = [
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    { pid: 102, ppid: 101 },
    { pid: 200, ppid: 1 },
    { pid: 201, ppid: 200 },
    { pid: 999, ppid: 50 },
  ];
  const got = descendantPids(100, list).sort((a, b) => a - b);
  assert.deepEqual(got, [101, 102]);
});

test('closeBrowserFully closes page, context, and browser even when the first throws', async () => {
  const calls = [];
  const page = {
    close: async () => {
      calls.push('page');
      throw new Error('page close failed');
    },
  };
  const context = {
    close: async () => {
      calls.push('context');
    },
  };
  const browser = {
    close: async () => {
      calls.push('browser');
    },
  };
  const tracked = { pid: 5000 };
  await closeBrowserFully({
    pages: [page],
    context,
    browser,
    tracked,
    listProcesses: () => [],
    isAlive: () => false,
    wait: async () => {},
    killProcess: () => {},
  });
  assert.deepEqual(calls, ['page', 'context', 'browser']);
});

test('closeBrowserFully escalates SIGTERM to SIGKILL on the group when root stays alive', async () => {
  const kills = [];
  const tracked = { pid: 7000 };
  const listProcesses = () => [{ pid: 7000, ppid: 1, command: 'chromium' }];

  await closeBrowserFully({
    browser: { close: async () => {} },
    tracked,
    listProcesses,
    isAlive: (pid) => pid === 7000,
    wait: async () => {},
    killProcess: (pid, signal, opts) => {
      kills.push({ pid, signal, group: Boolean(opts?.group) });
    },
  });

  assert.ok(kills.some((k) => k.pid === 7000 && k.signal === 'SIGTERM' && k.group));
  assert.ok(kills.some((k) => k.pid === 7000 && k.signal === 'SIGKILL' && k.group));
});

test('closeBrowserFully never kills pid 0, 1, negatives, or pids outside the tracked tree', async () => {
  const kills = [];
  const tracked = { pid: 8000 };
  const listProcesses = () => [
    { pid: 0, ppid: 0, command: 'kernel' },
    { pid: 1, ppid: 0, command: 'init' },
    { pid: 8000, ppid: 1, command: 'browser-root' },
    { pid: 8001, ppid: 8000, command: 'browser-child' },
    { pid: 9000, ppid: 1, command: 'other-app' },
  ];

  await closeBrowserFully({
    browser: { close: async () => {} },
    tracked,
    listProcesses,
    isAlive: (pid) => [8000, 8001, 9000, 0, 1, -5].includes(pid),
    wait: async () => {},
    killProcess: (pid, signal, opts) => {
      kills.push({ pid, signal, group: Boolean(opts?.group) });
    },
  });

  const killedPids = kills.map((k) => k.pid);
  assert.ok(!killedPids.includes(0));
  assert.ok(!killedPids.includes(1));
  assert.ok(!killedPids.some((p) => p < 0));
  assert.ok(!killedPids.includes(9000));
  assert.ok(killedPids.includes(8000));
  assert.ok(killedPids.includes(8001));
});

test('assertNoLeftoverBrowser throws naming leftover pid and passes when none alive', () => {
  const listProcesses = () => [
    { pid: 6000, ppid: 1, command: 'parent-browser' },
    { pid: 6001, ppid: 6000, command: 'child-renderer' },
  ];
  const tracked = { pid: 6000 };

  assert.throws(
    () =>
      assertNoLeftoverBrowser(tracked, {
        listProcesses,
        isAlive: (pid) => pid === 6001,
      }),
    (err) => {
      assert.match(err.message, /6001/);
      assert.match(err.message, /child-renderer/);
      return true;
    },
  );

  assertNoLeftoverBrowser(tracked, {
    listProcesses,
    isAlive: () => false,
  });
});

test('closeBrowserFully is safe to call twice', async () => {
  let closeCount = 0;
  const tracked = { pid: 7500 };
  const browser = {
    close: async () => {
      closeCount += 1;
    },
  };
  const deps = {
    browser,
    tracked,
    listProcesses: () => [],
    isAlive: () => false,
    wait: async () => {},
    killProcess: () => {},
  };
  await closeBrowserFully(deps);
  await closeBrowserFully(deps);
  assert.equal(closeCount, 2);
});
