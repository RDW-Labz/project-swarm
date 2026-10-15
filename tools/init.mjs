// SPDX-License-Identifier: Apache-2.0
// One command that links a project to the shared install, names the stack, copies checks,
// keeps .swarm/ out of git and out of lint or test runs, and seeds coordination/.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject } from './install.mjs';
import { loadChecksFromCi, DEFAULT_CI_PATH } from './checks-from-ci.mjs';

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
  await fs.writeFile(destination, `${JSON.stringify({ checks }, null, 2)}\n`);
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

export async function initProject(root, { source = installSource(), install = installProject } = {}) {
  const linked = await install(root, { source });
  const stack = await detectStack(root);
  const collected = await collectChecks(root, stack);
  const checksFile = collected.checks.length ? await writeChecks(root, collected.checks) : null;
  const ignores = await ensureToolIgnores(root);
  const pointerPath = path.join(root, '.project-swarm.json');
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  pointer.stack = stack;
  await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  const warnings = [...ignores.warnings];
  for (const skip of collected.skipped) warnings.push(`checks-from-ci-skipped (${skip.reason}): ${skip.raw}`);
  return { ...linked, stack, checks: checksFile, ignores: ignores.changed, warnings };
}
