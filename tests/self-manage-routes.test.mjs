// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLanesStdout, runSelfManageCommand } from '../tools/swarm-cli-selfmanage.mjs';

const root = '/tmp/swarm-selfmanage-routes-test';

test('lanes output shows probation marker and counts when probation is active', async () => {
  const snapshot = {
    version: 1,
    lanes: {
      cursor: {
        state: 'healthy',
        reason: 'probe ok',
        probation: { active: true, checksOk: 1, jobsOk: 0, since: 1_700_000_000_000 },
      },
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const res = await runSelfManageCommand(root, ['lanes'], {
    readLaneHealth: async () => snapshot,
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout.trimEnd(), 'cursor\thealthy\tprobe ok\tprobation\t1\t0');
  assert.match(formatLanesStdout(snapshot).trimEnd(), /probation\t1\t0/);
});

test('lanes output unchanged when probation is absent or inactive', async () => {
  const noProbation = {
    lanes: {
      anthropic: { state: 'healthy', reason: 'probe ok' },
    },
  };
  assert.equal(
    formatLanesStdout(noProbation).trimEnd(),
    'anthropic\thealthy\tprobe ok',
  );

  const inactiveProbation = {
    lanes: {
      anthropic: {
        state: 'healthy',
        reason: 'probe ok',
        probation: { active: false, checksOk: 3, jobsOk: 2, since: 1 },
      },
    },
  };
  assert.equal(
    formatLanesStdout(inactiveProbation).trimEnd(),
    'anthropic\thealthy\tprobe ok',
  );
});

test('mixed lanes render probation and non-probation lines independently', () => {
  const snapshot = {
    lanes: {
      beta: {
        state: 'degraded',
        reason: 'warming up',
        probation: { active: true, checksOk: 2, jobsOk: 1, since: 1 },
      },
      alpha: { state: 'healthy', reason: 'stable' },
      gamma: {
        state: 'healthy',
        reason: 'recovering',
        probation: { active: false, checksOk: 0, jobsOk: 0, since: 1 },
      },
    },
  };
  const lines = formatLanesStdout(snapshot).trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'alpha\thealthy\tstable');
  assert.equal(lines[1], 'beta\tdegraded\twarming up\tprobation\t2\t1');
  assert.equal(lines[2], 'gamma\thealthy\trecovering');
});
