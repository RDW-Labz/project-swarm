// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_STATE_FILES = Object.freeze([
  '.swarm/project/tickets.json',
  '.swarm/project/tickets.log',
  '.swarm/project/leases.json',
  '.swarm/project/backlog.json',
  '.swarm/project/plan.json',
  '.swarm/project/journal.ndjson',
  '.swarm/project/checkpoints',
  'coordination/TASK.md',
  'coordination/HANDOFF.md',
  'coordination/swarm-lessons.jsonl',
  'docs/state/usage-ledger.md',
]);

export function machineStateDir({ env = process.env, home = env.HOME || process.env.HOME } = {}) {
  return path.join(env.SWARM_HOME || path.join(home, '.project-swarm'), 'state');
}

export function projectStateDir(stateDir, projectId) {
  const safe = String(projectId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
  return path.join(stateDir, 'projects', safe);
}

async function copyFileOrDir(source, target) {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) return false;
  if (stat.isSymbolicLink()) return false;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (stat.isDirectory()) {
    await fs.cp(source, target, { recursive: true, force: true, filter: entry => !path.basename(entry).startsWith('.') || path.basename(entry) === '.swarm' });
    return true;
  }
  if (!stat.isFile()) return false;
  await fs.copyFile(source, target);
  return true;
}

export async function snapshotProjectState(root, { stateDir = machineStateDir(), projectId } = {}) {
  if (!projectId) throw Object.assign(new Error('projectId is required'), { code: 'state-sync-invalid' });
  const dest = projectStateDir(stateDir, projectId);
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const relative of PROJECT_STATE_FILES) {
    const source = path.join(root, relative);
    const target = path.join(dest, relative);
    if (await copyFileOrDir(source, target)) copied.push(relative);
  }
  await fs.writeFile(path.join(dest, 'source.json'), `${JSON.stringify({ root, projectId, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  return { dest, copied };
}

export async function restoreProjectState(root, { stateDir = machineStateDir(), projectId } = {}) {
  if (!projectId) throw Object.assign(new Error('projectId is required'), { code: 'state-sync-invalid' });
  const sourceDir = projectStateDir(stateDir, projectId);
  const copied = [];
  for (const relative of PROJECT_STATE_FILES) {
    const source = path.join(sourceDir, relative);
    const target = path.join(root, relative);
    if (await copyFileOrDir(source, target)) copied.push(relative);
  }
  return { copied };
}

export async function listSnapshotProjects({ stateDir = machineStateDir() } = {}) {
  const dir = path.join(stateDir, 'projects');
  const names = await fs.readdir(dir).catch(() => []);
  return names;
}

export async function syncStateToPeer({ stateDir = machineStateDir(), target, key, run, home = process.env.HOME } = {}) {
  const env = { ...process.env, HOME: home };
  const result = await run('rsync', ['-a', '--delete', '-e', `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${key}`, `${stateDir}/`, `${target.user}@${target.host}:~/.project-swarm/state/`], { env, timeout: 10 * 60 * 1000 });
  if (result.code !== 0) throw Object.assign(new Error(`state sync failed: ${String(result.stderr ?? '').trim()}`), { code: 'state-sync-failed' });
  return { synced: true };
}

export async function snapshotCatalog({ stateDir = machineStateDir(), env = process.env, home = env.HOME } = {}) {
  const dest = path.join(stateDir, 'catalog');
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of ['projects.json', 'machines.json']) {
    const source = path.join(env.SWARM_HOME || path.join(home, '.project-swarm'), name);
    if (await copyFileOrDir(source, path.join(dest, name))) copied.push(name);
  }
  return { dest, copied };
}
