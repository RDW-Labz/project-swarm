// SPDX-License-Identifier: Apache-2.0
// T-0188: Unit tests for manager base, registry, replay, and scorecard.

import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import {
  BaseManager,
  buildManagerJournalReport,
  buildManagerRun,
} from '../../tools/managers/base.mjs';
import { MANAGER_IDS as JOURNAL_MANAGER_IDS } from '../../tools/managers/journal.mjs';
import { createManagerActionModeSettings, setManagerActionMode } from '../../tools/managers/modes.mjs';
import { createManager as createBudgetManager } from '../../tools/managers/budget/index.mjs';
import { WARN_CAP_ACTION } from '../../tools/managers/budget/spend-watch.mjs';
import {
  frameworkModuleIds,
  frameworkRegistry,
} from '../../tools/managers/index.mjs';
import {
  BUILTIN_MANAGER_REGISTRY,
  builtinManagerIds,
  getBuiltinManager,
  managerActionGroup,
} from '../../tools/managers/registry.mjs';
import {
  fixtureManagerId,
  loadManagerReplayFixture,
  MANAGER_REPLAY_CLI_IDS,
  normalizeReplayManagerId,
  replayStepsFromFixture,
  replayStepTrigger,
  runManagerReplay,
} from '../../tools/managers/replay.mjs';
import {
  buildManagerReplayScorecard,
  compareManagerReplayJournalLines,
  managerJournalLineMatchKey,
  managerReplayCostUsd,
  managerReplayScorecardFromResult,
  managerReplayScorecardKey,
  managerScorecardRelativePath,
  MANAGER_SCORECARDS_REL_DIR,
} from '../../tools/managers/scorecard.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '..', '..');
const managersDir = path.join(repoRoot, 'tools', 'managers');
const S11_FIXTURE_DIR = path.join(repoRoot, 'evals', 'managers', 's11-budget-cap');

const wave3At = '2026-09-12T20:30:00.000Z';
const wave4At = '2026-09-12T22:25:00.000Z';

/**
 * @param {{
 *   managerId: import('../../tools/managers/modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: import('../../tools/managers/modes.mjs').ManagerActionModeSettings,
 *   trigger?: import('../../contracts/managers.json').components.schemas.ManagerTrigger,
 * }} config
 */
function budgetReplayCreateManager({ managerId, root, modeSettings, trigger }) {
  if (managerId !== 'budget') throw new Error(`unexpected manager ${managerId}`);
  const at = wave3At;
  return createBudgetManager({
    managerId,
    root,
    modeSettings,
    trigger,
    now: () => new Date(at).getTime(),
  });
}

test('framework submodule registry lists importable manager framework modules', async () => {
  assert.deepEqual(frameworkModuleIds, [
    'base',
    'journal',
    'modes',
    'registry',
    'replay',
    'scorecard',
    'types',
  ]);
  for (const id of frameworkModuleIds) {
    const rel = frameworkRegistry[id];
    assert.equal(rel, `./${id}.mjs`);
    const mod = await import(pathToFileURL(path.join(managersDir, `${id}.mjs`)).href);
    assert.ok(mod, `framework module ${id} must load`);
  }
});

