// SPDX-License-Identifier: Apache-2.0
// One command that links a project to the shared install, names the stack, copies checks,
// keeps .swarm/ out of git and out of lint or test runs, and seeds coordination/.
import { ensureGitignore } from './gitignore-defaults.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject } from './install.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { assertRegularOrMissing } from './journal.mjs';
import { loadChecksFromCi, DEFAULT_CI_PATH } from './checks-from-ci.mjs';
import { detectMigrationsDir } from './migration-gate.mjs';
import { DEFAULT_PROFILE_BUDGET, detectProtectedPaths, normalizeProtectedPath, validateProfile, runBaseChecks, checkSetup, formatBaseRedWarningMessage } from './init-profile.mjs';
import { buildRepoMap, readRepoMap, writeRepoMap, summarizeMap } from './repo-map.mjs';
import { trackedFiles } from './goal.mjs';

const execFileP = promisify(execFile);
const FLAT_ESLINT = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];

export function installSource() {
  const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return path.basename(path.dirname(here)) === 'versions' ? path.dirname(path.dirname(here)) : here;
}

async function exists(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

export async function detectStack(root) {
  const stack = [];
  if (await exists(path.join(root, 'package.json'))) {
    let manager = 'npm';
    if (await exists(path.join(root, 'pnpm-lock.yaml'))) manager = 'pnpm';
    else if (await exists(path.join(root, 'yarn.lock'))) manager = 'yarn';
    stack.push({ name: 'node', packageManager: manager });
  }
  if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'requirements.txt'))) stack.push({ name: 'python' });
  if (await exists(path.join(root, 'go.mod'))) stack.push({ name: 'go' });
  if (await exists(path.join(root, 'Cargo.toml'))) stack.push({ name: 'rust' });
  return stack;
}

function packageChecks(pkg, manager) {
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const checks = [];
  const run = manager === 'npm' ? ['npm', 'run'] : manager === 'pnpm' ? ['pnpm', 'run'] : ['yarn', 'run'];
  if (typeof scripts.test === 'string' && scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
    checks.push({ name: 'test', argv: manager === 'npm' ? ['npm', 'test'] : [run[0], 'test'] });
  }
  if (typeof scripts.lint === 'string' && scripts.lint) checks.push({ name: 'lint', argv: [...run, 'lint'] });
  return checks;
}

function sameArgv(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function collectChecks(root, stack) {
  const node = stack.find(entry => entry.name === 'node');
  const checks = [];
  if (node) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      checks.push(...packageChecks(pkg, node.packageManager));
    } catch { /* a broken package.json still leaves CI checks */ }
  }
  const ci = await loadChecksFromCi(root, DEFAULT_CI_PATH);
  for (const check of ci.checks) {
    if (!checks.some(existing => sameArgv(existing.argv, check.argv))) checks.push({ name: check.name, argv: check.argv });
  }
  return { checks, skipped: ci.skipped ?? [], ciMissing: ci.missing === true };
}

async function writeChecks(root, checks) {
  const relative = 'coordination/checks.json';
  const destination = path.join(root, relative);
  if (await exists(destination)) return { path: relative, written: false };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await writeFileSafe(destination, `${JSON.stringify({ checks }, null, 2)}\n`);
  return { path: relative, written: true };
}

async function ensureLine(root, relative, line) {
  const destination = path.join(root, relative);
  const before = await readText(destination);
  if (before === null) return false;
  if (before.includes('.swarm')) return false;
  const next = before + (before.endsWith('\n') || before === '' ? '' : '\n') + `${line}\n`;
  await fs.writeFile(destination, next);
  return true;
}

// Only edit a config when the edit is a real ignore and the file shape is obvious.
async function ensureToolIgnores(root) {
  const changed = [];
  const warnings = [];
  if (await ensureLine(root, '.eslintignore', '.swarm/')) changed.push('.eslintignore');
  if (await ensureLine(root, 'pytest.ini', 'norecursedirs = .swarm')) changed.push('pytest.ini');
  for (const file of FLAT_ESLINT) {
    const text = await readText(path.join(root, file));
    if (text === null || text.includes('.swarm')) continue;
    if (!/export default \[[\s\S]*\];\s*$/.test(text)) {
      warnings.push(`swarm-dir-not-ignored: ${file}`);
      continue;
    }
    await fs.writeFile(path.join(root, file), text.replace(/];\s*$/, `  { ignores: ['.swarm/**'] },\n];\n`));
    changed.push(file);
  }
  for (const file of ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts', 'pyproject.toml']) {
    const text = await readText(path.join(root, file));
    if (text !== null && !text.includes('.swarm')) warnings.push(`swarm-dir-not-ignored: ${file}`);
  }
  return { changed, warnings };
}

