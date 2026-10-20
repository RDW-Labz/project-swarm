// SPDX-License-Identifier: Apache-2.0
// Git pre-commit and pre-push hooks: enforce hand-build rules on what git actually commits and pushes (agent sessions only).

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

const fileDenyMessage = rel =>
  `Hand-build guard: ${rel} is not a routing file and its staged content is not a recorded swarm integrate hash. Ask the owner: swarm handbuild request --kind <swarm-cannot|emergency|secret|tiny> --reason "why the swarm cannot do it" --files "${rel}" --minutes 30`;

const commitDenyMain = `${DENY_ADVICE} (blocked: git commit on a protected branch)`;

const pushDenyMain = reason =>
  `${DENY_ADVICE} (blocked: ${reason})`;

/** @returns {{ ok: true } | { ok: false, message: string }} */
export function checkPreCommit({ root, env, branch, staged, readBlob, approvals }) {
  if (!agentSession(env) || guardOff(root)) return { ok: true };
  try {
    const live = approvals ?? activeApprovals(root);
    const paths = [...new Set((staged ?? []).filter(Boolean))];
    for (const rel of paths) {
      let bytes = null;
      try { bytes = readBlob(root, rel); } catch { bytes = null; }
      if (!stagedFileAllowed(root, rel, bytes, live)) return { ok: false, message: fileDenyMessage(rel) };
    }
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

function diffFilesForPush(root, localSha) {
  try {
    return execFileSync('git', ['diff', '--name-only', `origin/main...${localSha}`], { cwd: root, encoding: 'utf8', timeout: 15_000 })
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

      const files = diffFilesForPush(root, localSha);
      if (files === null) {
        return { ok: false, message: 'Hand-build guard: could not list files in this push against origin/main; refusing the push.' };
      }
      for (const rel of files) {
        let bytes = null;
        if (readBlob) {
          try { bytes = readBlob(root, rel, localSha); } catch { bytes = null; }
        } else {
          bytes = readBlobAt(root, `${localSha}:${rel}`);
        }
        if (!stagedFileAllowed(root, rel, bytes, live)) return { ok: false, message: fileDenyMessage(rel) };
      }
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

function runCli(kind) {
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    process.exit(agentSession(process.env) ? 1 : 0);
  }
  const env = process.env;
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
  if (kind === 'pre-commit' || kind === 'pre-push') runCli(kind);
}
