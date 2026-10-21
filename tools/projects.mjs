// SPDX-License-Identifier: Apache-2.0
// The machine's list of projects (every folder swarm has worked in), for the Swarm Watch board. One small file in the user's home.
// A project is identified by the real path of its root; its id is a short hash of that path. Nothing here reads a project's files.
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isScratchRoot as scratchRootOf, isTestTempRoot, scratchRootList } from './scratch-roots.mjs';

export const projectsFile = (env = process.env, home = os.homedir()) => env.SWARM_PROJECTS_FILE || path.join(home, '.project-swarm', 'projects.json');
export const projectId = root => createHash('sha256').update(root).digest('hex').slice(0, 12);
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

export { scratchRootList };
export function isScratchRoot(root, options = {}) {
  return scratchRootOf(root, options);
}

let queue = Promise.resolve();
const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

const LOCK_STALE_MS = 30_000;
const STAT_TIMEOUT_MS = 2000;

// One entry per folder, and an entry's id must be the hash of its own root: a hand-edited or doubled entry is dropped, not counted twice.
const valid = list => {
  const seen = new Set();
  return list.filter(p => {
    if (!isObj(p) || typeof p.root !== 'string' || !path.isAbsolute(p.root) || typeof p.id !== 'string' || p.id !== projectId(p.root) || seen.has(p.root)) return false;
    seen.add(p.root);
    return true;
  });
};

function lockPath(file) {
  return `${file}.lock`;
}

async function acquireRegistryLock(file) {
  const lock = lockPath(file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(() => {});
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(path.join(lock, 'owner'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.rm(lock, { recursive: true, force: true });
      } catch { /* gone */ }
      if (Date.now() - started > 10_000) throw Object.assign(new Error('projects-lock-timeout'), { code: 'projects-lock-timeout' });
      await new Promise(r => setTimeout(r, 25));
    }
  }
}

async function releaseRegistryLock(lock) {
  await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
}

async function withRegistryLock(file, fn) {
  const lock = await acquireRegistryLock(file);
  try {
    return await fn();
  } finally {
    await releaseRegistryLock(lock);
  }
}

async function statRootWithTimeout(root) {
  const statPromise = fs.stat(root).then(s => ({ code: null, isDirectory: s.isDirectory() })).catch(err => ({ code: err.code ?? 'ERROR', isDirectory: false }));
  const timeout = new Promise(resolve => {
    setTimeout(() => resolve({ code: 'ETIMEDOUT', isDirectory: false }), STAT_TIMEOUT_MS);
  });
  return Promise.race([statPromise, timeout]);
}

async function parentExistsReadable(root) {
  const parent = path.dirname(root);
  if (parent === root) return false;
  try {
    await fs.access(parent, fssync.constants.R_OK);
    const st = await fs.stat(parent);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** @returns {'present'|'missing'|'unreachable'} */
async function rootReachability(root) {
  const { code, isDirectory } = await statRootWithTimeout(root);
  if (code === null && isDirectory) return 'present';
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    if (await parentExistsReadable(root)) return 'missing';
    return 'unreachable';
  }
  return 'unreachable';
}

async function rootExists(root) {
  return (await rootReachability(root)) === 'present';
}

// Owner inbox, phone sync and swarm inbox pass forOwner: true; the board listing uses forOwner false and hides isTestTempRoot only.
export async function listProjects({ file = projectsFile(), forOwner = false, includeScratch, pruneGone, unreachable } = {}) {
  const reportUnreachable = unreachable ?? [];
  let damaged = false;
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    let projects = valid(isObj(data) && Array.isArray(data.projects) ? data.projects : []);
    const owner = forOwner === true;
    const dropGone = pruneGone ?? owner;
    if (dropGone) {
      const checks = await Promise.all(projects.map(async project => ({ project, reach: await rootReachability(project.root) })));
      const existing = [];
      const missing = [];
      for (const { project, reach } of checks) {
        if (reach === 'present') existing.push(project);
        else if (reach === 'missing') missing.push(project);
        else {
          existing.push(project);
          reportUnreachable.push(project);
        }
      }
      if (missing.length) {
        let wrote = false;
        try {
          await withRegistryLock(file, async () => {
            const onDisk = await listForWrite(file);
            const left = onDisk.filter(p => !missing.some(m => m.id === p.id));
            if (left.length !== onDisk.length) {
              await write(file, left);
              wrote = true;
            }
          });
        } catch (error) {
          if (error.code === 'projects-unreadable') damaged = true;
        }
        if (!damaged) projects = existing;
        else projects = existing;
      } else {
        projects = existing;
      }
    }
    if (owner) {
      projects = projects.filter(p => !isScratchRoot(p.root, { strict: true }));
    } else if (includeScratch !== true) {
      projects = projects.filter(p => !isTestTempRoot(p.root));
    }
    return projects;
  } catch (error) {
    if (error?.code === 'projects-unreadable') throw error;
    return [];
  }
}

