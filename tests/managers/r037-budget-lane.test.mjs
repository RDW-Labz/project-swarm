// SPDX-License-Identifier: Apache-2.0
// T-0197: R-037 replay tests — budget cap warning and lane-down reroute (eval fixtures).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createManager as createBudgetManager } from '../../tools/managers/budget/index.mjs';
import { WARN_CAP_ACTION, watchProjectDailySpend } from '../../tools/managers/budget/spend-watch.mjs';
import { runPreRunLaneProbe } from '../../tools/managers/lane-health/probe.mjs';
import {
  PAUSE_LANE_ACTION,
  REROUTE_TICKETS_ACTION,
} from '../../tools/managers/lane-health/reroute.mjs';
import {
  createManagerActionModeSettings,
  enableManagerActionAuto,
  setManagerActionMode,
} from '../../tools/managers/modes.mjs';
import {
  assertReplayWorkspaceRoot,
  loadManagerReplayFixture,
  materializeManagerReplayFixture,
  REPLAY_SNAPSHOT_PATHS,
  runManagerReplay,
} from '../../tools/managers/replay.mjs';
import { registerBudgetLaneManagerHooks } from '../../tools/managers/register/budget-lane.mjs';
import { createManager as createLaneHealthManager } from '../../tools/managers/lane-health/index.mjs';
import { parseLedgerRow } from '../../tools/spend.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..', '..');

const S11_FIXTURE_DIR = path.join(repoRoot, 'evals', 'managers', 's11-budget-cap');
const S13_FIXTURE_DIR = path.join(repoRoot, 'evals', 'managers', 's13-lane-down');

/** Manifest lane models so routeJob can pick anthropic when codex/cursor are down (isolated test env). */
const S13_REROUTE_MANIFEST = Object.freeze({
  lanes: {
    anthropic: { model: 'claude-haiku-5-5', concurrency: 4 },
    cursor: { model: 'composer', concurrency: 2 },
    codex: { model: 'gpt-5', concurrency: 2 },
  },
});

registerBudgetLaneManagerHooks();

/**
 * @param {string} markdown
 * @param {number} maxUsd
 */
function truncateUsageLedgerToSpend(markdown, maxUsd) {
  const lines = String(markdown).split('\n');
  const headerEnd = lines.findIndex(line => line.startsWith('| ---'));
  if (headerEnd < 0) throw new Error('usage-ledger-header-missing');
  const header = lines.slice(0, headerEnd + 1);
  /** @type {string[]} */
  const rows = [];
  let total = 0;
  for (const line of lines.slice(headerEnd + 1)) {
    if (!line.trim()) continue;
    const row = parseLedgerRow(line);
    if (!row) continue;
    const paid = /^\$(\d+(?:\.\d+)?)/.exec(row.cost);
    if (!paid) continue;
    const amount = Number(paid[1]);
    if (total + amount > maxUsd + 1e-6) break;
    total += amount;
    rows.push(line);
  }
  return `${header.join('\n')}\n${rows.join('\n')}\n`;
}

/**
 * @returns {Promise<string>}
 */
async function mkReplayWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-r037-replay-'));
  await assertReplayWorkspaceRoot(root);
  return root;
}

