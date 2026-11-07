// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

// `swarm forget --scratch` removes scratch checkouts from tools/projects.mjs (runForgetCommand).
// That path is not wired here: there is no shared checkout-removal helper exported from projects.mjs
// that gc/core-71 already call, and tools/swarm.mjs is out of scope for this worktree.

export function projectSwarmHome(home, env = process.env) {
  const override = env.PROJECT_SWARM_HOME;
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return path.join(home, '.project-swarm');
}

export function deletionsLogFile(home, env = process.env) {
  return path.join(projectSwarmHome(home, env), 'deletions.log');
}

function resolveDir(dir) {
  return path.resolve(dir);
}

function isENOENT(err) {
  return err && (err.code === 'ENOENT' || err.errno === -2);
}

async function realpathResolved(fsImpl, dir) {
  try {
    return await fsImpl.realpath(dir);
  } catch (err) {
    if (isENOENT(err)) return resolveDir(dir);
    throw err;
  }
}

async function pathAccessible(fsImpl, file) {
  try {
    await fsImpl.access(file);
    return true;
  } catch (err) {
    if (isENOENT(err)) return false;
    throw err;
  }
}

async function readRegistryRoots(registryFile, fsImpl) {
  let text;
  try {
    text = await fsImpl.readFile(registryFile, 'utf8');
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('registry-parse-failed');
  }
  const rows = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : [];
  const roots = [];
  for (const row of rows) {
    if (typeof row === 'string') roots.push(resolveDir(row));
    else if (row && typeof row.root === 'string') roots.push(resolveDir(row.root));
  }
  return roots;
}

async function registryMatches(resolved, roots, fsImpl) {
  let resolvedReal;
  try {
    resolvedReal = await realpathResolved(fsImpl, resolved);
  } catch {
    return true;
  }
  const prefix = `${resolvedReal}${path.sep}`;
  for (const root of roots) {
    let rootReal;
    try {
      rootReal = await fsImpl.realpath(root);
    } catch (err) {
      if (isENOENT(err)) {
        rootReal = resolveDir(root);
      } else {
        return true;
      }
    }
    if (rootReal === resolvedReal) return true;
    if (rootReal.startsWith(prefix)) return true;
  }
  return false;
}

async function pointerHasLedger(dir, fsImpl) {
  const file = path.join(dir, '.project-swarm.json');
  try {
    const text = await fsImpl.readFile(file, 'utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return true;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const ledger = data.ledger;
    if (ledger === undefined || ledger === null || ledger === false) return false;
    if (typeof ledger === 'string') return ledger.trim().length > 0;
    if (typeof ledger === 'object') return Object.keys(ledger).length > 0;
    return Boolean(ledger);
  } catch (err) {
    if (isENOENT(err)) return false;
    return true;
  }
}

export async function holdsSwarmState(dir, { fs: fsImpl = fs, registryFile } = {}) {
  const resolved = resolveDir(dir);
  try {
    if (await pathAccessible(fsImpl, path.join(resolved, '.swarm', 'project', 'tickets.json'))) return true;
    const runsDir = path.join(resolved, '.swarm', 'runs');
    try {
      const entries = await fsImpl.readdir(runsDir);
      if (entries.some(name => name && name !== '.' && name !== '..')) return true;
    } catch (err) {
      if (!isENOENT(err)) return true;
    }
    if (registryFile) {
      let roots;
      try {
        roots = await readRegistryRoots(registryFile, fsImpl);
      } catch {
        return true;
      }
      if (await registryMatches(resolved, roots, fsImpl)) return true;
    }
    if (await pointerHasLedger(resolved, fsImpl)) return true;
    return false;
  } catch {
    return true;
  }
}

export async function assertNotStateHolder(dir, caller, options = {}) {
  if (await holdsSwarmState(dir, options)) {
    const err = new Error(`state-holder-refused: refusing to delete swarm state at ${resolveDir(dir)} (${caller})`);
    err.code = 'state-holder-refused';
    throw err;
  }
}

export async function recordDeletion({ dir, caller, outcome, home, now = () => new Date(), env = process.env, fs: fsImpl = fs }) {
  try {
    const file = deletionsLogFile(home, env);
    await fsImpl.mkdir(path.dirname(file), { recursive: true });
    const line = `${JSON.stringify({
      at: now().toISOString(),
      dir: resolveDir(dir),
      caller,
      outcome,
    })}\n`;
    const flags = fssync.constants.O_WRONLY | fssync.constants.O_APPEND | fssync.constants.O_CREAT | fssync.constants.O_NOFOLLOW;
    const handle = await fsImpl.open(file, flags, 0o600);
    try {
      await handle.chmod(0o600).catch(() => {});
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  } catch (auditError) {
    console.error('[tools/state-guard.mjs] recordDeletion', caller, outcome, auditError?.message ?? auditError);
  }
}

export async function refuseStateHolderDeletion(dir, caller, { home, env = process.env, fs: fsImpl = fs, registryFile, now = () => new Date() } = {}) {
  if (!(await holdsSwarmState(dir, { fs: fsImpl, registryFile }))) return false;
  await recordDeletion({ dir, caller, outcome: 'refused', home, env, fs: fsImpl, now });
  return true;
}
