// SPDX-License-Identifier: Apache-2.0
// T-0215: R-038 replay tests — version stale flags and merge queue green ordering.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createManager as createMergeQueueManager, MERGE_PR_ACTION } from '../../tools/managers/merge-queue/index.mjs';
import { mergeGreenPullRequestsInOrder } from '../../tools/managers/merge-queue/merge.mjs';
import { watchMergeQueue } from '../../tools/managers/merge-queue/watch.mjs';
import {
  createManagerActionModeSettings,
  enableManagerActionAuto,
  setManagerActionMode,
} from '../../tools/managers/modes.mjs';
import {
  assertReplayWorkspaceRoot,
  loadManagerReplayFixture,
  runManagerReplay,
} from '../../tools/managers/replay.mjs';
import '../../tools/managers/register/version-merge.mjs';
import { createManager as createVersionManager } from '../../tools/managers/version/index.mjs';
import {
  collectStaleVersionFindings,
  stalePointerFindingsFromFixture,
} from '../../tools/managers/version/stale.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..', '..');

const STALE_POINTER_FIXTURE_DIR = path.join(repoRoot, 'evals', 'managers', 'stale-pointer');

/**
 * @param {number} pr
 * @param {string} [baseRefName]
 */
function greenPrView(pr, baseRefName = 'main') {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    baseRefName,
    headRefOid: `deadbeef${String(pr).padStart(32, '0')}`.slice(0, 40),
    statusCheckRollup: [{ state: 'SUCCESS', name: 'ci' }],
  };
}

/**
 * @returns {Promise<string>}
 */
async function mkReplayWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-r038-replay-'));
  await assertReplayWorkspaceRoot(root);
  return root;
}

