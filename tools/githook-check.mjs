// SPDX-License-Identifier: Apache-2.0
// Git pre-commit, pre-push, and commit-msg hooks: hand-build rules (agent sessions) and manifest-only commits (all actors).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  activeApprovals,
  matchesFile,
  isProtectedBranch,
  OFF_FILE,
  DENY_ADVICE,
  branchOf,
} from './handbuild.mjs';
import { isRoutingPathResolved } from './routing-paths.mjs';
import { isSwarmProducedContent } from './swarm-produced.mjs';

const ZERO = /^0+$/;

export const agentSession = env => Boolean(env?.CLAUDECODE);
export const guardOff = root => {
  try { return fs.existsSync(path.join(root, OFF_FILE)); } catch { return false; }
};

const normRef = ref => String(ref ?? '').replace(/^refs\/heads\//, '');
const protectedRef = ref => {
  const n = normRef(ref);
  return n === 'main' || n === 'master';
};

const gitCovered = (approvals, op) => approvals.some(a => (a.git ?? []).includes(op));

const fileApproval = (approvals, rel) => approvals.some(a => matchesFile(a.files, rel));

export function stagedFileAllowed(root, rel, bytes, approvals) {
  if (isRoutingPathResolved(root, rel)) return true;
  if (bytes !== null && isSwarmProducedContent(root, rel, bytes)) return true;
  if (fileApproval(approvals, rel)) return true;
  return false;
}

const FILE_DENY_MAX_LISTED = 12;

const fileDenyMessage = rel =>
  `Hand-build guard: ${rel} is not a routing file and its staged content is not a recorded swarm integrate hash. Ask the owner: swarm handbuild request --kind <swarm-cannot|emergency|secret|tiny> --reason "why the swarm cannot do it" --files "${rel}" --minutes 30`;

const formatListedFiles = rels => {
  const unique = [...new Set(rels.filter(Boolean))];
  const shown = unique.slice(0, FILE_DENY_MAX_LISTED);
  const rest = unique.length - shown.length;
  const list = shown.join(', ');
  return rest > 0 ? `${list}, and ${rest} more` : list;
};

const filesDenyMessage = rels => {
  const unique = [...new Set(rels.filter(Boolean))];
  if (unique.length === 1) return fileDenyMessage(unique[0]);
  const listed = formatListedFiles(unique);
  const filesArg = unique.join(',');
  return `Hand-build guard: ${listed} are not routing files and their staged content is not a recorded swarm integrate hash. Ask the owner: swarm handbuild request --kind <swarm-cannot|emergency|secret|tiny> --reason "why the swarm cannot do it" --files "${filesArg}" --minutes 30`;
};

const MANIFEST_DIR_PREFIX = 'coordination/manifests/';

/** Distinct exit code for manifest rule violations (shell wrapper maps this to hook failure). */
export const COMMIT_MSG_VIOLATION_EXIT = 3;

const commitDenyMain = `${DENY_ADVICE} (blocked: git commit on a protected branch)`;

const manifestCommitRefused = rels => {
  const list = [...new Set(rels.filter(Boolean))].join(', ');
  return `manifest commit refused: these staged files are not manifests: ${list}; run git status, unstage them with git restore --staged FILE (or git reset), commit them separately with their own message, then commit the manifest again.`;
};

export function pathsFromCachedNameStatus(text) {
  const raw = String(text ?? '');
  if (raw.includes('\0')) {
    const paths = [];
    const parts = raw.split('\0').filter(Boolean);
    let i = 0;
    while (i < parts.length) {
      const status = parts[i++];
      if (/^[RC]/i.test(status)) {
        if (parts[i]) paths.push(parts[i++]);
        if (parts[i]) paths.push(parts[i++]);
      } else if (parts[i]) paths.push(parts[i++]);
    }
    return paths;
  }
  const paths = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const tab = t.indexOf('\t');
    const parts = tab >= 0 ? [t.slice(0, tab), ...t.slice(tab + 1).split('\t')] : t.split(/\s+/);
    const status = parts[0] ?? '';
    if (/^[RC]/i.test(status)) {
      if (parts[1]) paths.push(parts[1]);
      if (parts[2]) paths.push(parts[2]);
    } else if (parts[1]) {
      paths.push(parts[1]);
    }
  }
  return paths;
}

