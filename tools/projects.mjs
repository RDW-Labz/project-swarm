// SPDX-License-Identifier: Apache-2.0
// The machine's list of projects (every folder swarm has worked in), for the Swarm Watch board. One small file in the user's home.
// A project is identified by the real path of its root; its id is a short hash of that path. Nothing here reads a project's files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isScratchRoot as scratchRootOf, scratchRootList } from './scratch-roots.mjs';

export const projectsFile = (env = process.env, home = os.homedir()) => env.SWARM_PROJECTS_FILE || path.join(home, '.project-swarm', 'projects.json');
export const projectId = root => createHash('sha256').update(root).digest('hex').slice(0, 12);
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

export { scratchRootList };
export function isScratchRoot(root, options = {}) {
  return scratchRootOf(root, options);
}

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

async function rootExists(root) {
  try {
    const stat = await fs.stat(root);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// Owner inbox, phone sync and swarm inbox --all build from listProjects; the board still lists every registered project.
function ownerInboxContext() {
  const stack = new Error().stack ?? '';
  return /phone-commands\.mjs/.test(stack) || /inbox-commands\.mjs/.test(stack);
}

export async function listProjects({ file = projectsFile(), forOwner, includeScratch, pruneGone } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    let projects = valid(isObj(data) && Array.isArray(data.projects) ? data.projects : []);
    const owner = forOwner ?? (includeScratch === true ? false : ownerInboxContext());
    const dropGone = pruneGone ?? owner;
    if (dropGone) {
      const existing = [];
      const missing = [];
      for (const project of projects) {
        if (await rootExists(project.root)) existing.push(project);
        else missing.push(project);
      }
      if (missing.length) {
        await serial(async () => {
          const onDisk = await listForWrite(file).catch(() => projects);
          const left = onDisk.filter(p => !missing.some(m => m.id === p.id));
          if (left.length !== onDisk.length) await write(file, left);
        });
      }
      projects = existing;
    }
    if (owner) projects = projects.filter(p => !isScratchRoot(p.root));
    return projects;
  } catch { return []; }
}

/** Scratch registry rows whose folder is already gone (for swarm orphans notes). */
export async function scratchRegistryOrphans({ file = projectsFile() } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const projects = valid(isObj(data) && Array.isArray(data.projects) ? data.projects : []);
    const orphans = [];
    for (const project of projects) {
      if (!isScratchRoot(project.root)) continue;
      if (!(await rootExists(project.root))) orphans.push(project);
    }
    return orphans.sort((a, b) => String(a.root).localeCompare(String(b.root)));
  } catch {
    return [];
  }
}

