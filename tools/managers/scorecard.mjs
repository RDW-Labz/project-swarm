// SPDX-License-Identifier: Apache-2.0
import { constants as fsc, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./types.mjs').ManagerId} ManagerId */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerJournalLine} ManagerJournalLine */
/** @typedef {import('./replay.mjs').ManagerReplayResult} ManagerReplayResult */

const NOFOLLOW = fsc.O_NOFOLLOW || 0;

/** Relative path under the swarm repo root where replay scorecards are stored (AC1). */
export const MANAGER_SCORECARDS_REL_DIR = 'docs/state/manager-scorecards';

const managersPackageDir = path.dirname(fileURLToPath(import.meta.url));
const swarmPackageRoot = path.resolve(managersPackageDir, '..', '..');

/**
 * @param {string} ledgerDir
 * @returns {string}
 */
export function managerReplayScorecardKey(ledgerDir) {
  const base = path.basename(path.resolve(String(ledgerDir ?? '')));
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'replay';
}

/**
 * Stable identity for matching recorded journal lines to replay output (reason text may differ).
 * @param {ManagerJournalLine} line
 * @returns {string}
 */
export function managerJournalLineMatchKey(line) {
  return JSON.stringify({
    kind: line.kind,
    manager: line.manager,
    action: line.action,
    ticket: line.ticket ?? '',
    lane: line.lane ?? '',
    mode: line.mode,
  });
}

/**
 * @typedef {object} ManagerJournalLineComparison
 * @property {number} caughtFound
 * @property {number} caughtTotal
 * @property {number} missed
 * @property {number} wrongActions
 * @property {ManagerJournalLine[]} caughtLines
 * @property {ManagerJournalLine[]} missedLines
 * @property {ManagerJournalLine[]} wrongActionLines
 */

/**
 * Compare fixture-recorded journal lines to lines reproduced by a replay run.
 *
 * @param {ManagerJournalLine[]} recordedJournalLines
 * @param {ManagerJournalLine[]} reproducedJournalLines
 * @returns {ManagerJournalLineComparison}
 */
export function compareManagerReplayJournalLines(recordedJournalLines, reproducedJournalLines) {
  const recorded = Array.isArray(recordedJournalLines) ? recordedJournalLines : [];
  const reproduced = Array.isArray(reproducedJournalLines) ? reproducedJournalLines : [];

  /** @type {{ line: ManagerJournalLine, key: string }[]} */
  const reproPool = reproduced.map((line) => ({ line, key: managerJournalLineMatchKey(line) }));

  /** @type {ManagerJournalLine[]} */
  const caughtLines = [];
  /** @type {ManagerJournalLine[]} */
  const missedLines = [];

  for (const line of recorded) {
    const key = managerJournalLineMatchKey(line);
    const index = reproPool.findIndex((entry) => entry.key === key);
    if (index >= 0) {
      caughtLines.push(line);
      reproPool.splice(index, 1);
    } else {
      missedLines.push(line);
    }
  }

  const wrongActionLines = reproPool.map((entry) => entry.line);

  return {
    caughtFound: caughtLines.length,
    caughtTotal: recorded.length,
    missed: missedLines.length,
    wrongActions: wrongActionLines.length,
    caughtLines,
    missedLines,
    wrongActionLines,
  };
}

/**
 * @param {import('./replay.mjs').ManagerReplayStepResult[]} steps
 * @returns {number}
 */
export function managerReplayCostUsd(steps) {
  let sum = 0;
  if (!Array.isArray(steps)) return sum;
  for (const step of steps) {
    const runCost = step?.run?.costUsd;
    if (typeof runCost === 'number' && Number.isFinite(runCost) && runCost >= 0) sum += runCost;
  }
  return sum;
}

/**
 * @typedef {object} ManagerReplayScorecard
 * @property {1} version
 * @property {ManagerId} managerId
 * @property {string} replayKey
 * @property {string} ledgerDir
 * @property {string} writtenAt
 * @property {{ found: number, total: number }} caught
 * @property {number} missed
 * @property {number} wrongActions
 * @property {number} costUsd
 * @property {number|null} timeToFix
 * @property {ManagerJournalLine[]} missedLines
 * @property {ManagerJournalLine[]} wrongActionLines
 */

/**
 * @param {{
 *   managerId: ManagerId,
 *   ledgerDir: string,
 *   recordedJournalLines: ManagerJournalLine[],
 *   reproducedJournalLines: ManagerJournalLine[],
 *   steps?: import('./replay.mjs').ManagerReplayStepResult[],
 *   timeToFix?: number|null,
 *   now?: () => number,
 * }} input
 * @returns {ManagerReplayScorecard}
 */
export function buildManagerReplayScorecard(input) {
  const managerId = input.managerId;
  const ledgerDir = String(input.ledgerDir ?? '');
  const comparison = compareManagerReplayJournalLines(
    input.recordedJournalLines,
    input.reproducedJournalLines,
  );
  const now = input.now ?? (() => Date.now());
  const timeToFix =
    input.timeToFix === undefined || input.timeToFix === null
      ? null
      : Number(input.timeToFix);

  return {
    version: 1,
    managerId,
    replayKey: managerReplayScorecardKey(ledgerDir),
    ledgerDir,
    writtenAt: new Date(now()).toISOString(),
    caught: {
      found: comparison.caughtFound,
      total: comparison.caughtTotal,
    },
    missed: comparison.missed,
    wrongActions: comparison.wrongActions,
    costUsd: managerReplayCostUsd(input.steps),
    timeToFix: Number.isFinite(timeToFix) ? timeToFix : null,
    missedLines: comparison.missedLines,
    wrongActionLines: comparison.wrongActionLines,
  };
}

/**
 * @param {ManagerReplayResult} replayResult
 * @param {string} ledgerDir
 * @param {{ timeToFix?: number|null, now?: () => number }} [options]
 * @returns {ManagerReplayScorecard}
 */
export function managerReplayScorecardFromResult(replayResult, ledgerDir, options = {}) {
  return buildManagerReplayScorecard({
    managerId: replayResult.managerId,
    ledgerDir,
    recordedJournalLines: replayResult.recordedJournalLines,
    reproducedJournalLines: replayResult.reproducedJournalLines,
    steps: replayResult.steps,
    timeToFix: options.timeToFix,
    now: options.now,
  });
}

/**
 * @param {ManagerId} managerId
 * @param {string} replayKey
 * @returns {string}
 */
export function managerScorecardRelativePath(managerId, replayKey) {
  const safeManager = String(managerId).replace(/[^a-zA-Z0-9-]+/g, '-');
  const safeKey = String(replayKey).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'replay';
  return path.join(MANAGER_SCORECARDS_REL_DIR, `${safeManager}-${safeKey}.json`);
}

/**
 * @param {string} swarmRoot
 */
async function assertScorecardWriteRoot(swarmRoot) {
  const resolved = path.resolve(String(swarmRoot ?? ''));
  if (!resolved) throw new Error('scorecard-root-invalid');
  const realRoot = await fs.realpath(swarmPackageRoot);
  const realTarget = await fs.realpath(resolved).catch(() => resolved);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error('scorecard-root-unsafe: scorecards must be written under the swarm package root');
  }
}

