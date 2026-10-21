// SPDX-License-Identifier: Apache-2.0
// T-0198: R-037 — `swarm managers run` for budget and lane-health against a project root.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { REPLAY_SNAPSHOT_PATHS } from '../../tools/managers/replay.mjs';
import { MANAGERS_USAGE, runManagersCommand } from '../../tools/manager-commands.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @returns {Promise<string>}
 */
async function mkProjectRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-r037-cli-'));
  const laneStoreDir = path.join(root, path.dirname(REPLAY_SNAPSHOT_PATHS.laneStore));
  await fs.mkdir(laneStoreDir, { recursive: true });
  await fs.writeFile(
    path.join(root, REPLAY_SNAPSHOT_PATHS.laneStore),
    `${JSON.stringify({ pauses: {} })}\n`,
  );
  return root;
}

test('AC1: swarm managers run budget and swarm managers run lane-health execute against a project root', async () => {
  assert.match(MANAGERS_USAGE, /swarm managers run/);

  const root = await mkProjectRoot();
  try {
    const budget = await runManagersCommand(root, ['run', 'budget']);
    assert.equal(budget.exitCode, 0, budget.stdout);
    assert.match(budget.stdout, /manager: budget/);
    assert.match(budget.stdout, /status: ok/);

    const budgetJson = JSON.parse((await runManagersCommand(root, ['run', 'budget', '--json'])).stdout);
    assert.equal(budgetJson.managerId, 'budget');
    assert.equal(budgetJson.root, root);
    assert.equal(budgetJson.run.status, 'ok');
    assert.equal(budgetJson.run.managerId, 'budget');

    const lane = await runManagersCommand(root, ['run', 'lane-health']);
    assert.equal(lane.exitCode, 0, lane.stdout);
    assert.match(lane.stdout, /manager: lane-health/);
    assert.match(lane.stdout, /status: ok/);

    const laneJson = JSON.parse((await runManagersCommand(root, ['run', 'lane-health', '--json'])).stdout);
    assert.equal(laneJson.run.status, 'ok');
    assert.equal(laneJson.run.managerId, 'lane-health');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const unsupported = await runManagersCommand(repoRoot, ['run', 'version']);
  assert.equal(unsupported.exitCode, 1);
  assert.match(unsupported.stdout, /manager-run-unsupported/);
});