test('BaseManager run builds ManagerRun and journals shadow findings', async () => {
  class ProbeManager extends BaseManager {
    constructor(root, modeSettings) {
      super({ managerId: 'version', root, modeSettings, trigger: 'idle' });
    }

    async execute(ctx) {
      await this.emitFinding({
        severity: 'info',
        code: 'stale-pointer',
        reason: 'framework test finding',
        action: 'show-stale-banner',
      });
      ctx.costUsd += 0.01;
    }
  }

  const root = path.join(repoRoot, 'evals', 'managers', 'stale-pointer');
  const modeSettings = createManagerActionModeSettings();
  const fixedNow = () => new Date('2026-10-21T12:00:00.000Z').getTime();
  const manager = new ProbeManager(root, modeSettings);

  const { run, report } = await manager.run({ now: fixedNow });

  assert.equal(run.status, 'ok');
  assert.equal(run.managerId, 'version');
  assert.equal(run.trigger, 'idle');
  assert.equal(run.findingCount, 1);
  assert.equal(run.journalLineCount, 1);
  assert.ok(report);
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0].action, 'show-stale-banner');
  assert.equal(report.lines[0].mode, 'shadow');

  const manualCtx = {
    runId: 'manual-run',
    findings: [],
    journalLines: [],
    costUsd: 0.25,
  };
  const built = buildManagerRun(manualCtx, 'version', 'replay', 'ok', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z');
  assert.equal(built.runId, 'manual-run');
  assert.equal(built.findingCount, 0);
  assert.equal(built.costUsd, 0.25);

  manualCtx.journalLines.push(report.lines[0]);
  const journalReport = buildManagerJournalReport(manualCtx, 'version');
  assert.ok(journalReport);
  assert.equal(journalReport.lines.length, 1);

  setManagerActionMode(modeSettings, 'version', 'show-stale-banner', 'off');
  const skipped = await manager.run({ now: fixedNow });
  assert.equal(skipped.run.findingCount, 0);
});

test('AC2: Registry exposes every built-in manager id', () => {
  assert.deepEqual([...builtinManagerIds].sort(), [...JOURNAL_MANAGER_IDS].sort());
  assert.equal(Object.keys(BUILTIN_MANAGER_REGISTRY).length, builtinManagerIds.length);

  for (const managerId of builtinManagerIds) {
    const entry = getBuiltinManager(managerId);
    assert.equal(entry.managerId, managerId);
    assert.ok(Array.isArray(entry.actionGroups.safe) && entry.actionGroups.safe.length > 0);
    assert.ok(Array.isArray(entry.actionGroups.needsYou));
    assert.equal(typeof entry.run, 'function');
    assert.ok(BUILTIN_MANAGER_REGISTRY[managerId]);
  }

  assert.equal(managerActionGroup('budget', WARN_CAP_ACTION), 'safe');
  assert.equal(managerActionGroup('budget', 'change-cap'), 'needsYou');
  assert.equal(managerActionGroup('budget', 'not-an-action'), null);
});

test('replay helpers normalize manager ids and enumerate fixture steps', async () => {
  const { fixture } = await loadManagerReplayFixture(S11_FIXTURE_DIR);
  assert.equal(fixtureManagerId(fixture), 'budget');
  assert.equal(normalizeReplayManagerId('ticket'), 'ticket-manager');
  assert.equal(normalizeReplayManagerId('lessons'), 'lessons-keeper');
  assert.throws(() => normalizeReplayManagerId('missing'), /replay-manager-unknown/);

  const steps = replayStepsFromFixture(fixture);
  assert.equal(steps.length, 6);
  assert.equal(replayStepTrigger({ kind: 'scope' }), 'scope');
  assert.equal(replayStepTrigger({ kind: 'run', runId: 'x' }), 'wave');
  assert.equal(replayStepTrigger({ trigger: 'idle' }), 'idle');

  for (const cliName of Object.keys(MANAGER_REPLAY_CLI_IDS)) {
    const id = normalizeReplayManagerId(cliName);
    assert.ok(builtinManagerIds.includes(id), `CLI name ${cliName} must map to a built-in manager`);
  }
});

