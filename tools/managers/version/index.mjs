// SPDX-License-Identifier: Apache-2.0
// Version manager orchestrator: stale flags, safe pointer bump, idle update scheduling (T-0210).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BaseManager } from '../base.mjs';
import { collectStaleVersionFindings, resolveInstallHome } from './stale.mjs';

const execFileAsync = promisify(execFile);
const managersVersionDir = path.dirname(fileURLToPath(import.meta.url));
const swarmPackageRoot = path.resolve(managersVersionDir, '..', '..', '..');

/** @typedef {import('../modes.mjs').ManagerActionModeSettings} ManagerActionModeSettings */
/** @typedef {import('../registry.mjs').RunBuiltinManagerOptions} RunBuiltinManagerOptions */
/** @typedef {import('../../contracts/managers.json').components.schemas.ManagerTrigger} ManagerTrigger */

const IDLE_UPDATE_SCHEDULE_VERSION = 1;
const IDLE_UPDATE_SCHEDULE_BASENAME = 'version-update-idle.json';

/**
 * @param {string} installHome
 */
function idleUpdateSchedulePath(installHome) {
  return path.join(installHome, '.swarm', IDLE_UPDATE_SCHEDULE_BASENAME);
}

/**
 * @param {string} installHome
 */
async function readIdleUpdateSchedule(installHome) {
  try {
    const value = JSON.parse(await fs.readFile(idleUpdateSchedulePath(installHome), 'utf8'));
    if (!value || typeof value !== 'object' || value.version !== IDLE_UPDATE_SCHEDULE_VERSION) return null;
    if (typeof value.requestedAt !== 'string' || typeof value.targetVersion !== 'string') return null;
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

/**
 * @param {string} installHome
 * @param {{ requestedAt: string, targetVersion: string }} schedule
 */
async function writeIdleUpdateSchedule(installHome, schedule) {
  const file = idleUpdateSchedulePath(installHome);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const body = {
    version: IDLE_UPDATE_SCHEDULE_VERSION,
    requestedAt: schedule.requestedAt,
    targetVersion: schedule.targetVersion,
  };
  await fs.writeFile(temp, `${JSON.stringify(body)}\n`, { flag: 'wx' });
  await fs.rename(temp, file);
}

/**
 * @param {string} installHome
 */
async function clearIdleUpdateSchedule(installHome) {
  try {
    await fs.unlink(idleUpdateSchedulePath(installHome));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * @param {string} installHome
 */
async function readProjectsRegistry(installHome) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(installHome, '.swarm-projects.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} dir
 */
async function readPackageVersion(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const version = pkg?.version;
    return typeof version === 'string' && version.length ? version : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} projectRoot
 */
async function resolveProjectInstallRoot(projectRoot) {
  const projectSwarmJsonPath = path.join(projectRoot, '.project-swarm.json');
  try {
    const pointer = JSON.parse(await fs.readFile(projectSwarmJsonPath, 'utf8'));
    if (typeof pointer?.install === 'string' && pointer.install) {
      return await fs.realpath(pointer.install);
    }
  } catch (error) {
    if (!(error?.code === 'ENOENT' && error?.path === projectSwarmJsonPath)) {
      console.error('[tools/managers/version/index.mjs] resolveProjectInstallRoot:', error?.message ?? error, projectRoot);
    }
  }
  return await fs.realpath(swarmPackageRoot);
}

/**
 * @param {string} installHome
 * @param {string} installRoot
 * @param {{ installVersion?: string }} [fixture]
 */
async function readReleaseVersion(installHome, installRoot, fixture) {
  if (typeof fixture?.installVersion === 'string' && fixture.installVersion) return fixture.installVersion;
  let releaseRoot = installRoot;
  try {
    releaseRoot = await fs.realpath(path.join(installHome, 'current'));
  } catch {
    releaseRoot = installRoot;
  }
  return (
    (await readPackageVersion(releaseRoot)) ||
    (await readPackageVersion(installHome)) ||
    (await readPackageVersion(installRoot))
  );
}

/**
 * @param {string} installHome
 * @param {import('./stale.mjs').StaleVersionFindingDraft} draft
 */
async function projectDirForStalePointer(installHome, draft) {
  if (draft.code !== 'stale-pointer' || draft.action !== 'bump-pointer' || !draft.lane) return null;
  for (const projectDir of await readProjectsRegistry(installHome)) {
    const name = path.basename(projectDir);
    if (draft.lane === name.slice(0, 40)) return projectDir;
  }
  return null;
}

/**
 * @param {string} installRoot
 */
async function resolveSwarmUpdateRunner(installRoot) {
  const installHome = resolveInstallHome(installRoot);
  const candidates = [
    path.join(installHome, 'current', 'tools', 'swarm.mjs'),
    path.join(installHome, 'tools', 'swarm.mjs'),
    path.join(installRoot, 'tools', 'swarm.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error('[tools/managers/version/index.mjs] resolveSwarmUpdateRunner:', error?.message ?? error, candidate);
      }
    }
  }
  return null;
}

/**
 * Run `swarm update --yes` in a fresh process so the new release's installer runs (field lesson: updater).
 *
 * @param {string} installRoot
 */
async function runSwarmUpdateFresh(installRoot) {
  const installHome = resolveInstallHome(installRoot);
  const runner = await resolveSwarmUpdateRunner(installRoot);
  if (!runner) throw new Error('version-update-runner-missing');
  await execFileAsync(process.execPath, [runner, 'update', '--yes'], {
    cwd: installHome,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * @param {string} installHome
 * @param {string} installRoot
 */
async function machineBusyForUpdate(installHome, installRoot) {
  const { boardSummary } = await import('../../board.mjs');
  const { runs } = await boardSummary();
  if (runs?.length) return { busy: true, detail: 'live swarm runs are active' };

  const { readLauncher } = await import('../../swarm-bin.mjs');
  const launcher = await readLauncher(os.homedir());
  const dirs = new Set(
    [launcher?.installRoot, installHome, installRoot]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => path.resolve(value)),
  );
  for (const dir of dirs) {
    try {
      dirs.add(await fs.realpath(dir));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error('[tools/managers/version/index.mjs] machineBusyForUpdate realpath:', error?.message ?? error, dir);
      }
    }
  }

  const { runningSwarmCommands } = await import('../../live-processes.mjs');
  const processes = runningSwarmCommands({ installDirs: [...dirs] });
  if (processes.length) return { busy: true, detail: 'swarm commands are running from the install' };

  const { liveBusyMarkers } = await import('../../busy-marker.mjs');
  const markers = (await liveBusyMarkers()).filter((marker) => marker.pid !== process.pid);
  if (markers.length) return { busy: true, detail: 'swarm busy markers are active' };

  return { busy: false };
}

/**
 * @param {string} installRoot
 */
async function readUpdateAvailability(installRoot) {
  const { swarmVersion } = await import('../../swarm.mjs');
  const installHome = resolveInstallHome(installRoot);
  const info = await swarmVersion(installHome, { check: true });
  return {
    current: info.version ?? null,
    latest: info.latest ?? null,
    updateAvailable: Boolean(info.updateAvailable),
  };
}

class VersionManager extends BaseManager {
  /**
   * @param {{
   *   root: string,
   *   modeSettings: ManagerActionModeSettings,
   *   trigger?: ManagerTrigger,
   *   fixture?: { installVersion?: string, pointers?: object[] },
   *   installRoot?: string,
   *   env?: NodeJS.ProcessEnv,
   *   home?: string,
   *   fetchImpl?: typeof fetch,
   * }} config
   */
  constructor({
    root,
    modeSettings,
    trigger = 'scope',
    fixture,
    installRoot,
    env,
    home,
    fetchImpl,
  }) {
    super({ managerId: 'version', root, modeSettings, trigger });
    /** @type {{ installVersion?: string, pointers?: object[] }|undefined} */
    this.fixture = fixture;
    /** @type {string|undefined} */
    this.installRootOverride = installRoot;
    this.env = env ?? process.env;
    this.home = home ?? os.homedir();
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  /**
   * @param {import('../base.mjs').ManagerRunContext} ctx
   */
  async execute(ctx) {
    const installRoot = this.installRootOverride
      ? path.resolve(this.installRootOverride)
      : await resolveProjectInstallRoot(this.root);
    const installHome = resolveInstallHome(installRoot);
    const releaseVersion = await readReleaseVersion(installHome, installRoot, this.fixture);

    const drafts = await collectStaleVersionFindings({
      installRoot,
      env: this.env,
      home: this.home,
      fetchImpl: this.fetchImpl,
      fixture: this.fixture,
    });

    for (const draft of drafts) {
      const projectDir =
        draft.action === 'bump-pointer' ? await projectDirForStalePointer(installHome, draft) : null;
      await this.emitFinding(
        {
          severity: draft.severity,
          code: draft.code,
          reason: draft.reason,
          action: draft.action,
          lane: draft.lane,
          recommendation: draft.recommendation,
        },
        {
          apply:
            draft.action === 'bump-pointer' && projectDir && releaseVersion
              ? async () => {
                  const { writePointer } = await import('../../install.mjs');
                  const install = await fs.realpath(installHome);
                  await writePointer(projectDir, { install, version: releaseVersion });
                }
              : undefined,
        },
      );
    }

    let availability = { current: releaseVersion, latest: null, updateAvailable: false };
    try {
      availability = await readUpdateAvailability(installRoot);
    } catch (error) {
      console.error('[tools/managers/version/index.mjs] readUpdateAvailability:', error?.message ?? error, installRoot);
    }

    const busy = await machineBusyForUpdate(installHome, installRoot);
    const schedule = await readIdleUpdateSchedule(installHome);

    if (availability.updateAvailable && availability.latest) {
      if (busy.busy) {
        await this.emitFinding({
          severity: 'needs_you',
          code: 'update-blocked',
          action: 'update-mid-run',
          reason: `Release ${availability.latest} is available but swarm will not update while work is running (${busy.detail})`,
          recommendation: 'Wait for runs to finish, or run swarm update --force yourself',
          lane: 'install',
        });

        await this.emitFinding(
          {
            severity: 'info',
            code: 'update-when-idle',
            action: 'schedule-update-idle',
            reason: `Will run swarm update to ${availability.latest} when the machine is idle (install is ${availability.current})`,
            recommendation:
              'Leave runs to finish; with schedule-update-idle in auto, the version manager records the request and updates on the next idle pass',
            lane: 'install',
          },
          {
            apply: async () => {
              await writeIdleUpdateSchedule(installHome, {
                requestedAt: new Date().toISOString(),
                targetVersion: availability.latest,
              });
            },
          },
        );
      } else if (this.trigger === 'idle') {
        const shouldRun =
          schedule?.targetVersion === availability.latest ||
          this.actionMode('schedule-update-idle') === 'auto';
        if (shouldRun) {
          await this.emitFinding(
            {
              severity: 'info',
              code: 'update-when-idle',
              action: 'schedule-update-idle',
              reason: `Machine is idle; running swarm update to ${availability.latest}`,
              recommendation:
                'Restart the board or swarm remote after the update if they were already running',
              lane: 'install',
            },
            {
              apply: async () => {
                await runSwarmUpdateFresh(installRoot);
                await clearIdleUpdateSchedule(installHome);
                const { bumpPointers } = await import('../../swarm.mjs');
                await bumpPointers(installHome);
              },
            },
          );
        }
      }
    } else if (schedule) {
      await clearIdleUpdateSchedule(installHome);
    }
  }
}

/**
 * @param {{
 *   managerId: import('../modes.mjs').ManagerId,
 *   root: string,
 *   modeSettings: ManagerActionModeSettings,
 *   trigger?: ManagerTrigger,
 *   fixture?: { installVersion?: string, pointers?: object[] },
 *   installRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createManager(options) {
  if (options.managerId !== 'version') {
    throw new Error(`version manager createManager expected managerId version, got ${String(options.managerId)}`);
  }
  return new VersionManager(options);
}

/**
 * @param {RunBuiltinManagerOptions & {
 *   fixture?: { installVersion?: string, pointers?: object[] },
 *   installRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export async function runBuiltinManager(options) {
  const manager = new VersionManager({
    root: options.root,
    modeSettings: options.modeSettings,
    trigger: options.trigger ?? 'scope',
    fixture: options.fixture,
    installRoot: options.installRoot,
    env: options.env,
    home: options.home,
    fetchImpl: options.fetchImpl,
  });
  return manager.run({
    journal: options.journal,
    now: options.now,
    best: options.best,
  });
}

/** @type {typeof runBuiltinManager} */
export const run = runBuiltinManager;