function gitCommentChar(root) {
  try {
    const ch = execFileSync('git', ['config', '--get', 'core.commentChar'], { cwd: root, encoding: 'utf8', timeout: 3000 }).trim();
    if (ch === 'auto') return '#';
    if (ch) return ch[0];
  } catch { /* default */ }
  return '#';
}

function gitDir(root) {
  try {
    const gitPath = path.join(root, '.git');
    const raw = fs.readFileSync(gitPath, 'utf8').trim();
    if (raw.startsWith('gitdir:')) {
      const rel = raw.slice('gitdir:'.length).trim();
      return path.isAbsolute(rel) ? rel : path.join(root, rel);
    }
    return gitPath;
  } catch {
    return path.join(root, '.git');
  }
}

function readCommitSubjectFromFile(messagePath, { commentChar = '#' } = {}) {
  const text = fs.readFileSync(messagePath, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith(commentChar)) continue;
    return t;
  }
  return '';
}

export function isManifestCommitSubject(subject) {
  const t = String(subject ?? '').trim();
  if (/^(?:manifests?:|manifest\s+for\b)/i.test(t)) return true;
  if (/^manifest\s+/i.test(t) && !/^manifest\s+parser:/i.test(t) && !/^manifest\s+\w+:/i.test(t) && !/\d/.test(t)) return true;
  return false;
}

function pathUnderManifestsCaseSensitive(rel) {
  const n = String(rel ?? '').replace(/\\/g, '/');
  return n === 'coordination/manifests' || n.startsWith(MANIFEST_DIR_PREFIX);
}

export function shouldSkipCommitMsgCheck({ root, env = process.env, argv = process.argv, messagePath } = {}) {
  if (env.GITMERGE_AUTOEDIT === 'no') return true;
  if (root) {
    try {
      const gd = gitDir(root);
      if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) return true;
      if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) return true;
      if (fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD'))) return true;
    } catch { /* ignore */ }
  }
  const msgPath = messagePath ?? argv[3];
  if (msgPath) {
    try {
      const subj = readCommitSubjectFromFile(msgPath, { commentChar: root ? gitCommentChar(root) : '#' });
      if (/^(fixup|squash)!/i.test(subj.trim())) return true;
    } catch { /* ignore */ }
  }
  const msg = env.GIT_COMMIT_MSG ?? '';
  if (/^(fixup|squash)!/i.test(msg.trim())) return true;
  return false;
}

/** @returns {{ ok: true } | { ok: false, message: string }} */
export function checkCommitMsg({ root, messagePath, subject, nameStatusText, stagedPaths, fromEditor = false }) {
  const subj = subject ?? (messagePath ? readCommitSubjectFromFile(messagePath, { commentChar: root ? gitCommentChar(root) : '#' }) : '');
  if (!isManifestCommitSubject(subj)) return { ok: true };
  const paths = stagedPaths ?? pathsFromCachedNameStatus(nameStatusText ?? '');
  const denied = [...new Set(paths.filter(p => !pathUnderManifestsCaseSensitive(p)))];
  if (denied.length) return { ok: false, message: manifestCommitRefused(denied) };
  return { ok: true };
}

const pushDenyMain = reason =>
  `${DENY_ADVICE} (blocked: ${reason})`;

