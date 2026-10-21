// SPDX-License-Identifier: Apache-2.0
// Install and remove swarm git hooks (pre-commit, pre-push, commit-msg) in the repository hooks directory.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOOK_MARKER = '# swarm-githook-check';

function shellQuoteSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function nextBackupPath(hookPath, fsMod) {
  const base = `${hookPath}.before-swarm`;
  if (!fsMod.existsSync(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${hookPath}.before-swarm-${n}`;
    if (!fsMod.existsSync(candidate)) return candidate;
  }
  throw Error('installGitHooks: too many hook backups');
}

function hookBody(kind, { nodePath, checkScript }) {
  const nodeQ = shellQuoteSingle(nodePath);
  const checkQ = shellQuoteSingle(checkScript);
  const prevLatest = `PREV="$(ls -1 "$HOOKS_DIR/${kind}.before-swarm"* 2>/dev/null | LC_ALL=C sort -V | tail -1)"`;
  const resolveNode = `
NODE="$NODE_RECORD"
if [ ! -x "$NODE" ]; then NODE="$(command -v node 2>/dev/null || true)"; fi`;
  const infraSkip = `
if [ -z "$NODE" ] || [ ! -f "$CHECK" ]; then
  echo "swarm git hook: check skipped (node or script missing)" >&2
  exit 0
fi`;

  if (kind === 'pre-push') {
    return `#!/bin/sh
${HOOK_MARKER}
# Installed by swarm handbuild install — do not edit; use swarm handbuild uninstall to remove.
HOOKS_DIR="$(git rev-parse --git-path hooks)"
NODE_RECORD=${nodeQ}
CHECK=${checkQ}
${resolveNode}
${infraSkip}
STDIN_FILE="$HOOKS_DIR/.swarm-pre-push.stdin"
cat > "$STDIN_FILE" || exit 0
${prevLatest}
if [ -n "$PREV" ] && [ -f "$PREV" ]; then
  cat "$STDIN_FILE" | "$PREV" "$@" || exit $?
fi
"$NODE" "$CHECK" ${kind} "$@" < "$STDIN_FILE"
exit $?
`;
  }

  const commitInfra = kind === 'commit-msg' ? `
"$NODE" "$CHECK" ${kind} "$@"
CODE=$?
if [ "$CODE" -eq 1 ]; then exit 1; fi
if [ "$CODE" -ne 0 ]; then echo "swarm git hook: manifest check skipped (infrastructure)" >&2; fi
exit 0` : `
"$NODE" "$CHECK" ${kind} "$@"
exit $?`;

  return `#!/bin/sh
${HOOK_MARKER}
# Installed by swarm handbuild install — do not edit; use swarm handbuild uninstall to remove.
HOOKS_DIR="$(git rev-parse --git-path hooks)"
NODE_RECORD=${nodeQ}
CHECK=${checkQ}
${resolveNode}
${kind === 'commit-msg' ? infraSkip : infraSkip}
${prevLatest}
if [ -n "$PREV" ] && [ -f "$PREV" ]; then
  "$PREV" "$@" || exit $?
fi
${commitInfra}
`;
}

function hooksDir(root, exec) {
  const run = exec ?? ((cmd, args, opts) => execFileSync(cmd, args, opts));
  const rel = run('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function isOurHook(content) {
  return String(content ?? '').includes(HOOK_MARKER);
}

function readHook(fsMod, file) {
  try { return fsMod.readFileSync(file, 'utf8'); } catch { return null; }
}

function hookIsSymlink(fsMod, hookPath) {
  try { return fsMod.lstatSync(hookPath).isSymbolicLink(); } catch { return false; }
}

function backupUserHook(fsMod, hookPath) {
  const existing = readHook(fsMod, hookPath);
  if (existing === null || isOurHook(existing)) return;
  const dest = nextBackupPath(hookPath, fsMod);
  fsMod.renameSync(hookPath, dest);
}

/** @param {string} root project root @param {{ fs?: typeof fs, exec?: Function, checkScript: string, nodePath?: string }} opts */
export function installGitHooks(root, { fs: fsMod = fs, exec, checkScript, nodePath = process.execPath } = {}) {
  if (!checkScript) throw Error('installGitHooks: checkScript is required');
  const dir = hooksDir(root, exec);
  fsMod.mkdirSync(dir, { recursive: true });
  const meta = { nodePath, checkScript };
  for (const kind of ['pre-commit', 'pre-push', 'commit-msg']) {
    const hookPath = path.join(dir, kind);
    if (hookIsSymlink(fsMod, hookPath)) fsMod.unlinkSync(hookPath);
    const existing = readHook(fsMod, hookPath);
    if (existing !== null && isOurHook(existing)) {
      try { fsMod.chmodSync(hookPath, 0o755); } catch { /* best effort */ }
    } else {
      backupUserHook(fsMod, hookPath);
    }
    fsMod.writeFileSync(hookPath, hookBody(kind, meta), { mode: 0o755 });
  }
}

/** @param {string} root @param {{ fs?: typeof fs, exec?: Function }} opts */
export function removeGitHooks(root, { fs: fsMod = fs, exec } = {}) {
  const dir = hooksDir(root, exec);
  for (const kind of ['pre-commit', 'pre-push', 'commit-msg']) {
    const hookPath = path.join(dir, kind);
    const existing = readHook(fsMod, hookPath);
    if (existing !== null && isOurHook(existing)) fsMod.rmSync(hookPath, { force: true });
    const backups = fsMod.readdirSync(dir).filter(n => n === `${kind}.before-swarm` || n.startsWith(`${kind}.before-swarm-`)).sort();
    const latest = backups[backups.length - 1];
    if (latest && readHook(fsMod, hookPath) === null) {
      fsMod.renameSync(path.join(dir, latest), hookPath);
    }
  }
}