const WALK_SKIP = new Set(['.git', 'node_modules', '.swarm', 'dist', 'build', '__pycache__', '.venv', 'target']);

// The project's files: tracked ones in a git repo, otherwise a bounded walk.
export async function listProjectFiles(root) {
  const tracked = await trackedFiles(root);
  if (tracked.length) return tracked;
  const out = [];
  const walk = async dir => {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (out.length >= 20000 || entry.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!WALK_SKIP.has(entry.name)) await walk(rel); } else if (entry.isFile()) out.push(rel);
    }
  };
  await walk('');
  return out;
}

export async function gitHead(root) {
  return new Promise(resolve => execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout.trim())));
}

// Checks get a small environment, never the owner's API keys or tokens.
const CHECK_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ', 'USER', 'SHELL', 'CI'];

// Runs one check as the owner would: argv, no shell, in the project folder, in its own process group so a timeout
// (or a check that leaves children behind) cannot hang init.
export function runCheckArgv(argv, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(CHECK_ENV.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const keep = (current, chunk) => (current + chunk).slice(-65536);
    child.stdout.on('data', chunk => { stdout = keep(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = keep(stderr, chunk); });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const finish = action => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${timeoutMs} ms`))), timeoutMs);
    child.on('error', error => finish(() => reject(error)));
    child.on('exit', code => setTimeout(() => finish(() => resolve({ exitCode: code ?? 1, stdout, stderr })), 50));
  });
}

// Every init write goes through a temp file and a rename, and never through a symlink.
async function writeFileSafe(file, text) {
  await assertRegularOrMissing(file);
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(text); } finally { await handle.close(); }
  await fs.rename(temp, file);
}

// Tracked files plus untracked and ignored ones, so a git-ignored .env is still found.
async function listForDetection(root) {
  const tracked = await listProjectFiles(root);
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'ls-files', '-o', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return [...tracked, ...stdout.split('\0').filter(Boolean).slice(0, 50000)];
  } catch { return tracked; }
}

// Reads a project file only if it is a plain file: no symlink, device or fifo, and never more than the map's limit.
async function readPlainFile(file) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return Buffer.alloc(0);
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function refreshRepoMap(root, { now = Date.now } = {}) {
  const previous = await readRepoMap(root);
  const head = await gitHead(root);
  const map = await buildRepoMap(root, {
    previous, head, now, list: listProjectFiles,
    readFile: readPlainFile,
    stat: file => fs.lstat(file),
  });
  await writeRepoMap(root, map);
  return map;
}

async function readChecks(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, 'coordination/checks.json'), 'utf8'));
    return Array.isArray(parsed.checks) ? parsed.checks.filter(check => Array.isArray(check?.argv) && check.argv.length) : [];
  } catch { return []; }
}

export async function initProject(root, { source = installSource(), install = installProject, sensitive, protect = [], readOnly = [], maxUsd, maxTokens, baseCheck, confirmBase, map = true, ask, run = runCheckArgv, now = Date.now } = {}) {
  // The earlier answers are read before install rewrites the pointer file.
  const priorPointer = await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8').then(text => JSON.parse(text), () => null);
  const linked = await install(root, { source });
  const stack = await detectStack(root);
  const collected = await collectChecks(root, stack);
  const checksFile = collected.checks.length ? await writeChecks(root, collected.checks) : null;
  const ignores = await ensureToolIgnores(root);
  // Build output must never be committed: a stack-aware block is added to .gitignore (nothing is removed).
  const gitignoreResult = stack.length ? await ensureGitignore(root, stack.map(entry => entry.name)).catch(error => ({ changed: false, error })) : { changed: false, added: [] };
  const pointerPath = path.join(root, '.project-swarm.json');
  const pointer = await fs.readFile(pointerPath, 'utf8').then(text => JSON.parse(text), () => { throw Object.assign(new Error('init-pointer-invalid: .project-swarm.json is not valid JSON'), { code: 'init-pointer-invalid' }); });
  const prior = priorPointer?.profile && typeof priorPointer.profile === 'object' ? priorPointer.profile : {};
  pointer.stack = stack;
  // The owner's answers are kept: init never asks twice, and an explicit flag overrides.
  let answer = sensitive ?? prior.sensitive;
  if (answer === undefined) answer = ask ? await ask() : true;
  // The base check executes the project's own commands (package.json scripts, checks.json), so it never runs unasked:
  // --base-check runs it, a terminal is asked after seeing the commands, anything else skips it and says so.
  const checksToRun = await readChecks(root);
  let runBase = baseCheck === true;
  if (baseCheck === undefined && checksToRun.length && confirmBase) runBase = await confirmBase(checksToRun);
  const detected = await detectProtectedPaths(root, { list: listForDetection });
  const migrationsDir = await detectMigrationsDir(root);
  const profile = {
    stack,
    sensitive: answer !== false,
    protectedPaths: [...new Set([...(prior.protectedPaths ?? []), ...detected, ...protect.map(normalizeProtectedPath)])].sort(),
    ...((prior.readOnlyPaths?.length || readOnly.length) ? { readOnlyPaths: [...new Set([...(prior.readOnlyPaths ?? []), ...readOnly.map(normalizeProtectedPath)])].sort() } : {}),
    budget: { ...DEFAULT_PROFILE_BUDGET, ...(prior.budget ?? {}), ...(maxUsd !== undefined ? { maxUsd } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}) },
    // Blocks the owner set by hand (security policy, approval, ci hooks, verify, context) survive a re-init.
    ...Object.fromEntries(['security', 'approval', 'ci', 'verify', 'context', 'ui', 'quality', 'migrations', 'acceptance'].filter(key => prior[key] !== undefined).map(key => [key, prior[key]])),
    // A NEW project (no profile yet) that already has a migrations folder gets the migration check on; an existing profile keeps what it has.
    ...(priorPointer?.profile === undefined && prior.migrations === undefined && migrationsDir ? { migrations: migrationsDir === 'supabase/migrations' ? { dir: migrationsDir, down: 'dir', downDir: 'supabase/migrations_down' } : { dir: migrationsDir, down: 'sibling' } } : {}),
    baseCheck: runBase
      ? await runBaseChecks(root, checksToRun, { run, head: await gitHead(root), now })
      : (prior.baseCheck ?? { status: 'skipped', ranAt: new Date(now()).toISOString(), head: await gitHead(root), checks: [] }),
  };
  const { profile: valid, errors } = validateProfile(profile);
  if (errors.length) throw Object.assign(new Error(`init-profile-invalid: ${errors[0]}`), { code: 'init-profile-invalid' });
  pointer.profile = valid;
  await writeFileSafe(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  const warnings = [...ignores.warnings];
  if (gitignoreResult.error) warnings.push(`gitignore-defaults-skipped: ${String(gitignoreResult.error.message).slice(0, 120)}`);
  else if (gitignoreResult.changed) warnings.push(`gitignore-defaults-added: ${gitignoreResult.added.length} line(s) for ${stack.map(entry => entry.name).join(', ')}`);
  if (valid.migrations && priorPointer?.profile === undefined) warnings.push(`migrations-check-on: ${valid.migrations.dir} has migrations, so every changed migration needs a down step and destructive SQL needs swarm migrations approve (see docs/safety.md; remove the profile.migrations block to turn it off)`);
  for (const skip of collected.skipped) warnings.push(`checks-from-ci-skipped (${skip.reason}): ${skip.raw}`);
  if (valid.baseCheck.status === 'red') warnings.push(formatBaseRedWarningMessage(valid.baseCheck));
  if (!runBase && baseCheck !== false && checksToRun.length) warnings.push('base-check-skipped: pass --base-check to run the project\'s own checks and record whether they already fail');
  let repoMap = null;
  if (map) { try { repoMap = summarizeMap(await refreshRepoMap(root, { now })); } catch (error) { warnings.push(`repo-map-failed: ${String(error.message).slice(0, 120)}`); } }
  return { ...linked, stack, profile: valid, checks: checksFile, ignores: ignores.changed, repoMap, warnings };
}

// Read-only health check of the setup (swarm init --check).
export async function checkProject(root, { installVersion } = {}) {
  const read = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
  return checkSetup(root, {
    readJson: read,
    exists: name => fs.access(path.join(root, name)).then(() => true, () => false),
    stat: name => fs.stat(path.join(root, name)),
    head: () => gitHead(root),
    installVersion,
    readMap: () => readRepoMap(root),
    now: Date.now,
  });
}