/** @returns {{ ok: true } | { ok: false, message: string }} */
export function checkPreCommit({ root, env, branch, staged, readBlob, approvals }) {
  if (!agentSession(env) || guardOff(root)) return { ok: true };
  try {
    const live = approvals ?? activeApprovals(root);
    const paths = [...new Set((staged ?? []).filter(Boolean))];
    const denied = [];
    for (const rel of paths) {
      let bytes = null;
      try { bytes = readBlob(root, rel); } catch { bytes = null; }
      if (!stagedFileAllowed(root, rel, bytes, live)) denied.push(rel);
    }
    if (denied.length) return { ok: false, message: filesDenyMessage(denied) };
    const b = branch ?? branchOf(root);
    if (isProtectedBranch(b) && !gitCovered(live, 'commit')) return { ok: false, message: commitDenyMain };
    return { ok: true };
  } catch {
    return agentSession(env) ? { ok: false, message: 'Hand-build guard: pre-commit check failed; refusing the commit.' } : { ok: true };
  }
}

function isDeleteSha(sha) {
  return ZERO.test(String(sha ?? '').trim());
}

function isFastForward(root, remoteSha, localSha) {
  if (isDeleteSha(localSha)) return false;
  if (isDeleteSha(remoteSha)) return true;
  try {
    const base = execFileSync('git', ['merge-base', remoteSha, localSha], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
    return base === remoteSha.trim();
  } catch {
    return false;
  }
}

function diffFilesForPush(root, localSha, remoteSha) {
  try {
    const local = String(localSha ?? '').trim();
    if (!local) return null;
    let from;
    if (isDeleteSha(remoteSha)) {
      from = execFileSync('git', ['merge-base', 'origin/main', local], { cwd: root, encoding: 'utf8', timeout: 15_000 }).trim();
    } else {
      const remote = String(remoteSha ?? '').trim();
      if (!remote) return null;
      if (isFastForward(root, remote, local)) {
        from = remote;
      } else {
        from = execFileSync('git', ['merge-base', remote, local], { cwd: root, encoding: 'utf8', timeout: 15_000 }).trim();
      }
    }
    if (!from) return null;
    return execFileSync('git', ['diff', '--name-only', from, local], { cwd: root, encoding: 'utf8', timeout: 15_000 })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function readBlobAt(root, object) {
  try {
    return execFileSync('git', ['show', object], { cwd: root, encoding: 'buffer', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** @returns {{ ok: true } | { ok: false, message: string }} */
const gitQuiet = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function syntheticRefsWhenStdinEmpty(root) {
  const branch = normRef(branchOf(root));
  if (!branch || branch === 'HEAD') return [];
  const localSha = gitQuiet(root, ['rev-parse', 'HEAD']);
  const ref = `refs/heads/${branch}`;
  let remoteSha = `${'0'.repeat(40)}`;
  try { remoteSha = gitQuiet(root, ['rev-parse', `refs/remotes/origin/${branch}`]); } catch { /* first push */ }
  let ahead = '0';
  try { ahead = gitQuiet(root, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]); } catch {
    try { ahead = gitQuiet(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']); } catch { return []; }
  }
  if (!ahead || ahead === '0') return [];
  return [{ localRef: ref, localSha, remoteRef: ref, remoteSha }];
}

export function checkPrePush({ root, env, refs, readBlob, approvals }) {
  if (!agentSession(env) || guardOff(root)) return { ok: true };
  try {
    const live = approvals ?? activeApprovals(root);
    let list = refs ?? [];
    if (!list.length) list = syntheticRefsWhenStdinEmpty(root);
    if (!list.length) return { ok: true };

    for (const ref of list) {
      const localRef = ref.localRef ?? ref[0];
      const localSha = ref.localSha ?? ref[1];
      const remoteRef = ref.remoteRef ?? ref[2];
      const remoteSha = ref.remoteSha ?? ref[3];
      const targetProtected = protectedRef(remoteRef) || protectedRef(localRef);

      if (targetProtected) {
        if (isDeleteSha(localSha)) return { ok: false, message: pushDenyMain('deleting main or master is never allowed in an agent session') };
        if (!isFastForward(root, remoteSha, localSha)) {
          return { ok: false, message: pushDenyMain('a non-fast-forward update to main or master is never allowed in an agent session') };
        }
        if (!gitCovered(live, 'push')) return { ok: false, message: pushDenyMain('git push to a protected branch') };
        continue;
      }

      if (isDeleteSha(localSha)) continue;

      const files = diffFilesForPush(root, localSha, remoteSha);
      if (files === null) {
        return { ok: false, message: 'Hand-build guard: could not list files in this push against origin/main; refusing the push.' };
      }
      const denied = [];
      for (const rel of files) {
        let bytes = null;
        if (readBlob) {
          try { bytes = readBlob(root, rel, localSha); } catch { bytes = null; }
        } else {
          bytes = readBlobAt(root, `${localSha}:${rel}`);
        }
        if (!stagedFileAllowed(root, rel, bytes, live)) denied.push(rel);
      }
      if (denied.length) return { ok: false, message: filesDenyMessage(denied) };
    }
    return { ok: true };
  } catch {
    return agentSession(env) ? { ok: false, message: 'Hand-build guard: pre-push check failed; refusing the push.' } : { ok: true };
  }
}

function readAllStdin() {
  const chunks = [];
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { break; }
    if (!n) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsePrePushStdin(text) {
  const refs = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 4) continue;
    refs.push({ localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] });
  }
  return refs;
}

function defaultReadStagedBlob(root, rel) {
  return readBlobAt(root, `:${rel}`);
}

function stagedPathsForCommitMsg(root) {
  try {
    const zbuf = execFileSync('git', ['diff', '--cached', '--name-only', '-z', '--no-renames'], {
      cwd: root,
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return zbuf.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function runCommitMsgCheckSync(root) {
  const messagePath = process.argv[3];
  if (shouldSkipCommitMsgCheck({ root, env: process.env, argv: process.argv, messagePath })) return { ok: true };
  const stagedPaths = stagedPathsForCommitMsg(root);
  if (stagedPaths) return checkCommitMsg({ root, messagePath, stagedPaths });
  let nameStatusText;
  try {
    const zbuf = execFileSync('git', ['diff', '--cached', '--name-status', '-z', '--no-renames'], {
      cwd: root,
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
    });
    nameStatusText = zbuf.toString('utf8');
  } catch {
    nameStatusText = execFileSync('git', ['diff', '--cached', '--name-status'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  return checkCommitMsg({ root, messagePath, nameStatusText });
}

function runCli(kind) {
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    process.exit(agentSession(process.env) ? 1 : 0);
  }
  const env = process.env;

  if (kind === 'commit-msg') {
    try {
      const result = runCommitMsgCheckSync(root);
      if (!result.ok) {
        process.stderr.write(`${result.message}\n`);
        process.exit(COMMIT_MSG_VIOLATION_EXIT);
      }
      process.exit(0);
    } catch {
      process.stderr.write('swarm git hook: manifest check skipped (infrastructure)\n');
      process.exit(0);
    }
    return;
  }

  if (!agentSession(env) || guardOff(root)) process.exit(0);

  try {
    if (kind === 'pre-commit') {
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
        .split('\n')
        .filter(Boolean);
      const branch = branchOf(root);
      const result = checkPreCommit({ root, env, branch, staged, readBlob: defaultReadStagedBlob, approvals: activeApprovals(root) });
      if (!result.ok) {
        process.stderr.write(`${result.message}\n`);
        process.exit(1);
      }
      process.exit(0);
    }
    if (kind === 'pre-push') {
      const refs = parsePrePushStdin(readAllStdin());
      const result = checkPrePush({ root, env, refs, readBlob: defaultReadStagedBlob, approvals: activeApprovals(root) });
      if (!result.ok) {
        process.stderr.write(`${result.message}\n`);
        process.exit(1);
      }
      process.exit(0);
    }
  } catch {
    process.exit(agentSession(env) ? 1 : 0);
  }
  process.exit(0);
}

const entry = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (entry) {
  const kind = process.argv[2];
  if (kind === 'pre-commit' || kind === 'pre-push' || kind === 'commit-msg') runCli(kind);
}
