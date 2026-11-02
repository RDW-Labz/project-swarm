// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

export const WRAPPER_MARKER = '# managed by project-swarm';

export function swarmBinPath(home) {
  return path.join(home, '.local', 'bin', 'swarm');
}

function quote(value) {
  if (typeof value !== 'string' || /[\n\0]/.test(value)) throw new Error('wrapper paths must not contain newline or NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function wrapperText({ node, runner }) {
  return `#!/bin/sh
${WRAPPER_MARKER}
NODE=${quote(node)}
if [ ! -x "$NODE" ]; then
  NODE=$(command -v node) || NODE=
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  printf '%s\\n' 'swarm: node not found; reinstall project-swarm' >&2
  exit 127
fi
exec "$NODE" ${quote(runner)} "$@"
`;
}

// Where the `swarm` command on this machine really runs from: the runner its launcher execs, and the install root that owns it (<root>/current/tools/swarm.mjs).
// Null when there is no launcher of ours.
export async function readLauncher(home) {
  let text;
  try { text = await fs.readFile(swarmBinPath(home), 'utf8'); } catch { return null; }
  if (!managed(text)) return null;
  const m = /^exec "\$NODE" '((?:[^']|'\\'')*)'/m.exec(text);
  if (!m) return null;
  const runner = m[1].replaceAll("'\\''", "'");
  const current = path.dirname(path.dirname(runner));
  // Only an absolute runner under <root>/current names an install; anything else is not guessed at.
  const installRoot = path.isAbsolute(runner) && path.basename(current) === 'current' ? path.dirname(current) : null;
  return { path: swarmBinPath(home), runner, installRoot };
}

async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function managed(text) {
  return text.split('\n')[1] === WRAPPER_MARKER;
}

export async function installSwarmCommand({ home, runner, node = process.execPath }) {
  const file = swarmBinPath(home);
  const result = { path: file, runner, node };
  const text = wrapperText({ node, runner });
  for (const directory of [path.join(home, '.local'), path.dirname(file)]) {
    const stat = await statOrNull(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      return { status: 'refused', ...result, reason: `${directory} is not a regular directory` };
    }
    if (!stat) await fs.mkdir(directory);
  }
  const stat = await statOrNull(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    return { status: 'refused', ...result, reason: `${file} is an existing file or symlink not managed by project-swarm` };
  }
  const previous = stat ? await fs.readFile(file, 'utf8') : null;
  if (stat && !managed(previous)) {
    return { status: 'refused', ...result, reason: `${file} is not managed by project-swarm` };
  }
  if (previous !== text) await fs.writeFile(file, text, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return { status: previous === text ? 'unchanged' : 'installed', ...result };
}

async function realPath(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return path.resolve(file);
    throw error;
  }
}

export async function checkSwarmCommand({ home, env = process.env }) {
  const file = swarmBinPath(home);
  const stat = await statOrNull(file);
  let text = '';
  if (stat?.isFile() || stat?.isSymbolicLink()) {
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const installed = stat !== null;
  const ours = managed(text);
  const match = ours ? text.match(/^exec "\$NODE" ('(?:[^']|'\\'')*') "\$@"$/m) : null;
  const runner = match ? match[1].slice(1, -1).replaceAll("'\\''", "'") : null;
  let runnerExists = false;
  if (runner !== null) {
    try { runnerExists = (await fs.stat(runner)).isFile(); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  const bin = await realPath(path.dirname(file));
  const entries = await Promise.all((env.PATH ?? '').split(path.delimiter).filter(Boolean).map(realPath));
  const onPath = entries.includes(bin);
  const warnings = [];
  if (!installed) warnings.push('swarm-command-missing: run "swarm update" or tools/install.mjs --user to install it');
  else if (!ours) warnings.push(`swarm-command-foreign: ${file} is not managed by project-swarm`);
  else if (runner !== null && !runnerExists) warnings.push(`swarm-command-stale-runner: ${runner} is missing`);
  if (!onPath) warnings.push('swarm-not-on-path: add export PATH="$HOME/.local/bin:$PATH" to ~/.zshenv (zsh reads ~/.zshenv in non-interactive shells; ~/.zshrc is only for interactive ones)');
  return { path: file, installed, ours, runner, runnerExists, onPath, warnings };
}
