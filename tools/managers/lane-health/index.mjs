// SPDX-License-Identifier: Apache-2.0
// Lane health manager orchestrator: probe unhealthy lanes and pause, reroute, or shrink (T-0196).

import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseManager } from '../base.mjs';
import { REPLAY_SNAPSHOT_PATHS } from '../replay.mjs';
import { runPreRunLaneProbe } from './probe.mjs';
import {
  LANE_HEALTH_MANAGER_ID,
  planLaneHealthActions,
  REROUTE_TICKETS_ACTION,
  SHRINK_CONCURRENCY_ACTION,
} from './reroute.mjs';

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

/**
 * @param {string} root
 */
async function readProjectLedger(root) {
  const file = path.join(root, '.swarm', 'project', 'tickets.json');
  try {
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return { version: 1, tickets: [] };
    if (!Array.isArray(ledger.tickets)) ledger.tickets = [];
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, tickets: [] };
    throw error;
  }
}

/**
 * @param {string} root
 * @param {object} ledger
 */
async function writeProjectLedger(root, ledger) {
  const file = path.join(root, '.swarm', 'project', 'tickets.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(ledger)}\n`);
}

/**
 * @param {string} root
 */
async function resolveRunManifest(root) {
  const runsDir = path.join(root, '.swarm', 'runs');
  try {
    const ids = await fs.readdir(runsDir);
    let latestFile = null;
    let latestMtime = 0;
    for (const id of ids) {
      const manifestFile = path.join(runsDir, id, 'manifest.json');
      const st = await fs.stat(manifestFile).catch((error) => {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          console.error('[tools/managers/lane-health/index.mjs] resolveRunManifest stat:', manifestFile, error?.message ?? error);
        }
        return null;
      });
      if (st && st.isFile() && st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestFile = manifestFile;
      }
    }
    if (latestFile) return JSON.parse(await fs.readFile(latestFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { lanes: {} };
}

/**
 * @param {string} root
 * @param {string} runId
 * @param {object} manifest
 */
async function writeRunManifest(root, runId, manifest) {
  const file = path.join(root, '.swarm', 'runs', runId, 'manifest.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(manifest)}\n`);
}

/**
 * @param {string} root
 * @returns {Promise<string|null>}
 */
async function latestRunId(root) {
  const runsDir = path.join(root, '.swarm', 'runs');
  try {
    const ids = await fs.readdir(runsDir);
    let latestId = null;
    let latestMtime = 0;
    for (const id of ids) {
      const manifestFile = path.join(runsDir, id, 'manifest.json');
      const st = await fs.stat(manifestFile).catch((error) => {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          console.error('[tools/managers/lane-health/index.mjs] latestRunId stat:', manifestFile, error?.message ?? error);
        }
        return null;
      });
      if (st && st.isFile() && st.mtimeMs > latestMtime) {
        latestMtime = st.mtimeMs;
        latestId = id;
      }
    }
    return latestId;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {object|null|undefined} ledger
 */
function readyTicketCount(ledger) {
  const tickets = Array.isArray(ledger?.tickets) ? ledger.tickets : [];
  return tickets.filter(t => t?.status === 'ready').length;
}

class LaneHealthManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: {
   *     laneStore?: unknown,
   *     lanesDownBeforeFirstWave?: unknown,
   *     ledger?: object,
   *     manifest?: object,
   *     downSince?: Record<string, number>,
   *     recovered?: readonly string[],
   *     contract?: string,
   *     ready?: number,
   *     runId?: string,
   *   },
   *   env?: NodeJS.ProcessEnv,
   * }} config
   */
  constructor({ root, modeSettings, trigger = 'scope', fixture, env }) {
    super({ managerId: LANE_HEALTH_MANAGER_ID, root, modeSettings, trigger });
    this.fixture = fixture;
    this.env = env ?? process.env;
    /** @type {string|null} */
    this._manifestRunId = null;
    /** @type {object|null} */
    this._manifest = null;
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} ctx
   */
  async execute(ctx) {
    const now = Date.now();
    const ledger = this.fixture?.ledger
      ? structuredClone(this.fixture.ledger)
      : await readProjectLedger(this.root);

    const laneStoreFile = this.fixture?.laneStore
      ? undefined
      : path.join(this.root, REPLAY_SNAPSHOT_PATHS.laneStore);

    const probe = await runPreRunLaneProbe({
      laneStore: this.fixture?.laneStore,
      laneStoreFile,
      lanesDownBeforeFirstWave: this.fixture?.lanesDownBeforeFirstWave,
      now,
      env: this.env,
    });

    const manifest = this.fixture?.manifest
      ? structuredClone(this.fixture.manifest)
      : await resolveRunManifest(this.root);
    this._manifest = manifest;
    this._manifestRunId = this.fixture?.runId ?? await latestRunId(this.root);

    const planned = planLaneHealthActions({
      findings: probe.findings,
      unhealthy: probe.unhealthy,
      ledger,
      manifest,
      contract: this.fixture?.contract ?? ledger?.scope?.name,
      ready: this.fixture?.ready ?? readyTicketCount(ledger),
      now,
      downSince: this.fixture?.downSince,
      recovered: this.fixture?.recovered,
      env: this.env,
    });

    for (const action of planned) {
      const persistLedger = action.action === REROUTE_TICKETS_ACTION && action.apply;
      const persistManifest = action.action === SHRINK_CONCURRENCY_ACTION && action.apply;
      await this.emitFinding(
        {
          severity: action.severity,
          code: action.code,
          reason: action.reason,
          action: action.action,
          lane: action.lane,
          ticket: action.ticket,
          recommendation: action.recommendation,
        },
        {
          apply: action.apply
            ? async () => {
                await action.apply();
                if (persistLedger) await writeProjectLedger(this.root, ledger);
                if (persistManifest && this._manifest && this._manifestRunId) {
                  await writeRunManifest(this.root, this._manifestRunId, this._manifest);
                }
              }
            : undefined,
        },
      );
    }
  }
}

/**
 * @param {{
 *   managerId: import('../modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: ManagerActionModeSettings,
 *   trigger?: ManagerTrigger,
 *   fixture?: LaneHealthManager['fixture'],
 *   env?: NodeJS.ProcessEnv,
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== LANE_HEALTH_MANAGER_ID) {
    throw new Error(
      `lane-health manager createManager expected managerId ${LANE_HEALTH_MANAGER_ID}, got ${String(options.managerId)}`,
    );
  }
  return new LaneHealthManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & {
 *   fixture?: LaneHealthManager['fixture'],
 *   env?: NodeJS.ProcessEnv,
 * }} options
 */
export async function runBuiltinManager(options) {
  const manager = new LaneHealthManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
    fixture: options.fixture,
    env: options.env,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;

export { LANE_HEALTH_MANAGER_ID };
