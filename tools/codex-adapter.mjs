// SPDX-License-Identifier: Apache-2.0
// Codex's outer macOS seatbelt, not its prompt or built-in sandbox, is the boundary.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NO_STASH_LINE } from './swarm-env.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execViaFile } from './cli-adapters.mjs';

const execGit = promisify(execFile);
export const CODEX_MODEL = /^[A-Za-z0-9._:-]{1,80}$/;
export const CODEX_FLAGS = ['-m', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral', '-C', '-o'];
export function requireCodexPlatform(platform = process.platform) {
  if (platform !== 'darwin') throw Error('codex is unsupported on this platform: macOS seatbelt is required');
}
export function sandboxPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /["\\\x00-\x1f\x7f]/.test(value)) throw Error('Unsafe sandbox path');
  return path.resolve(value);
}
export const DENIED_HOME_DIRS = Object.freeze(['.oasis', 'Library/Keychains', '.ssh', '.aws', '.config']);
const deniedPaths = home => DENIED_HOME_DIRS.map(part => path.join(home, part));
const within = (file, parent) => file === parent || file.startsWith(`${parent}/`);
export function validateReadPaths(paths = [], home = os.homedir()) {
  home = sandboxPath(home);
  if (!Array.isArray(paths) || paths.length > 100) throw Error('readPaths must be an array of at most 100 absolute paths');
  return paths.map(value => {
    const file = sandboxPath(value);
    if (deniedPaths(home).some(denied => within(file.toLowerCase(), denied.toLowerCase()))) throw Error('readPaths cannot grant a denied home directory');
    return file;
  });
}
export async function resolveReadPaths(paths = [], home = os.homedir()) {
  const validated = validateReadPaths(paths, home);
  // Reject aliases into denied directories as well as their literal spellings.
  return validateReadPaths(await Promise.all(validated.map(file => fs.realpath(file))), home);
}
export function codexProfile({ home = os.homedir(), worktree, commonDir, metadataDir, readPaths = [] }) {
  home = sandboxPath(home);
  const reads = [worktree, commonDir, ...['.codex', '.nvm', '.cache', '.npm', '.local/share/uv', 'Library/Caches'].map(p => path.join(home, p)), ...validateReadPaths(readPaths, home)].map(sandboxPath);
  const writes = [worktree, metadataDir, ...['.codex', '.cache', '.npm'].map(p => path.join(home, p)), '/private/tmp', '/private/var/folders'].map(sandboxPath);
  const filter = (kind, file) => `(${kind} "${sandboxPath(file)}")`;
  const ancestors = new Set([home]);
  for (const file of [...reads, metadataDir]) {
    let parent = path.dirname(sandboxPath(file));
    while (within(parent, home)) { ancestors.add(parent); if (parent === home) break; parent = path.dirname(parent); }
  }
  const writable = [...writes.map(file => filter('subpath', file)), '(literal "/dev/null")', '(regex #"^/dev/tty.*$")'].join(' ');
  return `(version 1)\n(allow default)\n(deny file-read* file-write* ${filter('subpath', home)})\n` +
    `(allow file-read* ${[...ancestors].map(file => filter('literal', file)).join(' ')} ${reads.map(file => filter('subpath', file)).join(' ')} ${filter('literal', path.join(home, '.gitconfig'))})\n` +
    `(allow file-write* ${writable})\n(deny file-write* (require-not (require-any ${writable})))\n` +
    `(deny file-read* file-write* ${deniedPaths(home).map(file => filter('subpath', file)).join(' ')})\n` +
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))\n';
}
export function codexArgs(job, { profile, worktree, lastMessage, message }) {
  if (typeof job.model !== 'string' || !CODEX_MODEL.test(job.model)) throw Error('codex requires a valid explicit model');
  return ['-f', sandboxPath(profile), 'codex', 'exec', '-m', job.model, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral', '-C', sandboxPath(worktree), '-o', sandboxPath(lastMessage), message];
}
export function codexMessage(job, { contract = null, gotchas = '' } = {}) {
  const base = `You are a fresh worker in a detached git worktree. Read these context files first: ${JSON.stringify(job.context)}. You may edit only these declared outputs: ${JSON.stringify(job.outputs)}. Do not delete files. Run relevant project tests. Root uncommitted changes are not included.\nRead only the files in your context; other reads may be denied.\nIf a MUST or "do not" rule cannot be met inside your outputs, stop and return status "blocked" with the file you need; never work around a rule. Finish with exactly one JSON line {"files_changed":[...],"notes":[...]} listing changed declared paths and concise notes.\n\n`;
  const contractSection = contract ? `Shared contract (${contract.path}). Read it first; it wins over any other file:\n${contract.text}\n\n` : '';
  const testEnvironment = job.testEnv ? `Test environment (already set): ${Object.entries(job.testEnv).map(([key, value]) => `${key}=${value}`).join(', ')}\n` : '';
  // Field lesson #163: codex has a shell too, and the stash stack is shared by every worktree.
  // Field lesson #167: known platform gotchas for this project, when a .swarm/gotchas.md exists.
  return `${base}${contractSection}${testEnvironment}${NO_STASH_LINE}\n${gotchas}TASK:\n${job.prompt}\n`;
}
const tryObject = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const CODEX_FENCE = /```[a-zA-Z]*[ \t]*\n([\s\S]*?)\n[ \t]*```/g;
function lastFencedObject(text) {
  const fences = [...text.matchAll(CODEX_FENCE)];
  for (let index = fences.length - 1; index >= 0; index--) {
    const value = tryObject(fences[index][1].trim());
    if (value) return value;
  }
  return null;
}
// Depth-aware so a value that itself contains braces never ends a candidate object early.
function lastTopLevelObject(text) {
  const candidates = [];
  let depth = 0, start = -1, inString = false, escape = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (inString) { if (escape) escape = false; else if (ch === '\\') escape = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = index; depth++; }
    else if (ch === '}' && depth > 0) { depth--; if (depth === 0 && start !== -1) { candidates.push(text.slice(start, index + 1)); start = -1; } }
  }
  for (let index = candidates.length - 1; index >= 0; index--) {
    const value = tryObject(candidates[index]);
    if (value) return value;
  }
  return null;
}
// Braden's rule (lessons #41, #64): the reply's last fenced (```json or bare ```) block wins
// when the reply has one; otherwise its last top-level JSON object. Earlier blocks never win
// over a later one, and any keys are accepted — declared outputs, not envelope keys, gate
// what integrates.
export function parseCodexReply(text) {
  if (typeof text !== 'string' || !text) return null;
  if (text.includes('```')) {
    const fenced = lastFencedObject(text);
    if (fenced) return fenced;
  }
  return lastTopLevelObject(text);
}
// Lesson #64: when the reply itself yields nothing, the same `-o` file is re-read directly in
// case only the captured reply text, not the file, was empty or truncated.
export async function codexResultFile(worktree, resultRelative) {
  try { return tryObject((await fs.readFile(path.join(worktree, resultRelative), 'utf8')).trim()); }
  catch { return null; }
}
// Scoped to outputs only (never context) so a fallback result can never widen what integrates.
export async function codexWorktreeFallback(worktree, job) {
  const files = await codexDirtyFiles(worktree, { context: [], outputs: job.outputs });
  return files.length ? { filesChanged: files, fallback: 'worktree' } : null;
}
export async function resolveCodexEnvelope(response, worktree, resultRelative, job) {
  const reply = parseCodexReply(response);
  if (reply) return { result: reply, fallback: null };
  const fromFile = await codexResultFile(worktree, resultRelative);
  if (fromFile) return { result: fromFile, fallback: 'result-file' };
  const fromWorktree = await codexWorktreeFallback(worktree, job);
  if (fromWorktree) return { result: fromWorktree, fallback: 'worktree' };
  return null;
}
export function codexUsage(output) {
  const matches = [...output.matchAll(/\btokens used\s*\n?\s*([0-9][0-9,]*)\s*(?=\n|$)/gi)];
  const count = Number(matches.at(-1)?.[1].replaceAll(',', ''));
  return Number.isSafeInteger(count) && count >= 0 ? { total_tokens: count } : null;
}
export async function codexEnvironment(env = process.env, exists = async file => fs.access(file).then(() => true, () => false)) {
  return { ...env, ...(await exists('/etc/ssl/cert.pem') ? { SSL_CERT_FILE: '/etc/ssl/cert.pem' } : {}) };
}
export async function git(root, args) {
  return (await execGit('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;
}
export async function codexDirtyFiles(root, job) {
  const files = [...new Set([...job.context, ...job.outputs])];
  const dirty = [];
  for (const file of files) {
    // Literal pathspecs handle brackets and other git metacharacters in declared names.
    const spec = `:(literal)${file}`;
    if ((await git(root, ['diff', '--name-only', 'HEAD', '--', spec])).trim() ||
        (await git(root, ['diff', '--cached', '--name-only', 'HEAD', '--', spec])).trim() ||
        (await git(root, ['ls-files', '--others', '--exclude-standard', '--', spec])).trim() ||
        (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', spec])).trim()) dirty.push(file);
  }
  return dirty;
}
async function sandboxProbe(exec) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-sandbox-'));
  const root = await fs.realpath(temporary);
  try {
    await exec('git', ['init', root], { timeout: 10000 });
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    const profile = path.join(root, 'sandbox.sb');
    await fs.writeFile(profile, codexProfile({ worktree: root, commonDir: path.join(root, '.git'), metadataDir: path.join(root, '.git') }));
    await exec('sandbox-exec', ['-f', profile, process.execPath, '-e', "require('fs').readFileSync('package.json')"], { cwd: root, timeout: 10000 });
    return 'ok';
  } catch (error) {
    return /EPERM|Operation not permitted/.test(`${error.message} ${error.stderr ?? ''}`) ? `EPERM ${path.join(root, 'package.json')}` : error.message;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function codexDoctor({ platform = process.platform, exec = execViaFile } = {}) {
  if (platform !== 'darwin') return { agent: 'codex', status: 'unsupported', platform, configured: false, liveVerified: false, note: 'macOS seatbelt is required' };
  const options = { timeout: 10000, maxBuffer: 1024 * 1024 };
  await exec('/usr/bin/which', ['sandbox-exec'], options);
  const version = await exec('codex', ['--version'], options);
  await exec('codex', ['login', 'status'], options);
  let help = await exec('codex', ['exec', '--help'], options).catch(() => ({ stdout: '' }));
  const missing = () => CODEX_FLAGS.filter(flag => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=]|$)`, 'm').test(help.stdout));
  if (missing().length) help = await exec('codex', ['exec', '--help'], options).catch(() => ({ stdout: '' }));
  if (!help.stdout) throw Error('Codex help probe failed (no or empty output)');
  if (missing().length) throw Error(`Codex lacks required flags: ${missing().join(', ')}`);
  const probe = await sandboxProbe(exec);
  return { agent: 'codex', checks: [{ name: 'sandbox probe', status: probe }], status: probe === 'ok' ? 'compatible' : 'failed', platform, version: version.stdout.trim(), auth: 'login status succeeded', liveVerified: false };
}
