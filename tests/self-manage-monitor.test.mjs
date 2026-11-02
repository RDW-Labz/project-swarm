// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { monitorLanesOnce } from '../tools/self-manage/monitor.mjs';
import { readLaneHealth, laneHealthStatePath } from '../tools/lane-health.mjs';

const LANE_ENTRY_KEYS = new Set([
  'state',
  'reason',
  'checkedAt',
  'since',
  'consecutiveOk',
  'consecutiveBad',
  'flaps',
  'backoffUntil',
  'requiredOkStreak',
  'probation',
  'lastJobOk',
  'lastJobId',
]);

function createRecordingFetch() {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body;
    calls.push({ method, url: String(url), body });
    return { ok: true, status: 200, body: { cancel: async () => {} } };
  };
  return { impl, calls };
}

function createRecordingExec() {
  const calls = [];
  const impl = async (command, args, opts) => {
    calls.push({ command, args: [...args], opts });
    return { stdout: '1.0.0', stderr: '' };
  };
  return { impl, calls };
}

function assertReadLaneHealthShape(snapshot) {
  assert.equal(typeof snapshot.version, 'number');
  assert.ok(snapshot.lanes && typeof snapshot.lanes === 'object' && !Array.isArray(snapshot.lanes));
  assert.ok(snapshot.updatedAt === null || typeof snapshot.updatedAt === 'string');
}

function assertLaneEntryShape(entry) {
  assert.ok(entry && typeof entry === 'object');
  for (const key of Object.keys(entry)) {
    assert.ok(LANE_ENTRY_KEYS.has(key), `unexpected lane entry field: ${key}`);
  }
  for (const key of LANE_ENTRY_KEYS) {
    assert.ok(key in entry, `missing lane entry field: ${key}`);
  }
  assert.ok(['healthy', 'degraded', 'down', 'paused'].includes(entry.state));
  assert.equal(typeof entry.reason, 'string');
}

test('monitorLanesOnce: baseUrl probe uses GET /v1/models only (no POST, no body)', async t => {
  const { impl, calls } = createRecordingFetch();
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sm-mon-fetch-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const lane = 'httpProbeLane';
  const config = {
    lanes: {
      [lane]: { baseUrl: 'https://example.invalid/api' },
    },
  };

  const snapshot = await monitorLanesOnce({
    lanes: [lane],
    config,
    env,
    home,
    now: () => 1_700_000_000_000,
    fetch: impl,
    exec: async () => {
      throw new Error('exec must not run for baseUrl lane');
    },
  });

  assert.ok(calls.length >= 1, 'expected at least one fetch call');
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.notEqual(call.method, 'POST');
    assert.notEqual(call.method, 'PUT');
    assert.ok(call.url.endsWith('/v1/models'), `url must end with /v1/models: ${call.url}`);
    assert.ok(!call.url.includes('/v1/chat/completions'));
    assert.ok(!call.url.includes('completions'));
    assert.equal(call.body, undefined);
  }

  assertReadLaneHealthShape(snapshot);
  assert.ok(snapshot.lanes[lane]);
  assertLaneEntryShape(snapshot.lanes[lane]);

  const disk = await readLaneHealth({ home, env });
  assert.deepEqual(Object.keys(snapshot), Object.keys(disk));
  assert.equal(snapshot.version, disk.version);
  assert.equal(snapshot.updatedAt, disk.updatedAt);
  assert.ok(await fs.stat(laneHealthStatePath(home, env)));
});

test('monitorLanesOnce: CLI lane probe uses --version only (no prompt/task args)', async t => {
  const { impl, calls } = createRecordingExec();
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'sm-mon-exec-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const lane = 'cliProbeLane';
  const config = {
    lanes: {
      [lane]: { command: '/usr/bin/fake-agent-cli' },
    },
  };

  const snapshot = await monitorLanesOnce({
    lanes: [lane],
    config,
    env,
    home,
    now: () => 1_700_000_001_000,
    exec: impl,
    fetch: async () => {
      throw new Error('fetch must not run for command lane');
    },
  });

  assert.ok(calls.length >= 1, 'expected at least one exec call');
  for (const call of calls) {
    assert.equal(call.command, '/usr/bin/fake-agent-cli');
    assert.deepEqual(call.args, ['--version']);
    assert.ok(!call.args.some(arg => typeof arg === 'string' && /prompt|task|completion/i.test(arg)));
  }

  assertReadLaneHealthShape(snapshot);
  assert.ok(snapshot.lanes[lane]);
  assertLaneEntryShape(snapshot.lanes[lane]);
});
