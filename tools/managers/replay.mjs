// SPDX-License-Identifier: Apache-2.0
import { constants as fsc, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManagerActionModeSettings, isManagerId } from './modes.mjs';
import { validateManagerJournalLine } from './journal.mjs';
import { readJournal } from '../journal.mjs';

/** @typedef {import('./types.mjs').ManagerId} ManagerId */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerJournalLine} ManagerJournalLine */
/** @typedef {import('../../contracts/managers.json').components.schemas.JournalReport} JournalReport */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerRun} ManagerRun */
/** @typedef {import('./modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */

const NOFOLLOW = fsc.O_NOFOLLOW || 0;

/** Paths used when materializing {@link ManagerReplayFixture} snapshot fields. */
export const REPLAY_SNAPSHOT_PATHS = Object.freeze({
  tickets: '.swarm/project/tickets.json',
  journal: '.swarm/project/journal.ndjson',
  laneStore: '.swarm/replay/lane-store.json',
  spendLedger: '.swarm/replay/spend-ledger.json',
});

/** CLI names from evals/managers/README.md mapped to contract {@link ManagerId} values. */
export const MANAGER_REPLAY_CLI_IDS = Object.freeze({
  budget: 'budget',
  'lane-health': 'lane-health',
  version: 'version',
  ticket: 'ticket-manager',
  'ticket-manager': 'ticket-manager',
  unblocker: 'unblocker',
  'merge-queue': 'merge-queue',
  lessons: 'lessons-keeper',
  'lessons-keeper': 'lessons-keeper',
  'visual-qa': 'visual-qa',
});

const managersPackageDir = path.dirname(fileURLToPath(import.meta.url));
const swarmPackageRoot = path.resolve(managersPackageDir, '..', '..');

/**
 * @param {unknown} value
 * @returns {ManagerId}
 */
export function normalizeReplayManagerId(value) {
  const key = String(value ?? '').trim();
  const id = MANAGER_REPLAY_CLI_IDS[key];
  if (!id) throw new Error(`replay-manager-unknown: ${key}`);
  return id;
}

/**
 * @param {string} rel
 */
function assertRelativeFixturePath(rel) {
  if (typeof rel !== 'string' || rel.length < 1) throw new Error('replay-fixture-path-invalid');
  if (path.isAbsolute(rel) || rel.startsWith('/') || rel.includes('\\') || rel.split('/').includes('..')) {
    throw new Error(`replay-fixture-path-unsafe: ${rel}`);
  }
}

async function readJsonFile(file) {
  const fh = await fs.open(file, fsc.O_RDONLY | NOFOLLOW);
  try {
    return JSON.parse(await fh.readFile('utf8'));
  } finally {
    await fh.close();
  }
}

async function assertRealDir(dir) {
  const st = await fs.lstat(dir).catch((error) => {
    if (error?.code !== 'ENOENT') {
      console.error('[tools/managers/replay.mjs] lstat dir:', dir, error?.message ?? error);
    }
    return null;
  });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error('replay-not-a-directory');
}

async function copyFileSafe(src, dst) {
  const fh = await fs.open(src, fsc.O_RDONLY | NOFOLLOW);
  try {
    const buf = await fh.readFile();
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, buf, { flag: 'w' });
  } finally {
    await fh.close();
  }
}

async function copyTree(src, dst) {
  await assertRealDir(src);
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    if (ent.name === 'fixture.json') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isSymbolicLink()) throw new Error('replay-symlink-refused');
    if (ent.isDirectory()) await copyTree(s, d);
    else if (ent.isFile()) await copyFileSafe(s, d);
  }
}

/**
 * @param {string} ledgerDir
 * @returns {Promise<{ fixture: object, fixtureFile: string|null, ledgerDir: string }>}
 */
