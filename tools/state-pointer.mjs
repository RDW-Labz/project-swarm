import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const POINTER_FILE = '.project-swarm-state';

export function stateRoot(home = os.homedir()) {
  return path.join(home, '.project-swarm', 'projects');
}

export async function writePointer(repoRoot, projectId, { pointerFile = POINTER_FILE } = {}) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
    throw new Error('invalid project id');
  }
  const file = path.join(repoRoot, pointerFile);
  await fs.writeFile(file, projectId + '\n', 'utf8');
  return file;
}

export async function readPointerId(repoRoot, { pointerFile = POINTER_FILE } = {}) {
  const raw = await fs.readFile(path.join(repoRoot, pointerFile), 'utf8');
  const id = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('invalid pointer contents');
  }
  return id;
}

export async function resolvePointer(repoRoot, options = {}) {
  const id = await readPointerId(repoRoot, options);
  return path.join(stateRoot(options.home), id) + path.sep;
}