test('AC1: Budget manager watches billed spend per project and day and warns before a cap', async () => {
  const { fixture } = await loadManagerReplayFixture(S11_FIXTURE_DIR);
  const root = await mkReplayWorkspace();
  try {
    await materializeManagerReplayFixture(fixture, root);

    const ledgerPath = path.join(root, 'docs', 'state', 'usage-ledger.md');
    const fullLedger = fixture.files['docs/state/usage-ledger.md'];
    const day = '2026-09-12';
    const wave3At = '2026-09-12T20:30:00.000Z';
    const wave3Usd = 36.4;

    await fs.writeFile(ledgerPath, truncateUsageLedgerToSpend(fullLedger, wave3Usd));

    const rollup = await watchProjectDailySpend(root, { day });
    assert.equal(rollup.usd, wave3Usd, 'rollup must follow usage-ledger rows for the scope day');
    assert.match(String(rollup.source), /usage-ledger/, 'production path reads docs/state/usage-ledger.md');
    assert.equal(rollup.watch.phase, 'warn', 'spend must cross warn threshold before hard cap');
    assert.equal(rollup.capUsd, fixture.projectCap);

    const modeSettings = createManagerActionModeSettings();
    const manager = createBudgetManager({
      managerId: 'budget',
      root,
      modeSettings,
      trigger: 'wave',
      now: () => new Date(wave3At).getTime(),
    });
    const { run, report } = await manager.run({ now: () => new Date(wave3At).getTime() });
    assert.equal(run.status, 'ok');
    assert.ok(run.findingCount >= 1, 'manager must emit warn-cap findings when watch is in warn phase');

    const warnLines = (report?.lines ?? []).filter(line => line.action === WARN_CAP_ACTION);
    assert.ok(warnLines.length >= 1, 'journal must record warn-cap from billed spend watch');
    assert.match(warnLines[0].reason, /36\.40/, 'reason must cite rolled-up billed spend for the day');

    const replay = await runManagerReplay({
      ledgerDir: S11_FIXTURE_DIR,
      manager: 'budget',
      createManager: ({ managerId, root: replayRoot, modeSettings: ms, trigger }) => {
        if (managerId === 'budget') {
          return createBudgetManager({
            managerId,
            root: replayRoot,
            modeSettings: ms,
            trigger,
            now: () => new Date(wave3At).getTime(),
          });
        }
        throw new Error(`unexpected manager ${managerId}`);
      },
      modeSettings,
      now: () => new Date(wave3At).getTime(),
    });

    const wave3Step = replay.steps.find(step => step.step?.runId === 's11-wave-3');
    assert.ok(wave3Step, 's11 fixture must include the wave-3 replay step');
    assert.ok(
      (wave3Step.journalLines ?? []).some(line => line.action === WARN_CAP_ACTION),
      'replay at wave 3 must journal warn-cap before cumulative spend crosses projectCap',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AC2: Lane health manager detects a lane that is down or rate limited and reroutes', async () => {
  const { fixture } = await loadManagerReplayFixture(S13_FIXTURE_DIR);
  const root = await mkReplayWorkspace();
  const preWaveAt = '2026-09-18T13:55:00.000Z';
  const preWaveMs = new Date(preWaveAt).getTime();

  try {
    await materializeManagerReplayFixture(fixture, root);

    const laneStorePath = path.join(root, REPLAY_SNAPSHOT_PATHS.laneStore);
    const probe = await runPreRunLaneProbe({
      laneStoreFile: laneStorePath,
      lanesDownBeforeFirstWave: fixture.lanesDownBeforeFirstWave,
      now: preWaveMs,
    });
    assert.equal(probe.unhealthy.length, 2, 'codex and cursor must probe down before wave 1');
    assert.deepEqual(
      new Set(probe.reroute),
      new Set(['codex', 'cursor']),
      'unhealthy lanes must be queued for reroute handling',
    );
    assert.match(probe.note, /codex down/i);
    assert.match(probe.note, /cursor down/i);

    const ledger = structuredClone(fixture.snapshots.tickets);
    ledger.tickets[0].lane = 'codex:gpt-5';
    ledger.tickets[0].status = 'ready';

    const modeSettings = createManagerActionModeSettings();
    enableManagerActionAuto(modeSettings, 'lane-health', REROUTE_TICKETS_ACTION);
    setManagerActionMode(modeSettings, 'lane-health', REROUTE_TICKETS_ACTION, 'auto');
    enableManagerActionAuto(modeSettings, 'lane-health', PAUSE_LANE_ACTION);
    setManagerActionMode(modeSettings, 'lane-health', PAUSE_LANE_ACTION, 'auto');

    const manager = createLaneHealthManager({
      managerId: 'lane-health',
      root,
      modeSettings,
      trigger: 'idle',
      fixture: {
        laneStore: fixture.snapshots.laneStore,
        lanesDownBeforeFirstWave: fixture.lanesDownBeforeFirstWave,
        ledger,
        manifest: S13_REROUTE_MANIFEST,
        contract: ledger.scope?.name,
        ready: 1,
      },
    });

    const { run, report } = await manager.run({ now: () => preWaveMs });
    assert.equal(run.status, 'ok');

    const lines = report?.lines ?? [];
    const pauseLines = lines.filter(line => line.action === PAUSE_LANE_ACTION);
    assert.ok(
      pauseLines.some(line => line.lane === 'codex'),
      'down codex lane must trigger pause-lane',
    );
    assert.ok(
      pauseLines.some(line => line.lane === 'cursor'),
      'down cursor lane must trigger pause-lane',
    );

    const rerouteLine = lines.find(line => line.action === REROUTE_TICKETS_ACTION);
    assert.ok(rerouteLine, 'pinned ready ticket on a down lane must produce reroute-tickets');
    assert.equal(rerouteLine.ticket, 'T-0301');
    assert.notEqual(rerouteLine.lane, 'codex', 'reroute must target a healthy lane');

    const ticketsOnDisk = JSON.parse(
      await fs.readFile(path.join(root, REPLAY_SNAPSHOT_PATHS.tickets), 'utf8'),
    );
    const ticket = ticketsOnDisk.tickets.find(t => t.id === 'T-0301');
    assert.ok(ticket);
    assert.notEqual(ticket.lane, 'codex:gpt-5', 'auto reroute must rewrite the ticket lane off codex');

    const rateProbe = await runPreRunLaneProbe({
      lanesDownBeforeFirstWave: [
        {
          lane: 'anthropic',
          state: 'rate-limited',
          reason: '429 storm in replay',
          markedAt: preWaveAt,
        },
      ],
      now: preWaveMs,
    });
    assert.ok(
      rateProbe.unhealthy.some(f => f.agent === 'anthropic' && f.state === 'rate-limited'),
      'rate-limited lanes must be classified unhealthy before reroute planning',
    );

    const replay = await runManagerReplay({
      ledgerDir: S13_FIXTURE_DIR,
      manager: 'lane-health',
      createManager: ({ managerId, root: replayRoot, modeSettings: ms, trigger }) =>
        createLaneHealthManager({
          managerId,
          root: replayRoot,
          modeSettings: ms,
          trigger,
          fixture: {
            laneStore: fixture.snapshots.laneStore,
            lanesDownBeforeFirstWave: fixture.lanesDownBeforeFirstWave,
            ledger: structuredClone(fixture.snapshots.tickets),
            contract: fixture.snapshots.tickets.scope?.name,
          },
        }),
      modeSettings: createManagerActionModeSettings(),
      now: () => preWaveMs,
    });

    const preWaveStep = replay.steps.find(step => step.step?.phase === 'pre-wave-1');
    assert.ok(preWaveStep, 's13 fixture must include pre-wave-1 idle step');
    assert.ok(
      (preWaveStep.journalLines ?? []).some(line => line.action === PAUSE_LANE_ACTION),
      'replay before wave 1 must journal lane-health pause for down lanes',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