test('AC1: The Version manager flags machines and projects behind the current release', async () => {
  const { fixture } = await loadManagerReplayFixture(STALE_POINTER_FIXTURE_DIR);
  const releaseVersion = fixture.installVersion;
  assert.equal(releaseVersion, '1.154.0');

  const pointerFindings = stalePointerFindingsFromFixture(fixture.pointers, releaseVersion);
  assert.equal(pointerFindings.length, 1);
  assert.equal(pointerFindings[0].code, 'stale-pointer');
  assert.match(pointerFindings[0].reason, /swarm-practice/);
  assert.match(pointerFindings[0].reason, /1\.152\.0/);
  assert.match(pointerFindings[0].reason, /1\.154\.0/);
  assert.equal(pointerFindings[0].action, 'bump-pointer');

  const root = await mkReplayWorkspace();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-r038-home-'));
  try {
    await fs.mkdir(path.join(home, '.project-swarm'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.project-swarm', 'board.json'),
      JSON.stringify({ url: 'http://127.0.0.1:8765/?t=replay-token' }),
    );

    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        server: { version: '1.152.0', installedVersion: releaseVersion, stale: true },
      }),
    });

    const combined = await collectStaleVersionFindings({
      installRoot: root,
      home,
      env: {},
      fetchImpl,
      fixture: { installVersion: releaseVersion, pointers: fixture.pointers },
    });
    assert.ok(
      combined.some((row) => row.code === 'stale-pointer'),
      'project pointer lag must be flagged',
    );
    assert.ok(
      combined.some((row) => row.code === 'stale-board'),
      'stale board process must be flagged behind the install release',
    );

    const modeSettings = createManagerActionModeSettings();
    const manager = createVersionManager({
      managerId: 'version',
      root,
      modeSettings,
      trigger: 'replay',
      fixture: { installVersion: releaseVersion, pointers: fixture.pointers },
      installRoot: root,
      home,
      env: {},
      fetchImpl,
    });
    const { run, report } = await manager.run();
    assert.equal(run.status, 'ok');
    assert.ok(run.findingCount >= 2, 'version manager must emit stale project and machine findings');

    const bumpLines = (report?.lines ?? []).filter((line) => line.action === 'bump-pointer');
    assert.ok(bumpLines.length >= 1, 'journal must record bump-pointer for stale project pointers');
    assert.match(bumpLines[0].reason, /swarm-practice/);

    const replay = await runManagerReplay({
      ledgerDir: STALE_POINTER_FIXTURE_DIR,
      manager: 'version',
      createManager: ({ managerId, root: replayRoot, modeSettings: ms, trigger }) =>
        createVersionManager({
          managerId,
          root: replayRoot,
          modeSettings: ms,
          trigger,
          fixture: { installVersion: releaseVersion, pointers: fixture.pointers },
          installRoot: replayRoot,
          home,
          env: {},
          fetchImpl,
        }),
      modeSettings,
    });

    assert.equal(replay.steps.length, 1);
    assert.equal(replay.steps[0].trigger, 'replay');
    const replayBump = (replay.steps[0].journalLines ?? []).filter((line) => line.action === 'bump-pointer');
    assert.ok(replayBump.length >= 1, 'replay must reproduce stale-pointer journal lines');
    for (const code of fixture.expected?.codes ?? ['stale-pointer']) {
      assert.ok(
        (replay.steps[0].run?.findingCount ?? 0) >= 1 || replayBump.length >= 1,
        `replay must surface findings for ${code}`,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('AC2: The Merge queue manager merges green PRs in order under the standing approvals', async () => {
  const root = await mkReplayWorkspace();
  try {
    const mergeOrder = [];
    const runMerge = async (_root, prs) => {
      const pr = Number(prs[0]);
      mergeOrder.push(pr);
      if (pr === 20) {
        return { status: 'refused', reasons: ['checks regressed'] };
      }
      return { status: 'merged', repo: 'RDW-Labz/project-swarm', sha: `sha${pr}` };
    };

    const shuffled = [
      {
        job: 'T-0200',
        ticket: 'T-0200',
        pr: 21,
        order: 2,
        standingMergeApproval: true,
        prChecksGreen: true,
      },
      {
        job: 'T-0199',
        ticket: 'T-0199',
        pr: 19,
        order: 0,
        standingMergeApproval: true,
        prChecksGreen: true,
      },
      {
        job: 'T-0201',
        ticket: 'T-0201',
        pr: 20,
        order: 1,
        standingMergeApproval: true,
        prChecksGreen: true,
      },
    ];

    const outcome = await mergeGreenPullRequestsInOrder({
      root,
      greenMerges: shuffled,
      prViews: {
        19: greenPrView(19),
        20: greenPrView(20),
        21: greenPrView(21),
      },
      defaultBranch: 'main',
      runMerge,
    });

    assert.deepEqual(mergeOrder, [19, 20], 'merges must follow queue order, not input order');
    assert.equal(outcome.applied.length, 2);
    assert.equal(outcome.applied[0].status, 'merged');
    assert.equal(outcome.applied[0].pr, 19);
    assert.equal(outcome.applied[1].status, 'refused');
    assert.equal(outcome.applied[1].pr, 20);
    assert.ok(
      outcome.items.some((item) => item.code === 'green-merge-refused' && item.pr === 20),
      'a blocked merge must stop the queue',
    );
    assert.ok(!mergeOrder.includes(21), 'later PRs must not merge after a refusal');

    const watch = await watchMergeQueue({
      root,
      runId: 'mq-replay',
      state: {
        jobs: [{ id: 'T-0300' }, { id: 'T-0301' }],
        mergeQueue: {
          state: 'running',
          integrated: ['T-0300', 'T-0301'],
        },
      },
      ticketsById: {
        'T-0300': { id: 'T-0300', pr: 30 },
        'T-0301': { id: 'T-0301', pr: 31 },
      },
      prViews: {
        30: greenPrView(30),
        31: greenPrView(31),
      },
      defaultBranch: 'main',
      standingMergeApproval: true,
      mergePrMode: 'auto',
      runMerge: async (_r, prs) => {
        mergeOrder.push(Number(prs[0]));
        return { status: 'merged', repo: 'RDW-Labz/project-swarm', sha: 'merged' };
      },
    });

    assert.deepEqual(
      watch.greenMerges.map((row) => row.pr),
      [30, 31],
      'integrated jobs must become ordered green merge candidates',
    );
    assert.deepEqual(mergeOrder.slice(-2), [30, 31], 'watch auto mode must merge in queue order');

    const modeSettings = createManagerActionModeSettings();
    enableManagerActionAuto(modeSettings, 'merge-queue', MERGE_PR_ACTION);
    setManagerActionMode(modeSettings, 'merge-queue', MERGE_PR_ACTION, 'auto');

    const managerMergeOrder = [];
    const manager = createMergeQueueManager({
      managerId: 'merge-queue',
      root,
      modeSettings,
      trigger: 'replay',
      fixture: {
        standingMergeApproval: true,
        defaultBranch: 'main',
        runs: [
          {
            runId: 'wave-merge',
            state: {
              jobs: [{ id: 'T-0400' }, { id: 'T-0401' }],
              mergeQueue: {
                state: 'running',
                integrated: ['T-0400', 'T-0401'],
              },
            },
          },
        ],
        ledger: {
          version: 1,
          tickets: [
            { id: 'T-0400', pr: 40 },
            { id: 'T-0401', pr: 41 },
          ],
        },
        prViews: {
          40: greenPrView(40),
          41: greenPrView(41),
        },
        runMerge: async (_r, prs) => {
          managerMergeOrder.push(Number(prs[0]));
          return { status: 'merged', repo: 'RDW-Labz/project-swarm', sha: 'mgr' };
        },
      },
    });

    const { run, report } = await manager.run();
    assert.equal(run.status, 'ok');
    assert.deepEqual(managerMergeOrder, [40, 41], 'manager auto merge-pr must respect standing approval ordering');
    const mergedLines = (report?.lines ?? []).filter((line) => line.action === MERGE_PR_ACTION);
    assert.ok(
      mergedLines.some((line) => /merged PR #40/.test(line.reason)),
      'journal must record the first green merge',
    );
    assert.ok(
      mergedLines.some((line) => /merged PR #41/.test(line.reason)),
      'journal must record the second green merge',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
