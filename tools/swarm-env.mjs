// SPDX-License-Identifier: Apache-2.0
// Field lessons #160/#163: a per-root toolchain env file applied to every check, mutant, setup
// and sandboxed worker, plus the paste-ready text an outside agent's prompt carries (the same env,
// and the shared-stash rule every worker prompt states).
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const ENV_FILE = '.swarm/env.json';
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Never from a file: the runner sets these itself, or they would silently re-point every check.
const RESERVED_KEYS = new Set(['PATH', 'HOME', 'SWARM_PORT_BASE', 'SWARM_IN_SANDBOX']);
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

// Field lesson #163: the stash stack is shared by every worktree and session of one repository.
export const NO_STASH_LINE = 'Never run `git stash` or `git stash pop`: the stash stack is shared by every worktree and session of this repository. To set work aside, make a temporary WIP commit (`git commit -m WIP`, later `git reset --soft HEAD~1`) where commits are allowed, or copy the file aside.';

export function validateSwarmEnv(data, label = ENV_FILE) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error(`${label} must be a JSON object of NAME: "value" strings`);
  const entries = Object.entries(data);
  if (entries.length > 50) throw Error(`${label} may set at most 50 variables`);
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) throw Error(`${label}: invalid variable name ${JSON.stringify(key)}`);
    if (RESERVED_KEYS.has(key)) throw Error(`${label}: ${key} is reserved; the runner sets it itself`);
    if (SECRET_KEY.test(key)) throw Error(`${label}: ${key} looks like a secret; secrets never go in the env file`);
    if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw Error(`${label}: invalid value for ${key}`);
  }
  return Object.fromEntries(entries);
}

async function readEnvFile(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let data;
  try { data = JSON.parse(text); } catch { throw Error(`Invalid JSON in ${file}`); }
  return validateSwarmEnv(data, file);
}

// The root's own file wins; a linked worktree with none falls back to its main worktree's file,
// so one env file serves every worktree of a repository.
export async function loadSwarmEnv(root, { mainRoot } = {}) {
  const own = path.join(root, ENV_FILE);
  const env = await readEnvFile(own);
  if (env) return { env, source: own };
  let main = mainRoot;
  if (main === undefined) {
    try {
      // Only for a root that is itself a worktree's top level, never a plain dir inside some repo.
      const [top, common] = (await execFileAsync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { encoding: 'utf8' })).stdout.trim().split('\n');
      main = path.resolve(await fs.realpath(top)) === path.resolve(await fs.realpath(root)) && path.basename(common) === '.git' ? path.dirname(common) : null;
    } catch { main = null; }
  }
  if (main && path.resolve(main) !== path.resolve(root)) {
    const shared = path.join(main, ENV_FILE);
    const fallback = await readEnvFile(shared);
    if (fallback) return { env: fallback, source: shared };
  }
  return { env: {}, source: null };
}

const shellQuote = value => `'${String(value).split("'").join("'\\''")}'`;
export function envPrintText({ env = {}, source = null, portBase = null } = {}) {
  const lines = [`# project-swarm environment for this root (${source ? `from ${source}` : `no ${ENV_FILE} found`})`, '# Paste into an outside agent\'s prompt; set these before running any check, harness or mutant.'];
  for (const [key, value] of Object.entries(env)) lines.push(`export ${key}=${shellQuote(value)}`);
  if (portBase != null) lines.push(`export SWARM_PORT_BASE=${portBase}  # this worktree owns ports ${portBase}..${portBase + 9}`);
  lines.push('', 'Rules:', `- ${NO_STASH_LINE}`);
  return `${lines.join('\n')}\n`;
}

// Field lesson #160: these toolchains usually need a browsers/cache/toolchain path the coordinator
// only knows from prose; with no env file, every check starts without it.
const ENV_HUNGRY = new Set(['npm', 'npx', 'pnpm', 'yarn', 'cargo', 'uv', 'uvx']);
export function checkNeedsEnvWarnings(manifest, envFound) {
  if (envFound) return [];
  const argvs = [...(manifest.checks ?? []).map(check => [check.name, check.argv]), ...(manifest.preChecks ?? []).map((argv, index) => [`preCheck-${index + 1}`, argv]), ...(manifest.mutantCheck ? [['mutantCheck', manifest.mutantCheck.argv]] : [])];
  const names = argvs.filter(([, argv]) => ENV_HUNGRY.has(path.basename(argv[0] ?? ''))).map(([name]) => name);
  return names.length ? [{ code: 'check-needs-env', checks: names, message: `checks ${names.join(', ')} run a toolchain (npm/npx/cargo/uv) but no ${ENV_FILE} exists; put the toolchain env there so every check, mutant and worker gets it` }] : [];
}

// Field lesson #163: a sandboxed shell worker's `git` is this wrapper first on PATH; `stash` as the
// subcommand (after any global options) is refused with a plain message, anything else runs git.
export function gitGuardScript(realGit) {
  if (typeof realGit !== 'string' || !path.isAbsolute(realGit) || /['\0\r\n]/.test(realGit)) throw Error('git guard needs an absolute git path');
  return `#!/bin/sh
# project-swarm (lesson #163): git stash is refused in worker sandboxes.
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix) skip=1 ;;
    -*) ;;
    stash)
      echo "swarm: git stash is not allowed here. The stash stack is shared by every worktree and session of this repository. Copy the file aside, or make a temporary WIP commit where commits are allowed." >&2
      exit 2 ;;
    *) break ;;
  esac
done
exec '${realGit}' "$@"
`;
}

export async function findRealGit(pathValue, { exclude = null, access = file => fs.access(file, fs.constants.X_OK) } = {}) {
  for (const dir of String(pathValue ?? '').split(':').filter(dir => path.isAbsolute(dir))) {
    if (exclude && path.resolve(dir) === path.resolve(exclude)) continue;
    const candidate = path.join(dir, 'git');
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return '/usr/bin/git';
}
