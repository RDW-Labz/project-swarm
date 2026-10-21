// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAutopilot } from '../tools/autopilot.mjs';

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-busy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function idleDeps(extra = {}) {
  return {
    readJournal: async () => [],
    loadRuns: async () => [],
    readPlan: async () => null,
    appendEvent: async () => {},
    ...extra,
  };
}

function trackBusy(deps = {}) {
  const calls = [];
  const busy = {
    begin: async () => { calls.push('begin'); },
    end: async () => { calls.push('end'); },
  };
  return { deps: { ...idleDeps(), busy, ...deps }, calls, busy };
}

test('runAutopilot calls busy begin and end once around each pass', async t => {
  const root = await tempRoot(t);
  const { deps, calls } = trackBusy();
  await runAutopilot(root, deps, { once: true, sleep: async () => {} });
  assert.deepEqual(calls, ['begin', 'end']);
});

test('runAutopilot calls busy end when a pass throws', async t => {
  const root = await tempRoot(t);
  const { deps, calls } = trackBusy();
  await assert.rejects(
    runAutopilot(root, deps, { once: true, now: () => { throw new Error('step boom'); }, sleep: async () => {} }),
    /step boom/,
  );
  assert.deepEqual(calls, ['begin', 'end']);
});

test('runAutopilot works when deps.busy is missing', async t => {
  const root = await tempRoot(t);
  const results = await runAutopilot(root, idleDeps(), { once: true, sleep: async () => {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].idle, true);
});

test('runAutopilot continues when busy begin or end throws', async t => {
  const root = await tempRoot(t);
  let pass = 0;
  const busy = {
    begin: async () => { if (pass === 0) throw new Error('begin failed'); },
    end: async () => { if (pass === 1) throw new Error('end failed'); },
  };
  const results = await runAutopilot(root, { ...idleDeps(), busy }, {
    once: false,
    maxSteps: 2,
    sleep: async () => { pass += 1; },
  });
  assert.equal(results.length, 2);
});

test('an idle pass with no actions still calls busy begin and end once', async t => {
  const root = await tempRoot(t);
  const { deps, calls } = trackBusy();
  const step = (await runAutopilot(root, deps, { once: true, sleep: async () => {} }))[0];
  assert.equal(step.idle, true);
  assert.deepEqual(calls, ['begin', 'end']);
});