export async function loadManagerReplayFixture(ledgerDir) {
  const resolved = path.resolve(String(ledgerDir ?? ''));
  if (!resolved) throw new Error('replay-ledger-dir-invalid');
  const st = await fs.lstat(resolved).catch((error) => {
    if (error?.code !== 'ENOENT') {
      console.error('[tools/managers/replay.mjs] lstat resolved:', resolved, error?.message ?? error);
    }
    return null;
  });
  if (!st || st.isSymbolicLink()) throw new Error('replay-ledger-dir-invalid');

  if (st.isFile()) {
    if (!resolved.endsWith('.json')) throw new Error('replay-fixture-file-invalid');
    return { fixture: await readJsonFile(resolved), fixtureFile: resolved, ledgerDir: path.dirname(resolved) };
  }

  if (!st.isDirectory()) throw new Error('replay-ledger-dir-invalid');

  const fixtureFile = path.join(resolved, 'fixture.json');
  try {
    const fSt = await fs.lstat(fixtureFile);
    if (fSt.isSymbolicLink() || !fSt.isFile()) throw new Error('replay-fixture-missing');
    return { fixture: await readJsonFile(fixtureFile), fixtureFile, ledgerDir: resolved };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { fixture: { version: 1, files: {} }, fixtureFile: null, ledgerDir: resolved };
    }
    throw error;
  }
}

/**
 * @param {object} fixture
 * @returns {ManagerId|undefined}
 */
export function fixtureManagerId(fixture) {
  if (!fixture || typeof fixture !== 'object') return undefined;
  const raw = fixture.managerId ?? fixture.manager;
  if (raw === undefined) return undefined;
  const key = String(raw).trim();
  if (isManagerId(key)) return key;
  return normalizeReplayManagerId(key);
}

/**
 * @param {object} fixture
 * @param {ManagerId} managerId
 */
export function assertFixtureManager(fixture, managerId) {
  const expected = fixtureManagerId(fixture);
  if (expected && expected !== managerId) {
    throw new Error(`replay-fixture-manager-mismatch: expected ${expected}, got ${managerId}`);
  }
}

/**
 * @param {string} root
 */
export async function assertReplayWorkspaceRoot(root) {
  const realRoot = await fs.realpath(swarmPackageRoot);
  const realWorkspace = await fs.realpath(root);
  if (realWorkspace === realRoot || realWorkspace.startsWith(realRoot + path.sep)) {
    throw new Error('replay-root-unsafe: workspace must be a throwaway directory, not the swarm install root');
  }
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} content
 */
async function writeFixtureFile(root, rel, content) {
  assertRelativeFixturePath(rel);
  const dst = path.join(root, rel);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.writeFile(dst, content, { flag: 'w' });
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {unknown} value
 */
async function writeFixtureJson(root, rel, value) {
  await writeFixtureFile(root, rel, `${JSON.stringify(value)}\n`);
}

/**
 * @param {string} root
 * @param {object} fixture
 */
export async function materializeManagerReplayFixture(fixture, root) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new Error('replay-fixture-invalid');
  }

  const files = fixture.files;
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const [rel, content] of Object.entries(files)) {
      await writeFixtureFile(root, rel, String(content));
    }
  }

  const ledger = fixture.ledger;
  if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
    await writeFixtureJson(root, REPLAY_SNAPSHOT_PATHS.tickets, ledger);
  }

  const snapshots = fixture.snapshots;
  if (snapshots && typeof snapshots === 'object' && !Array.isArray(snapshots)) {
    if (snapshots.tickets) await writeFixtureJson(root, REPLAY_SNAPSHOT_PATHS.tickets, snapshots.tickets);
    if (snapshots.laneStore) await writeFixtureJson(root, REPLAY_SNAPSHOT_PATHS.laneStore, snapshots.laneStore);
    if (snapshots.spendLedger) await writeFixtureJson(root, REPLAY_SNAPSHOT_PATHS.spendLedger, snapshots.spendLedger);
    if (Array.isArray(snapshots.journal) && snapshots.journal.length > 0) {
      const body = snapshots.journal.map((entry) => `${JSON.stringify(entry)}\n`).join('');
      await writeFixtureFile(root, REPLAY_SNAPSHOT_PATHS.journal, body);
    }
    const runStates = snapshots.runStates;
    if (runStates && typeof runStates === 'object' && !Array.isArray(runStates)) {
      for (const [runId, state] of Object.entries(runStates)) {
        assertRelativeFixturePath(path.join('.swarm/runs', runId, 'state.json'));
        await writeFixtureJson(root, path.join('.swarm/runs', runId, 'state.json'), state);
      }
    }
  }
}

