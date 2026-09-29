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

// Field lesson #171: the exact shape a mutants file must have, shared byte-for-byte between a
// job's own mutantsFile preamble (tools/swarm.mjs) and `env --print`, so an outside agent who only
// ever reads the pasted block still gets the one true shape instead of guessing at
// `id`/`description`/`kills` (a worker-written file used exactly those and had to be converted by
// hand before `swarm mutants` would take it).
export const MUTANTS_SHAPE = 'a JSON array (or {"mutants":[...]}) of objects shaped exactly {"name": string, "file": string, "find": string, "replace": string}, nothing else on any line of that file.';

// `gotchas` (field lesson #167): { text, source } from tools/gotchas.mjs's loadGotchas, or null.
// `wrapperPath` (field lesson #168): the per-root dir from materializeGitGuard, so an outside agent
// (not a sandboxed shell worker, which already gets its own guard on PATH) that pastes this block
// gets the same git-stash refusal.
export function envPrintText({ env = {}, source = null, portBase = null, gotchas = null, wrapperPath = null } = {}) {
  const lines = [`# project-swarm environment for this root (${source ? `from ${source}` : `no ${ENV_FILE} found`})`, '# Paste into an outside agent\'s prompt; set these before running any check, harness or mutant.'];
  if (wrapperPath != null) lines.push(`export PATH=${shellQuote(wrapperPath)}:"$PATH"  # git here refuses \`git stash\`/\`git stash pop\`; everything else runs the real git`);
  for (const [key, value] of Object.entries(env)) lines.push(`export ${key}=${shellQuote(value)}`);
  if (portBase != null) lines.push(`export SWARM_PORT_BASE=${portBase}  # this worktree owns ports ${portBase}..${portBase + 9}`);
  lines.push('', 'Rules:', `- ${NO_STASH_LINE}`, `- ${MUTANTS_BY_HAND_LINE}`, `- A mutantsFile is ${MUTANTS_SHAPE}`);
  if (gotchas?.text?.trim()) lines.push('', `Known platform gotchas for this project (from ${gotchas.source}):`, gotchas.text.trim());
  return `${lines.join('\n')}\n`;
}

// Field lesson #160: these toolchains usually need a browsers/cache/toolchain path the coordinator
// only knows from prose; with no env file, every check starts without it.
const ENV_HUNGRY = new Set(['npm', 'npx', 'pnpm', 'yarn', 'cargo', 'uv', 'uvx']);
// Field lesson #219: an `npm test`/`npm run <script>` check whose script resolves to a plain
// `node ...` command needs no toolchain env of its own — node itself is not in ENV_HUNGRY, and the
// npm wrapper around it never touches a browsers/cache/toolchain path either. Reading package.json
// is async, so this stays a plain, synchronous predicate: a caller that already knows the script
// map (or has none to offer) passes `resolvesToPlainNode`, kept synchronous so
// `checkNeedsEnvWarnings` itself never needs to become async (byte-identical for every existing
// caller that omits it).
export function npmScriptName(argv) {
  if (path.basename(argv[0] ?? '') !== 'npm') return null;
  if (argv[1] === 'test') return 'test';
  if (argv[1] === 'run' && typeof argv[2] === 'string' && argv[2]) return argv[2];
  return null;
}
export function scriptIsPlainNode(script) {
  return typeof script === 'string' && /^node(\s|$)/.test(script.trim());
}
export function npmScriptsResolveToPlainNode(scripts) {
  return argv => {
    const name = npmScriptName(argv);
    return name !== null && scriptIsPlainNode(scripts?.[name]);
  };
}
export function checkNeedsEnvWarnings(manifest, envFound, { resolvesToPlainNode = () => false } = {}) {
  if (envFound) return [];
  const argvs = [...(manifest.checks ?? []).map(check => [check.name, check.argv]), ...(manifest.preChecks ?? []).map((argv, index) => [`preCheck-${index + 1}`, argv]), ...(manifest.mutantCheck ? [['mutantCheck', manifest.mutantCheck.argv]] : [])];
  const names = argvs.filter(([, argv]) => ENV_HUNGRY.has(path.basename(argv[0] ?? '')) && !resolvesToPlainNode(argv)).map(([name]) => name);
  return names.length ? [{ code: 'check-needs-env', checks: names, message: `checks ${names.join(', ')} run a toolchain (npm/npx/cargo/uv) but no ${ENV_FILE} exists; put the toolchain env there so every check, mutant and worker gets it` }] : [];
}

