import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const MARKER = '.legacy-migration.json';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function externalStatePrimary(env = process.env) {
  return env.SWARM_EXTERNAL_STATE_PRIMARY === '1';
}

export function stateFolder(projectId, home = os.homedir()) {
  if (typeof projectId !== 'string' || !SAFE_ID.test(projectId)) {
    throw new Error('invalid project id: ' + String(projectId));
  }
  return path.join(home, '.project-swarm', 'projects', projectId);
}

async function listFiles(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function migrateState({ repoRoot, projectId, home = os.homedir() }) {
  const legacy = path.join(repoRoot, '.swarm');
  const dest = stateFolder(projectId, home);
  const markerPath = path.join(dest, MARKER);
  await fs.mkdir(dest, { recursive: true });

  let marker = { files: [] };
  if (await exists(markerPath)) {
    marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  }
  const known = new Set(marker.files || []);

  const copied = [];
  for (const rel of await listFiles(legacy)) {
    const target = path.join(dest, rel);
    if (known.has(rel) || (await exists(target))) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.copyFile(path.join(legacy, rel), target, fsc.COPYFILE_EXCL);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    copied.push(rel);
    known.add(rel);
  }

  marker = {
    files: [...known].sort(),
    lastRunAt: new Date().toISOString(),
  };
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  return { copied, dest };
}

export async function dualWriteRun({ repoRoot, projectId, relPath, text, home = os.homedir(), env = process.env }) {
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
    throw new Error('unsafe relative path: ' + relPath);
  }
  const dest = stateFolder(projectId, home);
  const stateTarget = path.join(dest, relPath);
  await fs.mkdir(path.dirname(stateTarget), { recursive: true });
  await fs.writeFile(stateTarget, text, 'utf8');

  if (!externalStatePrimary(env)) {
    const legacyTarget = path.join(repoRoot, '.swarm', relPath);
    await fs.mkdir(path.dirname(legacyTarget), { recursive: true });
    await fs.writeFile(legacyTarget, text, 'utf8');
  }
  return { stateTarget };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , cmd, sub, idArg] = process.argv;
  if (cmd === 'migrate' && sub === 'state') {
    const projectId = idArg || process.env.SWARM_PROJECT_ID;
    if (!projectId) {
      console.error('usage: swarm migrate state <project-id>');
      process.exit(2);
    }
    migrateState({ repoRoot: process.cwd(), projectId })
      .then((r) => console.log(JSON.stringify({ copied: r.copied.length, dest: r.dest })))
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
  } else {
    console.error('usage: node tools/state-migrate.mjs migrate state <project-id>');
    process.exit(2);
  }
}
