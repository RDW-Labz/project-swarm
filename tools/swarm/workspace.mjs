import { git } from '../codex-adapter.mjs';
import { WORKTREE_MIN_FREE_BYTES, WORKTREE_WRITERS } from './patterns.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const isWorktreeWriter = job => WORKTREE_WRITERS.includes(job?.agent);

// Codex, cursor and claude shell jobs run in a detached worktree; every other CLI job in a copied workspace.
const usesWorktree = job => isWorktreeWriter(job) || job.shell === true;

// Recursively lists every regular file under `root`, as paths relative to it, for comparing a
// job's copied workspace against what it started with (context ∪ outputs); symlinks are skipped
// since a legitimate workspace copy never creates one.
async function listWorkspaceFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  await walk(root);
  return out;
}

// Field lesson #145: os.tmpdir() itself resolves inside a git repo — refused the same way a
// failing loopback scan is, before the worker is ever spawned.
const scratchInsideRepoResult = () => ({ status: 'failed', scratchInsideRepo: true, refusedBeforeStart: true, error: 'scratch-inside-repo', stdout: '', stderr: '', response: '', exitCode: null, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null, cleanupError: null, terminationReason: null, permissionDenials: [] });

const worktreeDiskLowResult = message => ({ status: 'failed', worktreeDiskLow: true, refusedBeforeStart: true, error: message, stdout: '', stderr: '', response: '', exitCode: null, actualModel: null, modelsSeen: [], modelMismatch: false, usage: null, modelUsage: null, costUsd: null, cleanupError: null, terminationReason: null, permissionDenials: [] });

export function resolveWorktree(state, job) {
  if (typeof job.worktreePath === 'string' && job.worktreePath) return job.worktreePath;
  if (typeof state.worktreesBase === 'string' && state.worktreesBase) return path.join(state.worktreesBase, state.id, job.id);
  // T86 shim, removed one release after the default flips: runs from before 1.45.0 record no worktreePath.
  return path.join(state.root, '.swarm', 'runs', state.id, 'worktrees', job.id);
}

async function prepareWorktreeLocation(worktree, { statfsImpl = fs.statfs } = {}) {
  const parent = path.dirname(worktree);
  await fs.mkdir(parent, { recursive: true });
  const { bavail, bsize } = await statfsImpl(parent);
  const free = Number(bavail) * Number(bsize);
  if (free < WORKTREE_MIN_FREE_BYTES) throw Object.assign(new Error(`worktree-disk-low: ${parent} has ${Math.floor(free / (1024 * 1024))} MiB free, needs 256 MiB; set worktreesDir in the swarm config to another volume`), { code: 'worktree-disk-low' });
}

// Decision #154: a claude shell job runs in a detached worktree (so project checks can run),
// with the WHOLE claude process under a generated seatbelt profile, a job-scoped HOME and
// config dir, an allowlisted env and a CONNECT proxy that only reaches the model API. Only
// declared outputs are copied back into the proposal workspace; the worktree is disposable.
// Field lesson 157: a shell job's worktree is a full git checkout (unlike a copied workspace,
// which only ever holds declared context/outputs), so a plain file-listing diff would flag every
// untouched repo file as a dropped write; `git status` inside it already reports only what
// actually changed since the last snapshot, new or modified alike.
async function worktreeStatusMap(worktree) {
  const text = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3);
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    if (file.startsWith('"') && file.endsWith('"')) { try { file = JSON.parse(file); } catch { /* keep the quoted form as-is */ } }
    map.set(file, code);
  }
  return map;
}

async function gitDiffNoIndexBytes(file, baseBytes, afterBytes) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-dropped-diff-'));
  try {
    const before = path.join(tmpDir, 'before'), after = path.join(tmpDir, 'after');
    await fs.writeFile(before, baseBytes);
    await fs.writeFile(after, afterBytes);
    try { return await git(tmpDir, ['diff', '--no-index', '--', before, after]); }
    catch (error) { return typeof error.stdout === 'string' ? error.stdout : null; }
  } finally { await fs.rm(tmpDir, { recursive: true, force: true }); }
}

// codex sees only the detached HEAD worktree, so a declared context file that git does not
// track (untracked or ignored) would silently vanish from what the worker is told to read first.
async function isTrackedByGit(root, file, exec) {
  try { await exec('git', ['-C', root, 'ls-files', '--error-unmatch', '--', file], { encoding: 'utf8' }); return true; }
  catch { return false; }
}

export { gitDiffNoIndexBytes, isTrackedByGit, isWorktreeWriter, listWorkspaceFiles, prepareWorktreeLocation, scratchInsideRepoResult, usesWorktree, worktreeDiskLowResult, worktreeStatusMap };