// Field lesson #170: the git guard's stash refusal also covers a hand mutant-revert. `git checkout
// -- <path>` / `git checkout <path>` / `git restore <path>` silently discard whatever uncommitted
// change sits on that path — exactly what happened when a worker hand-reverted a mutant with
// `git checkout <file>` and wiped its own unrelated edits to that same file. A plain-branch
// checkout (`git checkout main`) is never blocked: the pathspec check below only ever refuses when
// the named argument actually has a diff against HEAD, so a branch name that happens not to be a
// tracked path with local changes always passes straight through to the real git.
export const MUTANTS_BY_HAND_LINE = 'Never hand-revert a mutant (`git checkout <file>` or `git restore <file>`) to undo it: run mutants with `swarm mutants`, never by hand.';

// Field lesson #163: a sandboxed shell worker's `git` is this wrapper first on PATH; `stash` as the
// subcommand (after any global options) is refused with a plain message, anything else runs git.
// Field lesson #170: `checkout`/`restore` of a path that has uncommitted changes is refused too.
export function gitGuardScript(realGit) {
  if (typeof realGit !== 'string' || !path.isAbsolute(realGit) || /['\0\r\n]/.test(realGit)) throw Error('git guard needs an absolute git path');
  return `#!/bin/sh
# project-swarm (lesson #163/#170): git stash, and a checkout/restore of a path with uncommitted
# changes, are both refused in worker sandboxes. Scanning never consumes "$@": on the fallthrough
# path, the real git always gets the exact original argument list, untouched.
real_git='${realGit}'
index=0
skip=0
cdir=""
for arg in "$@"; do
  index=$((index + 1))
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$arg" in
    -C)
      # A global -C changes where "git" itself looks for the repo; the diff check below must
      # look in the same place, or a clean path there reads as dirty from the wrapper's own cwd.
      eval "cdir=\\$$((index + 1))"
      skip=1 ;;
    -c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix) skip=1 ;;
    -*) ;;
    stash)
      echo "swarm: git stash is not allowed here. The stash stack is shared by every worktree and session of this repository. Copy the file aside, or make a temporary WIP commit where commits are allowed." >&2
      exit 2 ;;
    checkout|restore)
      # A subshell parses only the args after this subcommand (via its own private "shift"), so
      # the parent's own "$@" is never touched; the parent only ever reacts to its exit status.
      # Every remaining non-flag argument is checked and refused the moment it turns out to have
      # a diff against HEAD (working tree or staged); a plain branch name never has one, so
      # switching branches always falls through untouched.
      ( sub="$arg"
        shift "$index"
        [ -n "$cdir" ] && cd "$cdir" 2>/dev/null
        while [ $# -gt 0 ]; do
          case "$1" in
            -b|-B|--conflict) shift 2; continue ;;
            -*) shift; continue ;;
            *)
              p="$1"
              if ! "$real_git" diff --quiet -- "$p" 2>/dev/null || ! "$real_git" diff --cached --quiet -- "$p" 2>/dev/null; then
                echo "swarm: git $sub of '$p' is refused here: it has uncommitted changes; commit WIP first (git commit -m WIP), or run mutants with \\\`swarm mutants\\\`, never by hand." >&2
                exit 3
              fi
              shift; continue ;;
          esac
        done
      )
      status=$?
      if [ "$status" = 3 ]; then exit 2; fi
      break ;;
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

// Field lesson #168: the #163 guard above only ever protected a sandboxed shell worker (a fresh
// guardDir per job). An outside agent — not a sandboxed worker, just something pasting `env
// --print`'s block into its own shell — got no such protection, and one ran a bare `git stash` in a
// shared worktree anyway. Fix: a stable per-root wrapper dir, so `env`/`env --print` can hand an
// outside agent a `PATH` entry that refuses `git stash` the same way. `exclude` keeps the wrapper
// from ever resolving to itself, including on a second run after an earlier paste already put this
// same dir on PATH.
export const GIT_GUARD_DIR = path.join('.swarm', 'bin');
export async function materializeGitGuard(root, { parentEnv = process.env } = {}) {
  const wrapperDir = path.join(root, GIT_GUARD_DIR);
  const realGit = await findRealGit(parentEnv.PATH, { exclude: wrapperDir });
  await fs.mkdir(wrapperDir, { recursive: true });
  await fs.writeFile(path.join(wrapperDir, 'git'), gitGuardScript(realGit), { mode: 0o755 });
  return wrapperDir;
}
