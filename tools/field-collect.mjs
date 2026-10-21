// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_FIELD_REMOTE = 'RDW-Labz/swarm-field';

const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const NON_FAST_FORWARD_RE = /\[rejected\]|non-fast-forward|failed to push some refs|stale info/i;

function nowOf(now) {
  return typeof now === 'function' ? now() : Number(now ?? Date.now());
}

function resolveRemoteUrl(remote) {
  const text = String(remote ?? DEFAULT_FIELD_REMOTE);
  if (path.isAbsolute(text) || text.startsWith('./') || text.startsWith('../')) return path.resolve(text);
  if (text.endsWith('.git') || /^[\w@+-]+:/.test(text) || /^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return `https://github.com/${text}.git`;
  return text;
}

export async function defaultGit(cwd, args) {
  const opts = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  try {
    if (args[0] === 'clone') {
      return (await execFileAsync('git', args, { ...opts, cwd })).stdout;
    }
    return (await execFileAsync('git', ['-C', cwd, ...args], opts)).stdout;
  } catch (error) {
    const message = String(error.stderr ?? error.message ?? error).trim();
    throw Object.assign(new Error(message || 'git failed'), { code: error.code, stderr: error.stderr });
  }
}

function safeMachineName(machine) {
  const name = String(machine ?? '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('field-collect-machine-invalid');
  }
  return name;
}

function safeProjectName(project) {
  const name = String(project ?? '').trim();
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return null;
  }
  return name;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateFieldExportBytes(buf, { machine } = {}) {
  if (buf.length > MAX_EXPORT_BYTES) return { ok: false, reason: 'oversized' };
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'invalid-export' };
  if (parsed.version !== 1) return { ok: false, reason: 'invalid-export' };
  if (!safeProjectName(parsed.project)) return { ok: false, reason: 'invalid-export' };
  if (!safeProjectName(parsed.machine)) return { ok: false, reason: 'invalid-export' };
  if (machine !== undefined && String(parsed.machine) !== String(machine)) {
    return { ok: false, reason: 'machine-mismatch' };
  }
  return { ok: true, data: parsed };
}

async function readExportFile(filePath, { machine } = {}) {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!stat.isFile()) return { ok: false, reason: 'not-file' };
  if (stat.size > MAX_EXPORT_BYTES) return { ok: false, reason: 'oversized' };
  const buf = await fs.readFile(filePath);
  return validateFieldExportBytes(buf, { machine });
}