test('AC1: Replay on evals/managers/s11-budget-cap/fixture.json records a cap warning before the cap is reached', async () => {
  const { fixture } = await loadManagerReplayFixture(S11_FIXTURE_DIR);
  assert.equal(fixture.projectCap, 40);

  const spendAtWave3 = fixture.spendCurve.find(point => point.at === wave3At)?.cumulativeUsd;
  assert.equal(spendAtWave3, 36.4);
  assert.ok(spendAtWave3 < fixture.projectCap, 'wave 3 spend must still be under the hard cap');

  const spendAtWave4 = fixture.spendCurve.find(point => point.at === wave4At)?.cumulativeUsd;
  assert.ok(spendAtWave4 > fixture.projectCap, 'wave 4 is when spend crosses projectCap');

  const modeSettings = createManagerActionModeSettings();
  const replay = await runManagerReplay({
    ledgerDir: S11_FIXTURE_DIR,
    manager: 'budget',
    createManager: budgetReplayCreateManager,
    modeSettings,
    now: () => new Date(wave3At).getTime(),
  });

  assert.equal(replay.managerId, 'budget');
  const wave3Step = replay.steps.find(step => step.step?.runId === 's11-wave-3');
  assert.ok(wave3Step, 's11 fixture must include the wave-3 replay step');

  const warnLines = (wave3Step.journalLines ?? []).filter(line => line.action === WARN_CAP_ACTION);
  assert.ok(warnLines.length >= 1, 'replay at wave 3 must journal warn-cap before cumulative spend crosses projectCap');
  assert.ok(
    warnLines.some(line => /budget-warn|project cap/i.test(line.reason)),
    'cap warning reason must describe spend relative to the project cap',
  );

  const wave4Step = replay.steps.find(step => step.step?.runId === 's11-wave-4');
  assert.ok(wave4Step);
  const wave4Warn = (wave4Step.journalLines ?? []).filter(line => line.action === WARN_CAP_ACTION);
  assert.ok(wave4Warn.length >= 1, 'after cap is crossed replay must still record cap-related warnings');
});

test('scorecard compares journal lines and summarizes replay runs', async () => {
  const recorded = [
    {
      kind: 'action',
      manager: 'budget',
      action: WARN_CAP_ACTION,
      reason: 'recorded warn-cap',
      mode: 'shadow',
      cost: 0,
    },
  ];
  const reproduced = [
    {
      kind: 'action',
      manager: 'budget',
      action: WARN_CAP_ACTION,
      reason: 'reproduced warn-cap with different text',
      mode: 'shadow',
      cost: 0,
    },
    {
      kind: 'action',
      manager: 'budget',
      action: 'hold-opus-reask',
      reason: 'unexpected extra action',
      mode: 'shadow',
      cost: 0,
    },
  ];

  const key = managerJournalLineMatchKey(recorded[0]);
  assert.equal(key, managerJournalLineMatchKey(reproduced[0]));

  const comparison = compareManagerReplayJournalLines(recorded, reproduced);
  assert.equal(comparison.caughtFound, 1);
  assert.equal(comparison.caughtTotal, 1);
  assert.equal(comparison.missed, 0);
  assert.equal(comparison.wrongActions, 1);

  const replay = await runManagerReplay({
    ledgerDir: S11_FIXTURE_DIR,
    manager: 'budget',
    createManager: budgetReplayCreateManager,
    modeSettings: createManagerActionModeSettings(),
    now: () => new Date(wave3At).getTime(),
  });

  const ledgerDir = S11_FIXTURE_DIR;
  const scorecard = buildManagerReplayScorecard({
    managerId: 'budget',
    ledgerDir,
    recordedJournalLines: replay.recordedJournalLines,
    reproducedJournalLines: replay.reproducedJournalLines,
    steps: replay.steps,
    now: () => new Date(wave3At).getTime(),
  });

  assert.equal(scorecard.version, 1);
  assert.equal(scorecard.managerId, 'budget');
  assert.equal(scorecard.replayKey, managerReplayScorecardKey(ledgerDir));
  assert.equal(scorecard.writtenAt, wave3At);
  assert.equal(typeof scorecard.costUsd, 'number');
  assert.ok(scorecard.costUsd >= managerReplayCostUsd(replay.steps));

  const fromResult = managerReplayScorecardFromResult(replay, ledgerDir, {
    now: () => new Date(wave3At).getTime(),
  });
  assert.equal(fromResult.managerId, scorecard.managerId);
  assert.equal(fromResult.replayKey, scorecard.replayKey);

  const rel = managerScorecardRelativePath('budget', scorecard.replayKey);
  assert.match(rel, new RegExp(`^${MANAGER_SCORECARDS_REL_DIR}/budget-s11-budget-cap\\.json$`));
});
