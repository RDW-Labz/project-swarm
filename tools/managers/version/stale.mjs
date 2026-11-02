// SPDX-License-Identifier: Apache-2.0
// Version manager: flag project pointers, watch boards, remotes and installs behind the install release (T-0209).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { versionInfo } from '../../server-version.mjs';

/** Finding codes emitted for version lag (replay fixtures key off these). */
export const STALE_VERSION_FINDING_CODES = Object.freeze([
  'stale-pointer',
  'stale-board',
  'stale-remote',
  'stale-install',
]);

/**
 * @typedef {object} StaleVersionFindingDraft
 * @property {string} code
 * @property {'info' | 'warn' | 'needs_you'} severity
 * @property {string} action
 * @property {string} reason
 * @property {string} [recommendation]
 * @property {string} [lane]
 */

/**
 * @param {string} installRoot
 * @returns {string}
 */
export function resolveInstallHome(installRoot) {
  const resolved = path.resolve(String(installRoot ?? ''));
  if (!resolved) throw new Error('version-install-root-invalid');
  const parent = path.dirname(resolved);
  if (path.basename(parent) === 'versions') return path.dirname(parent);
  return resolved;
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
 * @param {string} projectDir
 * @param {string} releaseVersion
 * @returns {Promise<StaleVersionFindingDraft|null>}
 */
export async function stalePointerFindingForProject(projectDir, releaseVersion) {
  if (!releaseVersion) return null;
  let project;
  try {
    project = await fs.realpath(projectDir);
  } catch {
    return null;
  }
  let pointer;
  try {
    pointer = JSON.parse(await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return {
      code: 'stale-pointer',
      severity: 'warn',
      action: 'bump-pointer',
      reason: `${project}: the pointer file is not readable; fix .project-swarm.json by hand`,
      recommendation: 'Repair the pointer JSON, then run swarm update in the install root',
    };
  }
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) return null;
  const pointerVersion = typeof pointer.version === 'string' ? pointer.version : null;
  const name = path.basename(project);
  if (pointerVersion && pointerVersion !== releaseVersion) {
    return {
      code: 'stale-pointer',
      severity: 'warn',
      action: 'bump-pointer',
      reason: `${name} is linked to project-swarm ${pointerVersion} but the install release is ${releaseVersion}`,
      recommendation: 'Run swarm update in the install root, or bump the pointer version field after the update',
      lane: name.slice(0, 40),
    };
  }
  if (typeof pointer.install === 'string' && pointer.install) {
    let installReal = null;
    try {
      installReal = await fs.realpath(pointer.install);
    } catch {
      return null;
    }
    const installVersion = await readPackageVersion(installReal);
    if (installVersion && installVersion !== releaseVersion) {
      return {
        code: 'stale-install',
        severity: 'warn',
        action: 'show-stale-banner',
        reason: `${name} points at install ${installVersion} but the current release is ${releaseVersion}`,
        recommendation: 'Run swarm update in the install root and refresh project pointers',
        lane: name.slice(0, 40),
      };
    }
  }
  return null;
}

/**
 * @param {object[]} pointerRows
 * @param {string} releaseVersion
 * @returns {StaleVersionFindingDraft[]}
 */
export function stalePointerFindingsFromFixture(pointerRows, releaseVersion) {
  if (!releaseVersion || !Array.isArray(pointerRows)) return [];
  const out = [];
  for (const row of pointerRows) {
    if (!row || typeof row !== 'object') continue;
    const project = typeof row.project === 'string' ? row.project : 'project';
    const pointerVersion = typeof row.pointerVersion === 'string' ? row.pointerVersion : null;
    if (!pointerVersion || pointerVersion === releaseVersion) continue;
    const behind =
      typeof row.releasesBehind === 'number' && Number.isFinite(row.releasesBehind)
        ? ` (${row.releasesBehind} release(s) behind)`
        : '';
    out.push({
      code: 'stale-pointer',
      severity: 'warn',
      action: 'bump-pointer',
      reason: `${project} is linked to project-swarm ${pointerVersion} but the install release is ${releaseVersion}${behind}`,
      recommendation: 'Run swarm update in the install root, then bump project pointers',
      lane: project.slice(0, 40),
    });
  }
  return out;
}

/**
 * @param {string} boardUrl
 * @param {(url: string, init?: object) => Promise<{ ok: boolean, json?: () => Promise<unknown> }>} [fetchImpl]
 * @returns {Promise<{ version: string|null, installedVersion: string|null, stale: boolean }|null>}
 */
export async function readBoardServerVersions(boardUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function' || typeof boardUrl !== 'string' || !boardUrl) return null;
  try {
    const u = new URL(boardUrl);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
    const token = u.searchParams.get('t') ?? '';
    const origin = u.origin;
    const res = await fetchImpl(`${origin}/api/board?t=${encodeURIComponent(token)}`, { redirect: 'manual' });
    if (!res?.ok) return null;
    const body = typeof res.json === 'function' ? await res.json() : null;
    const server = body && typeof body === 'object' ? body.server : null;
    if (!server || typeof server !== 'object') return null;
    const version = typeof server.version === 'string' ? server.version : null;
    const installedVersion = typeof server.installedVersion === 'string' ? server.installedVersion : null;
    const stale = Boolean(server.stale);
    return { version, installedVersion, stale };
  } catch {
    return null;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [home]
 */
function boardRegistryFile(env, home = os.homedir()) {
  return env.SWARM_BOARD_FILE || path.join(home, '.project-swarm', 'board.json');
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [home]
 */
function remoteStateFile(env, home = os.homedir()) {
  return env.SWARM_REMOTE_FILE || path.join(home, '.project-swarm', 'remote.json');
}

/**
 * @param {string} code
 * @param {'board'|'remote'} lane
 * @param {{ version: string|null, installedVersion: string|null, stale: boolean }} server
 * @returns {StaleVersionFindingDraft|null}
 */
function staleServerFinding(code, lane, server) {
  if (!server?.stale || !server.version || !server.installedVersion) return null;
  return {
    code,
    severity: 'warn',
    action: 'show-stale-banner',
    reason: `This ${lane} is running swarm ${server.version} but ${server.installedVersion} is installed; it started before the last update`,
    recommendation:
      lane === 'remote'
        ? 'Run swarm remote off, then swarm remote on, or restart the board after swarm update'
        : 'Stop the board (Ctrl-C) and start it again (swarm watch --all), or restart remote after an update',
    lane,
  };
}

/**
 * @param {{
 *   installRoot: string,
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   fetchImpl?: typeof fetch,
 *   fixture?: { installVersion?: string, pointers?: object[] },
 * }} options
 * @returns {Promise<StaleVersionFindingDraft[]>}
 */
export async function collectStaleVersionFindings(options) {
  const installRoot = String(options?.installRoot ?? '');
  if (!installRoot) throw new Error('version-install-root-invalid');
  const installHome = resolveInstallHome(installRoot);
  const env = options?.env ?? process.env;
  const home = options?.home ?? os.homedir();
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;

  const fixture = options?.fixture;
  let releaseRoot = installRoot;
  try {
    releaseRoot = await fs.realpath(path.join(installHome, 'current'));
  } catch {
    releaseRoot = installRoot;
  }
  const releaseVersion =
    (typeof fixture?.installVersion === 'string' && fixture.installVersion) ||
    (await readPackageVersion(releaseRoot)) ||
    (await readPackageVersion(installHome)) ||
    (await readPackageVersion(installRoot));

  if (!releaseVersion) return [];

  /** @type {StaleVersionFindingDraft[]} */
  const findings = [];

  if (fixture?.pointers) {
    findings.push(...stalePointerFindingsFromFixture(fixture.pointers, releaseVersion));
  } else {
    for (const projectDir of await readProjectsRegistry(installHome)) {
      const finding = await stalePointerFindingForProject(projectDir, releaseVersion);
      if (finding) findings.push(finding);
    }
  }

  // Long-running board: read registry URL and ask the server which version it still runs.
  try {
    const data = JSON.parse(await fs.readFile(boardRegistryFile(env, home), 'utf8'));
    if (data && typeof data.url === 'string') {
      const server = await readBoardServerVersions(data.url, fetchImpl);
      const finding = server ? staleServerFinding('stale-board', 'board', server) : null;
      if (finding) findings.push(finding);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.name !== 'SyntaxError') {
      console.error('[tools/managers/version/stale.mjs] board registry:', error?.message ?? error);
    }
  }

  try {
    const remote = JSON.parse(await fs.readFile(remoteStateFile(env, home), 'utf8'));
    if (remote && typeof remote.port === 'number' && typeof remote.token === 'string') {
      const url = `http://127.0.0.1:${remote.port}/?t=${encodeURIComponent(remote.token)}`;
      const server = await readBoardServerVersions(url, fetchImpl);
      const finding = server ? staleServerFinding('stale-remote', 'remote', server) : null;
      if (finding) findings.push(finding);
    }
  } catch (error) {
    if (
      error?.code !== 'ENOENT'
      && error?.name !== 'SyntaxError'
      && error?.code !== 'ECONNREFUSED'
      && error?.cause?.code !== 'ECONNREFUSED'
    ) {
      console.error('[tools/managers/version/stale.mjs] remote board:', error?.message ?? error);
    }
  }

  // This process (orchestrator) may itself be an older versions/<x> tree while current moved on.
  const self = await versionInfo({ ownRoot: installRoot, ttlMs: 0 });
  if (self.stale && self.version && self.installedVersion) {
    findings.push({
      code: 'stale-install',
      severity: 'warn',
      action: 'show-stale-banner',
      reason: `This swarm process is ${self.version} but ${self.installedVersion} is installed under current`,
      recommendation: 'Restart workers and the board from the updated install (swarm update, then restart watch or remote)',
      lane: 'process',
    });
  }

  return findings;
}