export function scratchRegistryOrphansNote(orphans) {
  if (!orphans?.length) return '';
  const lines = orphans.map(p => `  ${p.id}  ${p.root}`);
  return `Scratch registry entries with no folder on disk (${orphans.length}):\n${lines.join('\n')}`;
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

export const FORGET_REGISTRY_ONLY = 'registry only: no project files were touched';

async function normalizeMatchPath(input) {
  const raw = String(input ?? '');
  if (!raw) return null;
  try {
    return await fs.realpath(raw);
  } catch {
    return path.resolve(raw);
  }
}

async function projectMatchesInput(project, input) {
  const raw = String(input);
  if (project.id === raw) return true;
  const normInput = await normalizeMatchPath(raw);
  if (!normInput) return false;
  let normRoot;
  try {
    normRoot = await fs.realpath(project.root);
  } catch {
    normRoot = path.resolve(project.root);
  }
  return normRoot === normInput || project.root === raw || path.resolve(project.root) === normInput;
}

async function installRootReal(installRoot) {
  if (!installRoot) return null;
  try {
    return await fs.realpath(installRoot);
  } catch {
    return path.resolve(installRoot);
  }
}

async function isInstallRootProject(project, installRoot) {
  const install = await installRootReal(installRoot);
  if (!install) return false;
  let root;
  try {
    root = await fs.realpath(project.root);
  } catch {
    root = path.resolve(project.root);
  }
  return root === install;
}

function forgetFooter() {
  return `${FORGET_REGISTRY_ONLY}\n`;
}

/** Drop projects from the machine registry only (never touches project folders). */
export async function forgetProjects({
  paths = [],
  missing = false,
  scratch = false,
  dryRun = false,
  yes = false,
  file = projectsFile(),
  env = process.env,
  home = os.homedir(),
  installRoot,
} = {}) {
  const scratchOpts = { env, home, installRoot };
  const install = await installRootReal(installRoot);

  const pickFromRegistry = async projects => {
    const ids = new Set();
    if (missing) {
      for (const project of projects) {
        if (!(await rootExists(project.root))) ids.add(project.id);
      }
    }
    if (scratch) {
      for (const project of projects) {
        if (isScratchRoot(project.root, scratchOpts)) ids.add(project.id);
      }
    }
    for (const arg of paths) {
      const matches = [];
      for (const project of projects) {
        if (await projectMatchesInput(project, arg)) matches.push(project);
      }
      if (!matches.length) return { error: `not registered: ${arg}`, exitCode: 1 };
      for (const project of matches) {
        if (install && (await isInstallRootProject(project, installRoot))) {
          return { error: 'refusing to forget the swarm install root itself', exitCode: 1 };
        }
        ids.add(project.id);
      }
      if (install) {
        const normArg = await normalizeMatchPath(arg);
        if (normArg && normArg === install) {
          return { error: 'refusing to forget the swarm install root itself', exitCode: 1 };
        }
      }
    }
    for (const id of ids) {
      const project = projects.find(p => p.id === id);
      if (project && install && (await isInstallRootProject(project, installRoot))) {
        return { error: 'refusing to forget the swarm install root itself', exitCode: 1 };
      }
    }
    const bulk = missing || scratch;
    if (bulk && ids.size > 3 && !yes) {
      return { error: `refusing to forget ${ids.size} projects without --yes (bulk limit is 3)`, exitCode: 1 };
    }
    const forgotten = projects.filter(p => ids.has(p.id));
    const left = projects.filter(p => !ids.has(p.id));
    return { forgotten, left, ids };
  };

  if (dryRun) {
    const projects = await listForWrite(file).catch(() => []);
    const picked = await pickFromRegistry(projects);
    if (picked.error) return { stdout: `${picked.error}\n${forgetFooter()}`, exitCode: picked.exitCode };
    const lines = picked.forgotten.length
      ? [...picked.forgotten.map(p => `would forget: ${p.id}  ${p.root}`), 'dry run: registry unchanged', 'forgotten projects are listed again the next time swarm runs inside them', forgetFooter().trimEnd()]
      : ['nothing to forget', forgetFooter().trimEnd()];
    return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
  }

  return serial(async () => {
    const projects = await listForWrite(file);
    const picked = await pickFromRegistry(projects);
    if (picked.error) return { stdout: `${picked.error}\n${forgetFooter()}`, exitCode: picked.exitCode };
    if (!picked.forgotten.length) {
      return { stdout: `nothing to forget\n${forgetFooter()}`, exitCode: 0 };
    }
    await write(file, picked.left);
    const lines = [
      ...picked.forgotten.map(p => `forgot: ${p.id}  ${p.root}`),
      'forgotten projects are listed again the next time swarm runs inside them',
      forgetFooter().trimEnd(),
    ];
    return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
  });
}

export async function runForgetCommand(args, { env = process.env, home = os.homedir(), installRoot } = {}) {
  const paths = [];
  let missing = false;
  let scratch = false;
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--dry-run') dryRun = true;
    else if (flag === '--missing') missing = true;
    else if (flag === '--scratch') scratch = true;
    else if (flag === '--yes') yes = true;
    else if (flag.startsWith('-')) {
      return { stdout: `unknown flag: ${flag}\n`, exitCode: 2 };
    } else paths.push(flag);
  }
  if (!paths.length && !missing && !scratch) {
    return { stdout: 'Usage: swarm forget PATH... [--dry-run] [--missing] [--scratch] [--yes]\n', exitCode: 2 };
  }
  return forgetProjects({
    paths,
    missing,
    scratch,
    dryRun,
    yes,
    file: projectsFile(env, home),
    env,
    home,
    installRoot,
  });
}