async function defaultBranch(workDir, git) {
  try {
    const ref = String(await git(workDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    const match = /refs\/remotes\/origin\/(.+)/.exec(ref);
    if (match) return match[1];
  } catch { /* fall through */ }
  for (const candidate of ['main', 'master']) {
    try {
      await git(workDir, ['rev-parse', '--verify', `refs/heads/${candidate}`]);
      return candidate;
    } catch { /* try next */ }
  }
  return 'main';
}

async function ensureWorkDir({ remote, workDir, git }) {
  const url = resolveRemoteUrl(remote);
  const gitDir = path.join(workDir, '.git');
  try {
    await fs.access(gitDir);
    await git(workDir, ['fetch', 'origin']);
    const branch = await defaultBranch(workDir, git);
    await git(workDir, ['checkout', branch]);
    await git(workDir, ['pull', '--ff-only', 'origin', branch]);
    return branch;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !String(error.message).includes('not a git repository')) throw error;
  }
  await fs.mkdir(path.dirname(workDir), { recursive: true });
  const parent = path.dirname(workDir);
  const base = path.basename(workDir);
  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch { /* empty */ }
  await git(parent, ['clone', url, base]);
  return await defaultBranch(workDir, git);
}

async function gitIdentity(workDir, git) {
  const name = String(await git(workDir, ['config', 'user.name'])).trim();
  const email = String(await git(workDir, ['config', 'user.email'])).trim();
  if (!name || !email) throw new Error('field-collect-git-user-unconfigured');
  return { name, email };
}

function commitMessage(machine, ms) {
  return `field export ${machine} ${new Date(ms).toISOString()}`;
}

async function pushWithRebase({ workDir, git, branch }) {
  try {
    await git(workDir, ['push', 'origin', `HEAD:${branch}`]);
    return;
  } catch (error) {
    if (!NON_FAST_FORWARD_RE.test(String(error.message))) throw error;
    await git(workDir, ['pull', '--rebase', 'origin', branch]);
    await git(workDir, ['push', 'origin', `HEAD:${branch}`]);
  }
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map(entry => {
    if (typeof entry === 'string') return { name: path.basename(entry, '.json'), path: entry };
    return { name: String(entry?.name ?? ''), path: String(entry?.path ?? '') };
  });
}

export async function pushFieldExports({
  files,
  remote = DEFAULT_FIELD_REMOTE,
  machine,
  workDir,
  git = defaultGit,
  now,
  dryRun = false,
}) {
  const machineName = safeMachineName(machine);
  const branch = await ensureWorkDir({ remote, workDir, git });
  const pushed = [];
  const skipped = [];
  const stagedPaths = [];
  const ms = nowOf(now);

  for (const { name, path: filePath } of normalizeFiles(files)) {
    const label = name || path.basename(filePath, '.json') || filePath;
    if (!filePath) {
      skipped.push({ name: label, reason: 'missing-path' });
      continue;
    }
    const checked = await readExportFile(filePath, { machine: machineName });
    if (!checked.ok) {
      skipped.push({ name: label, reason: checked.reason });
      continue;
    }
    const destRel = path.posix.join('machines', machineName, `${checked.data.project}.json`);
    const destAbs = path.join(workDir, ...destRel.split('/'));
    if (dryRun) {
      pushed.push(label);
      continue;
    }
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(filePath, destAbs);
    stagedPaths.push(destRel);
    pushed.push(label);
  }

  if (dryRun) {
    return { pushed, skipped, commit: null, dryRun: true };
  }

  if (stagedPaths.length === 0) {
    const head = String(await git(workDir, ['rev-parse', 'HEAD'])).trim();
    return { pushed, skipped, commit: head };
  }

  for (const rel of stagedPaths) await git(workDir, ['add', '--', rel]);
  const porcelain = String(await git(workDir, ['status', '--porcelain', '--', ...stagedPaths])).trim();
  if (!porcelain) {
    const head = String(await git(workDir, ['rev-parse', 'HEAD'])).trim();
    return { pushed, skipped, commit: head };
  }

  await gitIdentity(workDir, git);
  const message = commitMessage(machineName, ms);
  await git(workDir, ['commit', '-m', message]);
  const commit = String(await git(workDir, ['rev-parse', 'HEAD'])).trim();
  await pushWithRebase({ workDir, git, branch });
  return { pushed, skipped, commit };
}

async function walkJsonFiles(rootDir) {
  const out = [];
  async function walk(current, rel = '') {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        out.push({ rel: entryRel, symlink: true });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, entryRel);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.json')) out.push({ rel: entryRel, abs });
    }
  }
  await walk(rootDir);
  return out;
}

export async function pullFieldExports({ remote = DEFAULT_FIELD_REMOTE, workDir, git = defaultGit }) {
  const branch = await ensureWorkDir({ remote, workDir, git });
  await git(workDir, ['checkout', branch]);
  const machinesRoot = path.join(workDir, 'machines');
  const exports = [];
  const skipped = [];
  let files = [];
  try {
    files = await walkJsonFiles(machinesRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const file of files) {
    const rel = `machines/${file.rel}`;
    if (file.symlink) {
      skipped.push({ path: rel, reason: 'symlink' });
      continue;
    }
    let buf;
    try {
      const stat = await fs.stat(file.abs);
      if (stat.size > MAX_EXPORT_BYTES) {
        skipped.push({ path: rel, reason: 'oversized' });
        continue;
      }
      buf = await fs.readFile(file.abs);
    } catch {
      skipped.push({ path: rel, reason: 'unreadable' });
      continue;
    }
    const checked = validateFieldExportBytes(buf);
    if (!checked.ok) {
      skipped.push({ path: rel, reason: checked.reason });
      continue;
    }
    const parts = file.rel.split('/');
    const machinePart = parts.length >= 2 ? parts[0] : null;
    exports.push({
      ...checked.data,
      machine: checked.data.machine ?? machinePart,
      path: rel,
    });
  }
  exports.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { exports, skipped };
}
