// SPDX-License-Identifier: Apache-2.0
// This project's own local, machine-specific config: a public repo names no private package or
// service, so anything project-specific (keychain service name, rig port file, cheap-tier
// override, extra denied home directories, a private-names list) arrives here instead of as a
// source literal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Field lesson 112: the old default, `<home>/.project-swarm/config.json`, sits inside the shared
// install clone itself (the same directory `git pull`/`swarm update` operate on) — a machine-local
// file living inside a git checkout is neither private nor safe from being overwritten. The default
// now lives under XDG (or `~/.config` when XDG_CONFIG_HOME is unset or relative); `SWARM_CONFIG`
// still wins over either.
// `home` defaults from the same `env` every other part of the path resolves from (env.HOME, same
// as env.XDG_CONFIG_HOME just below), never straight from the live process's os.homedir() — a
// caller that passes an isolated env (a test harness, a sandboxed job) gets an isolated home too,
// instead of the resolution silently reading past it to the real machine.
export function defaultConfigPath({ env = process.env, home = env.HOME || os.homedir() } = {}) {
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

// The file loadLocalConfig actually reads, without its side effects (the old-install-path throw,
// the parse). A caller that only needs to name the path in a message — never a second, drifting
// copy of the same `env.SWARM_CONFIG || defaultConfigPath(...)` logic — uses this instead.
export function resolveConfigPath({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_CONFIG || defaultConfigPath({ env, home });
}

export function loadLocalConfig({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  let file = env.SWARM_CONFIG;
  if (!file) {
    const oldPath = oldInstallConfigPath(home);
    if (fs.existsSync(oldPath)) {
      throw Error(`config-inside-install: ${oldPath} sits in the install checkout; move it to ${defaultConfigPath({ home, env })}`);
    }
    file = defaultConfigPath({ home, env });
  }
  const top = gitWorkTreeTop(path.dirname(file));
  // Sandbox-local config is allowed only under the work tree's designated scratch directories.
  const sandboxConfig = top && ['.swarm-tmp', '.swarm'].some(dir => path.relative(top, path.resolve(file)).startsWith(dir + path.sep));
  if (top && !sandboxConfig) throw Error(`config-inside-repo: ${file} is inside the git work tree ${top}`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return {}; }
  try { return JSON.parse(text); }
  catch { throw Error(`invalid swarm config: ${file}`); }
}
