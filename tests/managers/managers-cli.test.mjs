import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runManagersCommand,
  parseManagersArgs,
  managerReplayCliNames,
  MANAGERS_USAGE,
} from '../../tools/manager-commands.mjs';
import { builtinManagerIds } from '../../tools/managers/registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const budgetFixture = path.join(repoRoot, 'evals/managers/s11-budget-cap');

test('parseManagersArgs accepts --json and --skip-scorecard', () => {
  assert.deepEqual(parseManagersArgs(['replay', 'x', 'budget', '--json', '--skip-scorecard']), {
    flags: { json: true, 'skip-scorecard': true },
    rest: ['replay', 'x', 'budget'],
  });
  assert.throws(() => parseManagersArgs(['--unknown']), /unknown flag/);
});

test('AC1: swarm managers replay lists registered managers and runs replay on a fixture path', async () => {
  const listed = await runManagersCommand(repoRoot, ['list']);
  assert.equal(listed.exitCode, 0, listed.stdout);
  for (const id of builtinManagerIds) {
    assert.match(listed.stdout, new RegExp(`^${id}$`, 'm'), `missing manager id ${id} in:\n${listed.stdout}`);
  }

  const listedJson = JSON.parse((await runManagersCommand(repoRoot, ['list', '--json'])).stdout);
  assert.deepEqual(listedJson.managers.sort(), [...builtinManagerIds].sort());
  assert.ok(listedJson.replayCliNames.includes('budget'));
  assert.ok(listedJson.replayCliNames.includes('ticket'));
  assert.ok(managerReplayCliNames().includes('lessons-keeper'));

  const replay = await runManagersCommand(repoRoot, [
    'replay',
    budgetFixture,
    'budget',
    '--skip-scorecard',
  ]);
  assert.equal(replay.exitCode, 0, replay.stdout);
  assert.match(replay.stdout, /manager: budget/);
  assert.match(replay.stdout, /ledger:/);
  assert.match(replay.stdout, /steps: [1-9]/);

  const replayJson = JSON.parse(
    (await runManagersCommand(repoRoot, ['replay', budgetFixture, 'budget', '--json', '--skip-scorecard'])).stdout,
  );
  assert.equal(replayJson.managerId, 'budget');
  assert.ok(replayJson.steps >= 1);
  assert.ok(Array.isArray(replayJson.recordedJournalLines));
  assert.ok(Array.isArray(replayJson.reproducedJournalLines));
});

test('runManagersCommand prints usage for an unknown verb', async () => {
  const r = await runManagersCommand(repoRoot, ['nope']);
  assert.equal(r.exitCode, 2);
  assert.match(r.stdout, /Usage: swarm managers/);
  assert.match(MANAGERS_USAGE, /swarm managers replay/);
});

test('scorecard command summarizes replay output', async () => {
  const r = await runManagersCommand(repoRoot, [
    'scorecard',
    budgetFixture,
    'budget',
    '--skip-scorecard',
  ]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /no scorecard/);
});

test('replay rejects a missing manager name', async () => {
  const r = await runManagersCommand(repoRoot, ['replay', budgetFixture, 'not-a-manager', '--skip-scorecard']);
  assert.equal(r.exitCode, 1);
  assert.match(r.stdout, /replay-manager-unknown/);
});
