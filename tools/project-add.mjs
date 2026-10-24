import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const run = promisify(execFile);

async function gitRemote(dir) {
  try {
    const { stdout } = await run('git', ['-C', dir, 'config', '--get', 'remote.origin.url']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function addProject(target, opts = {}) {
  const abs = path.resolve(target);
  const info = await stat(abs).catch(() => null);
  if (!info || !info.isDirectory()) throw new Error('not a directory: ' + abs);
  const root = await realpath(abs);
  const remote = await gitRemote(root);
  const pointerDir = path.join(root, '.swarm');
  const pointerPath = path.join(pointerDir, 'pointer.json');
  const entry = { name: path.basename(root), root, remote, registeredAt: new Date().toISOString() };
  await mkdir(pointerDir, { recursive: true });
  await writeFile(pointerPath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  const home = opts.home ?? process.env.PROJECT_SWARM_HOME ?? path.join(os.homedir(), '.project-swarm');
  await mkdir(home, { recursive: true });
  const registryPath = path.join(home, 'projects.json');
  let registry = { projects: [] };
  try {
    registry = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!Array.isArray(registry.projects)) registry.projects = [];
  const idx = registry.projects.findIndex((p) => p.root === root);
  if (idx >= 0) registry.projects[idx] = entry; else registry.projects.push(entry);
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  return { root, pointerPath, registryPath, entry };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === 'add') args.shift();
  const target = args[0] ?? '.';
  addProject(target).then(
    (r) => {
      process.stdout.write('registered ' + r.root + '\n');
      process.exitCode = 0;
    },
    (err) => {
      process.stderr.write('swarm add: ' + err.message + '\n');
      process.exitCode = 1;
    }
  );
}