/**
 * @param {string} root
 * @param {string} ledgerDir
 * @param {string|null} fixtureFile
 */
export async function copyLedgerTreeIntoWorkspace(root, ledgerDir, fixtureFile) {
  await copyTree(ledgerDir, root);
  if (fixtureFile) {
    const rel = path.relative(ledgerDir, fixtureFile);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      await fs.rm(path.join(root, rel), { force: true });
    }
  }
}

/**
 * @param {unknown} event
 * @returns {ManagerJournalLine|null}
 */
export function managerJournalLineFromEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (!event.manager || !event.action || !event.reason || !event.mode) return null;
  /** @type {ManagerJournalLine} */
  const line = {
    kind: event.kind ?? 'action',
    manager: event.manager,
    action: event.action,
    reason: event.reason,
    mode: event.mode,
    cost: Number(event.cost ?? 0),
  };
  if (event.ticket !== undefined) line.ticket = event.ticket;
  if (event.lane !== undefined) line.lane = event.lane;
  validateManagerJournalLine(line);
  return line;
}

/**
 * Read manager journal lines already present in the replay workspace journal (AC1 reproduce).
 *
 * @param {string} root
 * @param {ManagerId} [managerId]
 * @returns {Promise<ManagerJournalLine[]>}
 */
export async function readManagerJournalLines(root, managerId) {
  const events = await readJournal(root, { limit: Number.POSITIVE_INFINITY });
  const lines = [];
  for (const event of events) {
    const line = managerJournalLineFromEvent(event);
    if (!line) continue;
    if (managerId && line.manager !== managerId) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * @param {object} fixture
 * @param {ManagerId} [managerId]
 * @returns {ManagerJournalLine[]}
 */
export function recordedManagerJournalLines(fixture, managerId) {
  const lines = [];
  const files = fixture?.files;
  const journalText = files?.[REPLAY_SNAPSHOT_PATHS.journal];
  if (typeof journalText === 'string' && journalText.length > 0) {
    for (const row of journalText.split('\n')) {
      if (!row.trim()) continue;
      let event;
      try {
        event = JSON.parse(row);
      } catch {
        continue;
      }
      const line = managerJournalLineFromEvent(event);
      if (!line) continue;
      if (managerId && line.manager !== managerId) continue;
      lines.push(line);
    }
  }
  const reports = fixture?.journalReports;
  if (Array.isArray(reports)) {
    for (const report of reports) {
      if (!report || (managerId && report.managerId !== managerId)) continue;
      if (!Array.isArray(report.lines)) continue;
      for (const line of report.lines) {
        validateManagerJournalLine(line);
        if (managerId && line.manager !== managerId) continue;
        lines.push(line);
      }
    }
  }
  return lines;
}

/**
 * @param {object} fixture
 * @returns {object[]}
 */
export function replayStepsFromFixture(fixture) {
  const steps = Array.isArray(fixture?.steps) ? fixture.steps.slice() : [];
  steps.sort((a, b) => String(a?.at ?? '').localeCompare(String(b?.at ?? '')));
  return steps;
}

/**
 * @param {object} step
 * @returns {import('../../contracts/managers.json').components.schemas.ManagerTrigger}
 */
export function replayStepTrigger(step) {
  if (step?.trigger) return step.trigger;
  if (step?.kind === 'scope') return 'scope';
  if (step?.kind === 'run') return 'wave';
  return 'replay';
}

/**
 * @returns {Promise<((opts: { managerId: ManagerId, root: string, modeSettings: ManagerActionModeSettings, trigger: string }) => import('./base.mjs').BaseManager)|null>}
 */
async function resolveCreateManager(override) {
  if (typeof override === 'function') return override;
  try {
    const mod = await import('./registry.mjs');
    if (typeof mod.createManager === 'function') return mod.createManager;
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  return null;
}

/**
 * @typedef {object} ManagerReplayStepResult
 * @property {number} index
 * @property {object} step
 * @property {import('../../contracts/managers.json').components.schemas.ManagerTrigger} trigger
 * @property {ManagerRun|null} run
 * @property {JournalReport|null} report
 * @property {ManagerJournalLine[]} journalLines
 */

/**
 * @typedef {object} ManagerReplayResult
 * @property {ManagerId} managerId
 * @property {string} workspaceRoot
 * @property {ManagerJournalLine[]} reproducedJournalLines
 * @property {ManagerJournalLine[]} recordedJournalLines
 * @property {ManagerReplayStepResult[]} steps
 */

/**
 * Load a fixture, copy it into a throwaway project tree, step managers in historical order,
 * and reproduce journal lines from the workspace without writing the real swarm root (AC1).
 *
 * @param {{
 *   ledgerDir: string,
 *   manager: string,
 *   projectRoot?: string,
 *   createManager?: (opts: {
 *     managerId: ManagerId,
 *     root: string,
 *     modeSettings: ManagerActionModeSettings,
 *     trigger: import('../../contracts/managers.json').components.schemas.ManagerTrigger,
 *   }) => import('./base.mjs').BaseManager,
 *   modeSettings?: ManagerActionModeSettings,
 *   now?: () => number,
 *   keepWorkspace?: boolean,
 * }} options
 * @returns {Promise<ManagerReplayResult>}
 */
export async function runManagerReplay(options) {
  const ledgerDir = String(options?.ledgerDir ?? '');
  if (!ledgerDir) throw new Error('replay-ledger-dir-invalid');

  const managerId = normalizeReplayManagerId(options.manager);
  const { fixture, fixtureFile, ledgerDir: fixtureDir } = await loadManagerReplayFixture(ledgerDir);
  assertFixtureManager(fixture, managerId);

  const ownsWorkspace = !options.projectRoot;
  const workspaceRoot = path.resolve(
    options.projectRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-manager-replay-'))),
  );
  await assertReplayWorkspaceRoot(workspaceRoot);

  const modeSettings = options.modeSettings ?? createManagerActionModeSettings();
  const createManager = await resolveCreateManager(options.createManager);
  const now = options.now ?? (() => Date.now());

  /** @type {ManagerReplayStepResult[]} */
  const stepResults = [];

  try {
    await materializeManagerReplayFixture(fixture, workspaceRoot);
    await copyLedgerTreeIntoWorkspace(workspaceRoot, fixtureDir, fixtureFile);

    const recordedJournalLines = recordedManagerJournalLines(fixture, managerId);
    const steps = replayStepsFromFixture(fixture);

    if (steps.length === 0 && createManager) {
      const manager = createManager({ managerId, root: workspaceRoot, modeSettings, trigger: 'replay' });
      const { run, report } = await manager.run({ now });
      stepResults.push({
        index: 0,
        step: { at: new Date(now()).toISOString(), trigger: 'replay' },
        trigger: 'replay',
        run,
        report,
        journalLines: report?.lines ?? [],
      });
    } else {
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        const trigger = replayStepTrigger(step);
        /** @type {ManagerRun|null} */
        let run = null;
        /** @type {JournalReport|null} */
        let report = null;
        /** @type {ManagerJournalLine[]} */
        let journalLines = [];

        if (createManager) {
          const manager = createManager({ managerId, root: workspaceRoot, modeSettings, trigger });
          const result = await manager.run({ now: () => new Date(String(step.at ?? now())).getTime() });
          run = result.run;
          report = result.report;
          journalLines = report?.lines ?? [];
        }

        stepResults.push({ index, step, trigger, run, report, journalLines });
      }
    }

    const reproducedJournalLines = await readManagerJournalLines(workspaceRoot, managerId);

    return {
      managerId,
      workspaceRoot,
      reproducedJournalLines,
      recordedJournalLines,
      steps: stepResults,
    };
  } finally {
    if (ownsWorkspace && !options.keepWorkspace) {
      await fs.rm(workspaceRoot, { recursive: true, force: true }).catch((error) => {
        console.error('[tools/managers/replay.mjs] rm workspace:', workspaceRoot, error?.message ?? error);
      });
    }
  }
}
