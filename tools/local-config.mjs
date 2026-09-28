// SPDX-License-Identifier: Apache-2.0
// This project's own local, machine-specific config: a public repo names no private package or
// service, so anything project-specific (keychain service name, rig port file, cheap-tier
// override, extra denied home directories, a private-names list) arrives here instead of as a
// source literal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Field lesson #211: the old default, `<home>/.project-swarm/config.json`, sits inside the shared
// install clone itself (the same directory `git pull`/`swarm update` operate on) — a machine-local
// file living inside a git checkout is neither private nor safe from being overwritten. The default
// now lives under XDG (or `~/.config` when XDG_CONFIG_HOME is unset or relative); `SWARM_CONFIG`
// still wins over either.
export function defaultConfigPath({ home = os.homedir(), env = process.env } = {}) {
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, 'project-swarm', 'config.json');
  return path.join(home, '.config', 'project-swarm', 'config.json');
}

function oldInstallConfigPath(home) {
  return path.join(home, '.project-swarm', 'config.json');
}

// Walks up from `dir` looking for a `.git` entry (file, in a worktree, or dir, in a normal
// checkout), stopping at the filesystem root. Returns the directory it was found in, or null.
function gitWorkTreeTop(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadLocalConfig({ home = os.homedir(), env = process.env } = {}) {
  let file = env.SWARM_CONFIG;
  if (!file) {
    const oldPath = oldInstallConfigPath(home);
    if (fs.existsSync(oldPath)) {
      throw Error(`config-inside-install: ${oldPath} sits in the install checkout; move it to ${defaultConfigPath({ home, env })}`);
    }
    file = defaultConfigPath({ home, env });
  }
  const top = gitWorkTreeTop(path.dirname(file));
  if (top) throw Error(`config-inside-repo: ${file} is inside the git work tree ${top}`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return {}; }
  try { return JSON.parse(text); }
  catch { throw Error(`invalid swarm config: ${file}`); }
}
