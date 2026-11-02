// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSelfManageCommand, USAGE } from '../tools/swarm-cli-selfmanage.mjs';

const root = '/tmp/swarm-selfmanage-test';

const fakeSnapshot = {
  version: 1,
  lanes: {
    anthropic: { state: 'healthy', reason: 'probe ok' },
    claude: { state: 'degraded', reason: 'elevated latency' },
    codex: { state: 'down', reason: 'probe failed' },
    cursor: { state: 'paused', reason: 'awaiting first check' },
  },
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('lanes prints one line per lane with state and reason', async () => {
  const res = await runSelfManageCommand(root, ['lanes'], {
    readLaneHealth: async () => fakeSnapshot,
  });
  assert.equal(res.exitCode, 0);
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'anthropic\thealthy\tprobe ok');
  assert.equal(lines[1], 'claude\tdegraded\televated latency');
  assert.equal(lines[2], 'codex\tdown\tprobe failed');
  assert.equal(lines[3], 'cursor\tpaused\tawaiting first check');
});

test('unknown subcommand returns USAGE and exitCode 1', async () => {
  const res = await runSelfManageCommand(root, ['status'], {
    readLaneHealth: async () => fakeSnapshot,
  });
  assert.equal(res.stdout, USAGE);
  assert.equal(res.exitCode, 1);
});

test('lanes with extra trailing args is rejected with USAGE', async () => {
  const res = await runSelfManageCommand(root, ['lanes', '--verbose'], {
    readLaneHealth: async () => fakeSnapshot,
  });
  assert.equal(res.stdout, USAGE);
  assert.equal(res.exitCode, 1);
});
