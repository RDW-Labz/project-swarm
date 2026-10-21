// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const SNAPSHOT_REF_PREFIX = 'refs/swarm/snapshots/';
const SNAPSHOT_MESSAGE = 'swarm integrated snapshot';
const SNAPSHOT_AUTHOR_NAME = 'swarm';
const SNAPSHOT_AUTHOR_EMAIL = 'swarm@integrated.invalid';
const MAX_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

const posix = p => p.split(path.sep).join('/');

export function defaultGitRunner(root) {
  return async function git(args, options = {}) {
    const { env, timeoutMs = GIT_TIMEOUT_MS } = options;
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env, ...env },
      });
      return stdout;
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message || err).trim();
      throw Object.assign(new Error(detail || 'git failed'), { code: err.code, exitCode: err.code });
    }
  };
}

async function gitOk(git, args, options) {
  try {
    await git(args, options);
    return true;
  } catch {
    return false;
  }
}

async function rootRealpath(root) {
  return fs.realpath(root);
}

function underDotGit(rel) {
  return rel === '.git' || rel.startsWith('.git/');
}

function underDotSwarm(rel) {
  return rel === '.swarm' || rel.startsWith('.swarm/');
}

async function classifyPath(root, rootReal, relPath, git) {
  const rel = posix(path.normalize(relPath));
  if (underDotGit(rel)) return { action: 'skip', reason: 'dot-git' };
  if (underDotSwarm(rel)) return { action: 'skip', reason: 'dot-swarm' };
  if (path.isAbsolute(rel) || rel.startsWith('../') || rel.split('/').some(part => part === '..')) {
    return { action: 'skip', reason: 'outside-repo' };
  }
  const abs = path.resolve(root, rel);
  let stat;
  try {
    stat = await fs.lstat(abs);
  } catch {
    const parent = path.dirname(abs);
    try {
      const parentReal = await fs.realpath(parent);
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
        return { action: 'skip', reason: 'outside-repo' };
      }
    } catch {
      return { action: 'skip', reason: 'outside-repo' };
    }
    return { action: 'delete', rel, abs };
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    const linkAbs = path.resolve(path.dirname(abs), target);
    let linkReal;
    try {
      linkReal = await fs.realpath(linkAbs);
    } catch {
      return { action: 'skip', reason: 'symlink-outside' };
    }
    if (linkReal !== rootReal && !linkReal.startsWith(rootReal + path.sep)) {
      return { action: 'skip', reason: 'symlink-outside' };
    }
  } else {
    let absReal;
    try {
      absReal = await fs.realpath(abs);
    } catch {
      return { action: 'skip', reason: 'outside-repo' };
    }
    if (absReal !== rootReal && !absReal.startsWith(rootReal + path.sep)) {
      return { action: 'skip', reason: 'outside-repo' };
    }
  }
  if (stat.isFile() && !stat.isSymbolicLink() && stat.size > MAX_BYTES) {
    return { action: 'skip', reason: 'oversized' };
  }
  if (await gitOk(git, ['check-ignore', '-q', '--', rel])) return { action: 'skip', reason: 'ignored' };
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    return { action: 'skip', reason: 'not-a-file' };
  }
  return { action: 'add', rel, abs };
}

export async function snapshotIntegrated({ root, paths, git }) {
  const runGit = git ?? defaultGitRunner(root);
  const rootReal = await rootRealpath(root);
  const head = (await runGit(['rev-parse', 'HEAD'])).trim();
  const indexPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-snap-idx-')), 'index');
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  const refName = `${Date.now()}-${randomUUID()}`;
  const ref = `${SNAPSHOT_REF_PREFIX}${refName}`;
  let refWritten = false;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (refWritten) {
      await runGit(['update-ref', '-d', ref]).catch(() => {});
    }
    await fs.rm(path.dirname(indexPath), { recursive: true, force: true }).catch(() => {});
  };

  await runGit(['read-tree', head], { env: indexEnv });

  const included = [];
  const skipped = [];
  const seen = new Set();

  for (const raw of paths) {
    const key = posix(path.normalize(raw));
    if (seen.has(key)) continue;
    seen.add(key);

    const classified = await classifyPath(root, rootReal, raw, runGit);
    if (classified.action === 'skip') {
      skipped.push({ path: key, reason: classified.reason });
      continue;
    }
    if (classified.action === 'delete') {
      const removed = await gitOk(runGit, ['update-index', '--remove', '--force-remove', '--', classified.rel], { env: indexEnv });
      if (removed) included.push(classified.rel);
      else skipped.push({ path: key, reason: 'missing-from-head' });
      continue;
    }
    await runGit(['update-index', '--add', '--', classified.rel], { env: indexEnv });
    included.push(classified.rel);
  }

  const tree = (await runGit(['write-tree'], { env: indexEnv })).trim();
  const authorEnv = {
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
  };
  const commit = (
    await runGit(['commit-tree', '-p', head, '-m', SNAPSHOT_MESSAGE, tree], { env: { ...indexEnv, ...authorEnv } })
  ).trim();
  await runGit(['update-ref', ref, commit]);
  refWritten = true;

  return { commit, ref, included, skipped, cleanup };
}

export async function worktreeFromSnapshot({ root, snapshot, dir, git }) {
  const runGit = git ?? defaultGitRunner(root);
  const commit = typeof snapshot === 'string' ? snapshot : snapshot.commit;
  await runGit(['worktree', 'add', '--detach', dir, commit]);
  const remove = async () => {
    await runGit(['worktree', 'remove', '--force', dir]).catch(err => {
      if (err?.exitCode !== 128 && err?.code !== 1) throw err;
    });
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  return { dir, remove };
}

export async function listSnapshotRefs(root, git) {
  const runGit = git ?? defaultGitRunner(root);
  try {
    const out = await runGit(['for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX]);
    return out.split('\n').map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function sweepOldSnapshots({ root, olderThanMs, now = Date.now(), git }) {
  const runGit = git ?? defaultGitRunner(root);
  const gitDir = (await runGit(['rev-parse', '--git-dir'])).trim();
  const absGitDir = path.resolve(root, gitDir);
  const refs = await listSnapshotRefs(root, runGit);
  const cutoff = now - olderThanMs;
  const removed = [];
  for (const ref of refs) {
    const rel = ref.slice(SNAPSHOT_REF_PREFIX.length);
    const refPath = path.join(absGitDir, SNAPSHOT_REF_PREFIX, rel);
    let mtimeMs;
    try {
      mtimeMs = (await fs.stat(refPath)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoff) {
      await runGit(['update-ref', '-d', ref]).catch(() => {});
      removed.push(ref);
    }
  }
  return removed;
}
