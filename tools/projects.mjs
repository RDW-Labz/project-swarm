// SPDX-License-Identifier: Apache-2.0
// The machine's list of projects (every folder swarm has worked in), for the Swarm Watch board. One small file in the user's home.
// A project is identified by the real path of its root; its id is a short hash of that path. Nothing here reads a project's files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const projectsFile = (env = process.env, home = os.homedir()) => env.SWARM_PROJECTS_FILE || path.join(home, '.project-swarm', 'projects.json');
export const projectId = root => createHash('sha256').update(root).digest('hex').slice(0, 12);
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

let queue = Promise.resolve();
const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

// One entry per folder, and an entry's id must be the hash of its own root: a hand-edited or doubled entry is dropped, not counted twice.
const valid = list => {
  const seen = new Set();
  return list.filter(p => {
    if (!isObj(p) || typeof p.root !== 'string' || !path.isAbsolute(p.root) || typeof p.id !== 'string' || p.id !== projectId(p.root) || seen.has(p.root)) return false;
    seen.add(p.root);
    return true;
  });
};

export async function listProjects({ file = projectsFile() } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return valid(isObj(data) && Array.isArray(data.projects) ? data.projects : []);
  } catch { return []; }
}

// For writers: the same list, but a file that exists and cannot be read is an error (never "empty"), so a damaged list is never overwritten.
async function listForWrite(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error(`projects-unreadable: ${file} is damaged; fix or move it (nothing was written)`), { code: 'projects-unreadable' }); }
  return valid(isObj(data) && Array.isArray(data.projects) ? data.projects : []);
}

async function write(file, projects) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

// Scratch folders (a test's temp dir) are not projects unless the registry file was chosen explicitly.
// Scratch places: the temp directory (as the OS and as /private/tmp), and anything inside a .swarm folder (worker copies, worktrees).
const inTmp = async real => {
  const bases = new Set([path.resolve(os.tmpdir()), await fs.realpath(os.tmpdir()).catch(() => null), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].filter(Boolean));
  return [...bases].some(tmp => real === tmp || real.startsWith(tmp + path.sep)) || real.split(path.sep).includes('.swarm') || real.split(path.sep).some(p => p.startsWith('.tmp'));
};

// A test or temp project, by its path alone (no disk access): inside the temp directory, a hidden .tmp* folder (the tests' scratch base), or a .swarm folder.
// The board hides these by default (with a switch to show them).
export function isScratchRoot(root, { tmpdir = os.tmpdir() } = {}) {
  const real = String(root);
  const parts = real.split(path.sep);
  const bases = [path.resolve(tmpdir), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/private/var/folders', '/var/folders'];
  return bases.some(b => real === b || real.startsWith(b + path.sep)) || parts.includes('.swarm') || parts.some(p => p.startsWith('.tmp'));
}

// Adds the project (or refreshes its lastSeen). Returns { project, added } or null when the folder is not a project to list.
export function registerProject(root, { file = projectsFile(), env = process.env, now = Date.now, name } = {}) {
  return serial(async () => {
    let real;
    try { real = await fs.realpath(root); } catch { return null; }
    if (!(await fs.stat(real).then(s => s.isDirectory(), () => false))) return null;
    if (!env.SWARM_PROJECTS_FILE && await inTmp(real)) return null;
    const projects = await listForWrite(file);
    const id = projectId(real);
    const at = new Date(now()).toISOString();
    const known = projects.find(p => p.id === id);
    if (known) { if (Date.parse(known.lastSeen) > now() - 60000) return { project: known, added: false }; known.lastSeen = at; await write(file, projects); return { project: known, added: false }; }
    const project = { id, root: real, name: String(name ?? path.basename(real)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || id, addedAt: at, lastSeen: at };
    projects.push(project);
    await write(file, projects);
    return { project, added: true };
  });
}

export function removeProject(id, { file = projectsFile() } = {}) {
  return serial(async () => {
    const projects = await listForWrite(file);
    const left = projects.filter(p => p.id !== id);
    if (left.length === projects.length) return false;
    await write(file, left);
    return true;
  });
}