/**
 * Write one replay scorecard JSON under {@link MANAGER_SCORECARDS_REL_DIR} (AC1).
 *
 * @param {string} swarmRoot
 * @param {{
 *   managerId: ManagerId,
 *   ledgerDir: string,
 *   recordedJournalLines: ManagerJournalLine[],
 *   reproducedJournalLines: ManagerJournalLine[],
 *   steps?: import('./replay.mjs').ManagerReplayStepResult[],
 *   timeToFix?: number|null,
 *   now?: () => number,
 * }} input
 * @returns {Promise<{ scorecard: ManagerReplayScorecard, path: string }>}
 */
export async function writeManagerReplayScorecard(swarmRoot, input) {
  await assertScorecardWriteRoot(swarmRoot);
  const scorecard = buildManagerReplayScorecard(input);
  const rel = managerScorecardRelativePath(scorecard.managerId, scorecard.replayKey);
  const abs = path.join(path.resolve(swarmRoot), rel);

  const relFromRoot = path.relative(path.resolve(swarmRoot), abs);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
    throw new Error('scorecard-path-unsafe');
  }
  if (!relFromRoot.startsWith(MANAGER_SCORECARDS_REL_DIR + path.sep)) {
    throw new Error('scorecard-path-unsafe');
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fh = await fs.open(abs, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | NOFOLLOW);
  try {
    await fh.writeFile(`${JSON.stringify(scorecard, null, 2)}\n`, 'utf8');
  } finally {
    await fh.close();
  }

  return { scorecard, path: rel.split(path.sep).join('/') };
}

/**
 * @param {string} swarmRoot
 * @param {ManagerReplayResult} replayResult
 * @param {string} ledgerDir
 * @param {{ timeToFix?: number|null, now?: () => number }} [options]
 * @returns {Promise<{ scorecard: ManagerReplayScorecard, path: string }>}
 */
export async function writeManagerReplayScorecardFromResult(swarmRoot, replayResult, ledgerDir, options = {}) {
  return writeManagerReplayScorecard(swarmRoot, {
    managerId: replayResult.managerId,
    ledgerDir,
    recordedJournalLines: replayResult.recordedJournalLines,
    reproducedJournalLines: replayResult.reproducedJournalLines,
    steps: replayResult.steps,
    timeToFix: options.timeToFix,
    now: options.now,
  });
}

/**
 * Write a replay scorecard after {@link import('./replay.mjs').runManagerReplay} finishes (AC1).
 *
 * @param {{
 *   ledgerDir?: string,
 *   skipScorecard?: boolean,
 *   swarmRoot?: string,
 *   timeToFix?: number|null,
 *   now?: () => number,
 * }} replayOptions
 * @param {ManagerReplayResult} replayResult
 * @returns {Promise<{ scorecard: ManagerReplayScorecard, path: string }|null>}
 */
export async function writeManagerReplayScorecardForRun(replayOptions, replayResult) {
  if (replayOptions?.skipScorecard) return null;
  const swarmRoot = path.resolve(String(replayOptions?.swarmRoot ?? swarmPackageRoot));
  const ledgerDir = String(replayOptions?.ledgerDir ?? '');
  return writeManagerReplayScorecardFromResult(swarmRoot, replayResult, ledgerDir, {
    timeToFix: replayOptions?.timeToFix,
    now: replayOptions?.now,
  });
}
