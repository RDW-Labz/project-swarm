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

async function fileExists(fsImpl, file) {
  try {
    await fsImpl.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readRegistryRoots(registryFile, fsImpl) {
  try {
    const text = await fsImpl.readFile(registryFile, 'utf8');
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : [];
    const roots = [];
    for (const row of rows) {
      if (typeof row === 'string') roots.push(resolveDir(row));
      else if (row && typeof row.root === 'string') roots.push(resolveDir(row.root));
    }
    return roots;
  } catch {
    return [];
  }
}

async function pointerHasLedger(dir, fsImpl) {
  const file = path.join(dir, '.project-swarm.json');
  try {
    const data = JSON.parse(await fsImpl.readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const ledger = data.ledger;
    if (ledger === undefined || ledger === null || ledger === false) return false;
    if (typeof ledger === 'string') return ledger.trim().length > 0;
    if (typeof ledger === 'object') return Object.keys(ledger).length > 0;
    return Boolean(ledger);
  } catch {
    return false;
  }
}

export async function holdsSwarmState(dir, { fs: fsImpl = fs, registryFile } = {}) {
  const resolved = resolveDir(dir);
  if (await fileExists(fsImpl, path.join(resolved, '.swarm', 'project', 'tickets.json'))) return true;
  const runsDir = path.join(resolved, '.swarm', 'runs');
  try {
    const entries = await fsImpl.readdir(runsDir);
    if (entries.some(name => name && name !== '.' && name !== '..')) return true;
  } catch { /* no runs */ }
  if (registryFile) {
    const roots = await readRegistryRoots(registryFile, fsImpl);
    if (roots.some(root => root === resolved)) return true;
  }
  if (await pointerHasLedger(resolved, fsImpl)) return true;
  return false;
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
    await fsImpl.appendFile(file, line, { flag: 'a', mode: 0o600 });
    try { fssync.chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch { /* never throws */ }
}

export async function refuseStateHolderDeletion(dir, caller, { home, env = process.env, fs: fsImpl = fs, registryFile, now = () => new Date() } = {}) {
  if (!(await holdsSwarmState(dir, { fs: fsImpl, registryFile }))) return false;
  await recordDeletion({ dir, caller, outcome: 'refused', home, env, fs: fsImpl, now });
  return true;
}