/** Scratch registry rows whose folder is already gone (for swarm orphans notes). */
export async function scratchRegistryOrphans({ file = projectsFile() } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const projects = valid(isObj(data) && Array.isArray(data.projects) ? data.projects : []);
    const orphans = [];
    for (const project of projects) {
      if (!isScratchRoot(project.root, { strict: true })) continue;
      if ((await rootReachability(project.root)) === 'missing') orphans.push(project);
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

async function resolveRegistryTarget(file) {
  try {
    const st = await fs.lstat(file);
    if (st.isSymbolicLink()) return await fs.realpath(file);
  } catch (error) {
    if (error.code === 'ENOENT') return file;
    throw error;
  }
  return file;
}

async function write(file, projects) {
  const target = await resolveRegistryTarget(file);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const body = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`;
  const fd = await fs.open(tmp, 'w', 0o600);
  try {
    await fd.writeFile(body);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fs.rename(tmp, target);
}

// Scratch folders (a test's temp dir) are not projects unless the registry file was chosen explicitly.
const inTmp = async real => {
  const bases = new Set([path.resolve(os.tmpdir()), await fs.realpath(os.tmpdir()).catch(() => null), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'].filter(Boolean));
  return [...bases].some(tmp => real === tmp || real.startsWith(tmp + path.sep)) || real.split(path.sep).includes('.swarm') || real.split(path.sep).some(p => p.startsWith('.tmp'));
};

// Adds the project (or refreshes its lastSeen). Returns { project, added } or null when the folder is not a project to list.
export function registerProject(root, { file = projectsFile(), env = process.env, now = Date.now, name } = {}) {
  return serial(() => withRegistryLock(file, async () => {
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
  }));
}

export function removeProject(id, { file = projectsFile() } = {}) {
  return serial(() => withRegistryLock(file, async () => {
    const projects = await listForWrite(file);
    const left = projects.filter(p => p.id !== id);
    if (left.length === projects.length) return false;
    await write(file, left);
    return true;
  }));
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

async function resolveInstallRoot(installRoot, env = process.env) {
  const candidate = installRoot || env.SWARM_INSTALL_DIR;
  if (candidate) {
    try {
      return await fs.realpath(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }
  try {
    const { stableInstallDir } = await import('./install.mjs');
    return await fs.realpath(stableInstallDir());
  } catch {
    return null;
  }
}

async function isInstallRootProject(project, install) {
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
  const install = await resolveInstallRoot(installRoot, env);
  const scratchOpts = { env, home, installRoot: install };

  const pickFromRegistry = async projects => {
    const ids = new Set();
    const skippedInstall = [];
    if (missing) {
      for (const project of projects) {
        if ((await rootReachability(project.root)) === 'missing') ids.add(project.id);
      }
    }
    if (scratch) {
      for (const project of projects) {
        if (isScratchRoot(project.root, { ...scratchOpts, strict: true }) || isTestTempRoot(project.root, scratchOpts)) ids.add(project.id);
      }
    }
    for (const arg of paths) {
      const matches = [];
      for (const project of projects) {
        if (await projectMatchesInput(project, arg)) matches.push(project);
      }
      if (!matches.length) return { error: `not registered: ${arg}`, exitCode: 1 };
      const normArg = install ? await normalizeMatchPath(arg) : null;
      const argIsInstall = install && normArg && normArg === install;
      for (const project of matches) {
        if (install && (await isInstallRootProject(project, install))) {
          if (paths.length === 1 && matches.length === 1) {
            return { error: 'refusing to forget the swarm install root itself', exitCode: 1 };
          }
          skippedInstall.push(project);
          continue;
        }
        ids.add(project.id);
      }
      if (argIsInstall) {
        if (paths.length === 1) return { error: 'refusing to forget the swarm install root itself', exitCode: 1 };
        skippedInstall.push({ root: install, id: projectId(install) });
      }
    }
    for (const id of [...ids]) {
      const project = projects.find(p => p.id === id);
      if (project && install && (await isInstallRootProject(project, install))) {
        ids.delete(id);
        skippedInstall.push(project);
      }
    }
    const bulk = missing || scratch;
    if (bulk && ids.size > 3 && !yes) {
      return { error: `refusing to forget ${ids.size} projects without --yes (bulk limit is 3)`, exitCode: 1 };
    }
    const forgotten = projects.filter(p => ids.has(p.id));
    const left = projects.filter(p => !ids.has(p.id));
    return { forgotten, left, ids, skippedInstall };
  };

  if (dryRun) {
    try {
      const projects = await listForWrite(file);
      const picked = await pickFromRegistry(projects);
      if (picked.error) return { stdout: `${picked.error}\n${forgetFooter()}`, exitCode: picked.exitCode };
      const lines = [];
      for (const p of picked.skippedInstall ?? []) lines.push(`skipped install root: ${p.id}  ${p.root}`);
      if (picked.forgotten.length) {
        lines.push(...picked.forgotten.map(p => `would forget: ${p.id}  ${p.root}`), 'dry run: registry unchanged', 'forgotten projects are listed again the next time swarm runs inside them');
      } else lines.push('nothing to forget');
      lines.push(forgetFooter().trimEnd());
      return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
    } catch (error) {
      if (error.code === 'projects-unreadable') return { stdout: `${error.message}\n${forgetFooter()}`, exitCode: 1 };
      return { stdout: `nothing to forget\n${forgetFooter()}`, exitCode: 0 };
    }
  }

  return serial(() => withRegistryLock(file, async () => {
    try {
      const projects = await listForWrite(file);
      const picked = await pickFromRegistry(projects);
      if (picked.error) return { stdout: `${picked.error}\n${forgetFooter()}`, exitCode: picked.exitCode };
      const lines = [];
      for (const p of picked.skippedInstall ?? []) lines.push(`skipped install root: ${p.id}  ${p.root}`);
      if (!picked.forgotten.length) {
        lines.push('nothing to forget', forgetFooter().trimEnd());
        return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
      }
      await write(file, picked.left);
      lines.push(...picked.forgotten.map(p => `forgot: ${p.id}  ${p.root}`), 'forgotten projects are listed again the next time swarm runs inside them', forgetFooter().trimEnd());
      return { stdout: `${lines.join('\n')}\n`, exitCode: 0 };
    } catch (error) {
      if (error.code === 'projects-unreadable') return { stdout: `${error.message}\n${forgetFooter()}`, exitCode: 1 };
      throw error;
    }
  }));
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
