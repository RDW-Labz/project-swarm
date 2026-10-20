// SPDX-License-Identifier: Apache-2.0
// Install and remove swarm git hooks (pre-commit, pre-push) in the repository hooks directory.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOOK_MARKER = '# swarm-githook-check';

const hookBody = (kind, checkScript) => {
  const runCheck = kind === 'pre-push'
    ? `STDIN_FILE="$HOOKS_DIR/.swarm-pre-push.stdin"
cat > "$STDIN_FILE" || exit 1
node "$CHECK" ${kind} "$@" < "$STDIN_FILE"
STATUS=$?
rm -f "$STDIN_FILE"
exit $STATUS`
    : `node "$CHECK" ${kind} "$@"
exit $?`;
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by swarm handbuild install — do not edit; use swarm handbuild uninstall to remove.
HOOKS_DIR="$(git rev-parse --git-path hooks)"
CHECK=${JSON.stringify(checkScript)}
PREV="$HOOKS_DIR/${kind}.before-swarm"
if [ -f "$PREV" ]; then
  "$PREV" "$@" || exit $?
fi
${runCheck}
`;
};

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

/** @param {string} root project root @param {{ fs?: typeof fs, exec?: Function, checkScript: string }} opts */
export function installGitHooks(root, { fs: fsMod = fs, exec, checkScript } = {}) {
  if (!checkScript) throw Error('installGitHooks: checkScript is required');
  const dir = hooksDir(root, exec);
  fsMod.mkdirSync(dir, { recursive: true });
  for (const kind of ['pre-commit', 'pre-push']) {
    const hookPath = path.join(dir, kind);
    const backupPath = `${hookPath}.before-swarm`;
    const existing = readHook(fsMod, hookPath);
    if (existing !== null && !isOurHook(existing)) {
      if (!readHook(fsMod, backupPath)) fsMod.renameSync(hookPath, backupPath);
    }
    fsMod.writeFileSync(hookPath, hookBody(kind, checkScript), { mode: 0o755 });
  }
}

/** @param {string} root @param {{ fs?: typeof fs, exec?: Function }} opts */
export function removeGitHooks(root, { fs: fsMod = fs, exec } = {}) {
  const dir = hooksDir(root, exec);
  for (const kind of ['pre-commit', 'pre-push']) {
    const hookPath = path.join(dir, kind);
    const backupPath = `${hookPath}.before-swarm`;
    const existing = readHook(fsMod, hookPath);
    if (existing !== null && isOurHook(existing)) fsMod.rmSync(hookPath, { force: true });
    if (readHook(fsMod, backupPath) !== null && readHook(fsMod, hookPath) === null) {
      fsMod.renameSync(backupPath, hookPath);
    }
  }
}
