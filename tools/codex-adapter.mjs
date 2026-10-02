// SPDX-License-Identifier: Apache-2.0
// Codex's outer macOS seatbelt, not its prompt or built-in sandbox, is the boundary.
import fs from 'node:fs/promises';
import { mkdirSync, realpathSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_STASH_LINE, MUTANTS_BY_HAND_LINE } from './swarm-env.mjs';
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
// Generic entries only: a public repo names no product-specific path here. A project adds its
// own via config `deniedHomeDirs` (loadLocalConfig), merged in by effectiveDeniedHomeDirs.
export const DENIED_HOME_DIRS = Object.freeze(['Library/Keychains', '.ssh', '.aws', '.config']);
export function effectiveDeniedHomeDirs(config = {}) {
  const extra = Array.isArray(config?.deniedHomeDirs) ? config.deniedHomeDirs.filter(value => typeof value === 'string' && value) : [];
  return [...DENIED_HOME_DIRS, ...extra];
}
const deniedPaths = (home, config = {}) => effectiveDeniedHomeDirs(config).map(part => path.join(home, part));
const within = (file, parent) => file === parent || file.startsWith(`${parent}/`);
// Field lesson #255: both the raw and realpath'd form of the current process's own os.tmpdir(),
// alongside /tmp and /private/tmp, since macOS resolves /tmp and /var through symlinks into
// /private and a profile rule written against one spelling may not match the other at the VFS
// layer. Exported so both adapters (and tests) share one definition of "the OS temp dirs".
export function defaultTmpRoots() {
  const raw = os.tmpdir();
  let real = raw;
  try { real = realpathSync(raw); } catch { /* raw kept as the sole spelling */ }
  return [...new Set(['/private/tmp', '/tmp', raw, real])];
}
export function validateReadPaths(paths = [], home = os.homedir(), config = {}) {
  home = sandboxPath(home);
  if (!Array.isArray(paths) || paths.length > 100) throw Error('readPaths must be an array of at most 100 absolute paths');
  return paths.map(value => {
    const file = sandboxPath(value);
    if (deniedPaths(home, config).some(denied => within(file.toLowerCase(), denied.toLowerCase()))) throw Error('readPaths cannot grant a denied home directory');
    return file;
  });
}
export async function resolveReadPaths(paths = [], home = os.homedir(), config = {}) {
  const validated = validateReadPaths(paths, home, config);
  // Reject aliases into denied directories as well as their literal spellings.
  return validateReadPaths(await Promise.all(validated.map(file => fs.realpath(file))), home, config);
}
export function codexProfile({ home = os.homedir(), worktree, commonDir, metadataDir, scratchDir, readPaths = [], environmentReadPaths = [], config = {}, tmpRoots = defaultTmpRoots() }) {
  home = sandboxPath(home);
  const reads = [worktree, commonDir, ...['.codex', '.nvm', '.cache', '.npm', '.local/share/uv', 'Library/Caches'].map(p => path.join(home, p)), ...validateReadPaths(readPaths, home, config)].map(sandboxPath);
  let scratchPaths = [];
  if (scratchDir !== undefined) {
    const raw = sandboxPath(scratchDir);
    mkdirSync(raw, { recursive: true });
    scratchPaths = [...new Set([raw, sandboxPath(realpathSync.native(raw))])];
  }
  const environment = validateReadPaths(environmentReadPaths, home, config);
  const writes = [worktree, metadataDir, ...scratchPaths, ...['.codex', '.cache', '.npm'].map(p => path.join(home, p)), '/private/tmp', '/private/var/folders'].map(sandboxPath);
  const filter = (kind, file) => `(${kind} "${sandboxPath(file)}")`;
  const ancestors = new Set([home]);
  for (const file of [...reads, metadataDir]) {
    let parent = path.dirname(sandboxPath(file));
    while (within(parent, home)) { ancestors.add(parent); if (parent === home) break; parent = path.dirname(parent); }
  }
  const writable = [...writes.map(file => filter('subpath', file)), '(literal "/dev/null")', '(regex #"^/dev/tty.*$")'].join(' ');
  // Field lesson #255: read and exec are denied under every OS temp dir by default, with
  // access to the worktree/commonDir and the one job-scoped scratch directory granted below.
  // Sibling temp directories (another checkout's scratch data) remain denied.
  const tmpDeny = [...new Set(tmpRoots.map(sandboxPath))].map(file => filter('subpath', file)).join(' ');
  // Lesson #299: sandbox-exec uses the last matching rule; this exact scratch grant must follow
  // tmpDeny. Keep it in `writes` too so the later write restriction does not deny it again.
  // macOS resolves /var into /private/var at the kernel boundary; grant both spellings.
  const scratchAllow = scratchPaths.length ? `(allow file-read* file-write* process-exec ${scratchPaths.map(file => filter('subpath', file)).join(' ')})\n` : '';
  // realpath needs metadata for every ancestor, including those hidden by tmpDeny.
  const scratchAncestors = new Set();
  for (const file of scratchPaths) {
    for (let ancestor = file; ancestor !== path.parse(ancestor).root; ancestor = path.dirname(ancestor)) scratchAncestors.add(sandboxPath(ancestor));
  }
  const scratchMetadataAllow = scratchAncestors.size ? `(allow file-read-metadata ${[...scratchAncestors].map(file => filter('literal', file)).join(' ')})\n` : '';
  const environmentAncestors = new Set();
  for (const file of environment) {
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      environmentAncestors.add(parent);
      if (parent === path.parse(parent).root) break;
    }
  }
  const environmentAllow = environment.map(file => `(allow file-read* ${filter('subpath', file)})\n(allow process-exec ${filter('subpath', file)})\n`).join('') +
    (environmentAncestors.size ? `(allow file-read-metadata ${[...environmentAncestors].map(file => filter('literal', file)).join(' ')})\n` : '');
  const environmentDeny = environment.map(file => `(deny file-write* ${filter('subpath', file)})\n`).join('');
  return `(version 1)\n(allow default)\n(deny file-read* file-write* ${filter('subpath', home)})\n` +
    `(deny file-read* process-exec ${tmpDeny})\n` +
    scratchAllow + scratchMetadataAllow + environmentAllow +
    `(allow file-read* ${[...ancestors].map(file => filter('literal', file)).join(' ')} ${reads.map(file => filter('subpath', file)).join(' ')} ${filter('literal', path.join(home, '.gitconfig'))})\n` +
    `(allow process-exec ${reads.map(file => filter('subpath', file)).join(' ')})\n` +
    `(allow file-write* ${writable})\n(deny file-write* (require-not (require-any ${writable})))\n` +
    environmentDeny +
    `(deny file-read* file-write* ${deniedPaths(home, config).map(file => filter('subpath', file)).join(' ')})\n` +
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))\n';
}
export function codexArgs(job, { profile, worktree, lastMessage, message }) {
  if (typeof job.model !== 'string' || !CODEX_MODEL.test(job.model)) throw Error('codex requires a valid explicit model');
  return ['-f', sandboxPath(profile), 'codex', 'exec', '-m', job.model, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--ephemeral', '-C', sandboxPath(worktree), '-o', sandboxPath(lastMessage), message];
}
// Field lesson #288: codexMessage's own "Read only the files in your context; other reads may be
// denied" line reads as an absolute rule to a model that just saw its own repo's AGENTS.md demand
// a doc not shown inline — it refuses instead of testing whether the read actually succeeds. This
// waiver names the exact narrow case that is genuinely out of reach, so the rest of that sentence
// stays true for everything else.
export const CODEX_OUT_OF_REPO_DOCS_WAIVER_LINE = "Any doc your own AGENTS.md names that is not shown inline above, not in your context list, and not under .swarm/skills lives outside this worktree; you do not need to fetch it or ask for it — proceed using only what is provided here.\n";
export function codexMessage(job, { contract = null, gotchas = '', skills = '', agentsWorkspace = null, checks = [] } = {}) {
  const base = `You are a fresh worker in a detached git worktree. Read these context files first: ${JSON.stringify(job.context)}. You may edit only these declared outputs: ${JSON.stringify(job.outputs)}. Do not delete files. Run relevant project tests. Root uncommitted changes are not included.\nRead only the files in your context; other reads may be denied.\nIf a MUST or "do not" rule cannot be met inside your outputs, stop and return status "blocked" with the file you need; never work around a rule. Finish with exactly one JSON line {"files_changed":[...],"notes":[...]} listing changed declared paths and concise notes.\n\n`;
  const contractSection = contract ? `Shared contract (${contract.path}). Read it first; it wins over any other file:\n${contract.text}\n\n` : '';
  // Field lesson #288: a codex worktree already contains every tracked file at HEAD and already has
  // .swarm/skills copied in, so a doc this repo's own AGENTS.md names is usually already readable;
  // inlined directly (never relies on the worker thinking to go read it) when the run found one.
  const agentsWorkspaceSection = agentsWorkspace ? `Required reading named by this repo's own AGENTS.md (${agentsWorkspace.path}); it is already in your worktree and readable, read it now:\n${agentsWorkspace.text}\n\n` : '';
  const checkList = checks.length ? checks.map(check => `${check.name}: ${JSON.stringify(check.argv)}${check.integrateOnly || check.status === 'path-denied' || check.status === 'not run' || /skipped-integrate-only|integrate-only: path outside this worktree|path-denied/.test(check.name) || check.argv.some(arg => /^\{(?:integrated|new)(?::[^}]+)?\}$/.test(arg)) ? ' (not run: orchestrator-only or path-denied)' : ''}`).join('; ') : 'none declared; run relevant tests';
  const checksLine = `Manifest checks: ${checkList}. Run these; fix red before you return; report checksRun.\nReport checksRun as [{"name":"NAME","status":"passed|failed|not run"}]. Checks marked not run must stay not run; do not evade path restrictions or run orchestrator-only checks.\n`;
  const testEnvironment = job.testEnv ? `Test environment (already set): ${Object.entries(job.testEnv).map(([key, value]) => `${key}=${value}`).join(', ')}\n` : '';
  // Field lesson #163: codex has a shell too, and the stash stack is shared by every worktree.
  // Field lesson #170: never hand-revert a mutant with checkout/restore; run `swarm mutants`.
  // Field lesson #167: known platform gotchas for this project, when a .swarm/gotchas.md exists.
  return `${base}${CODEX_OUT_OF_REPO_DOCS_WAIVER_LINE}${contractSection}${agentsWorkspaceSection}${testEnvironment}${checksLine}${NO_STASH_LINE}\n${MUTANTS_BY_HAND_LINE}\n${gotchas}${skills}TASK:\n${job.prompt}\n`;
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
// Rule (field lessons 41, 64): the reply's last fenced (```json or bare ```) block wins
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

// Only internal shell worktrees call this helper. The caller runs job.setup before link mode,
// and after sync mode. runSetup owns setup.log, the setup env and the 600000 ms timeout.
export async function prepareWorkspaceEnvironment(root, worktree, { sync = false, runSetup, home = os.homedir(), config = {} } = {}) {
  const invalid = (file, cause) => Object.assign(new Error(`workspace-env-invalid: ${file}`, { cause }), { code: 'workspace-env-invalid', path: file });
  const infoAt = async file => {
    try { return await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw invalid(file, error); }
  };
  const directory = async file => {
    try {
      const [real] = await resolveReadPaths([file], home, config);
      if (!(await fs.stat(real)).isDirectory()) throw Error('dependency must be a directory');
      return real;
    } catch (error) { throw invalid(file, error); }
  };
  root = await fs.realpath(root);
  worktree = await fs.realpath(worktree);
  if (root === worktree) throw invalid(worktree);
  const dependencies = [];
  // Validate every destination before creating links or invoking an installer.
  for (const name of ['.venv', 'node_modules']) {
    const source = path.join(root, name), destination = path.join(worktree, name);
    const targetInfo = await infoAt(destination);
    if (targetInfo && !targetInfo.isDirectory() && !targetInfo.isSymbolicLink()) throw invalid(destination);
    const target = targetInfo ? await directory(destination) : null;
    if (sync) {
      if (targetInfo?.isSymbolicLink() && !within(target, worktree)) throw invalid(destination);
      continue;
    }
    const sourceInfo = await infoAt(source);
    const real = sourceInfo ? await directory(source) : null;
    if (targetInfo?.isSymbolicLink() && (!real || target !== real)) throw invalid(destination);
    if (real && !targetInfo?.isDirectory()) dependencies.push({ destination, real, linked: Boolean(targetInfo) });
  }
  let setupResult = null;
  if (sync) {
    for (const [marker, argv] of [['pyproject.toml', ['uv', 'sync', '--locked']], ['package-lock.json', ['npm', 'ci']]]) {
      if (!await infoAt(path.join(worktree, marker))) continue;
      if (typeof runSetup !== 'function') throw Error('sync requires runSetup');
      setupResult = await runSetup(argv);
      if (setupResult?.status !== 'passed') return { environmentReadPaths: [], setupResult };
    }
    return { environmentReadPaths: [], setupResult };
  }
  for (const { destination, real, linked } of dependencies) {
    if (!linked) {
      try { await fs.symlink(real, destination, 'dir'); }
      catch (error) { throw invalid(destination, error); }
    }
  }
  return { environmentReadPaths: [...new Set(dependencies.map(item => item.real))], setupResult };
}

// Synchronous append makes evidence visible before a caller applies its in-memory log cap.
// Buffers preserve arbitrary child bytes and retain only a possible split-key suffix.
export async function createAdapterLogSink(directory, { privateData = false, workerKey = null } = {}) {
  const handles = new Map(), pending = new Map();
  const key = workerKey ? Buffer.from(workerKey) : null;
  const replacement = Buffer.from('[worker-key-redacted]');
  let failure = null, closed = false;
  const logError = (stream, cause) => {
    failure ??= Object.assign(new Error(`adapter-log-failed: ${stream}`, { cause }), { code: 'adapter-log-failed', stream });
    return failure;
  };
  const append = (stream, bytes) => {
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(handles.get(stream), bytes, offset, bytes.length - offset);
        if (!written) throw Error('empty log write');
        offset += written;
      }
    } catch (error) { throw logError(stream, error); }
  };
  try {
    await fs.mkdir(directory, { recursive: true });
    for (const stream of ['stderr', 'stdout']) {
      try {
        handles.set(stream, openSync(path.join(directory, `${stream}.txt`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600));
        pending.set(stream, Buffer.alloc(0));
        if (privateData) append(stream, Buffer.from('[transcript withheld: job declared privateData: true]\n'));
      } catch (error) { throw logError(stream, error); }
    }
  } catch (error) {
    for (const [stream, handle] of handles) { try { closeSync(handle); } catch (problem) { logError(stream, problem); } }
    throw failure ?? logError('stderr', error);
  }
  return {
    write(stream, chunk) {
      if (!handles.has(stream)) throw Error('unknown adapter stream');
      if (failure) throw failure;
      if (closed) throw logError(stream, Error('adapter log is closed'));
      if (privateData) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!key) { append(stream, bytes); return; }
      const combined = Buffer.concat([pending.get(stream), bytes]);
      let offset = 0, match;
      while ((match = combined.indexOf(key, offset)) !== -1) {
        append(stream, combined.subarray(offset, match));
        append(stream, replacement);
        offset = match + key.length;
      }
      let retained = Math.min(key.length - 1, combined.length - offset);
      while (retained > 0 && !combined.subarray(combined.length - retained).equals(key.subarray(0, retained))) retained--;
      append(stream, combined.subarray(offset, combined.length - retained));
      pending.set(stream, Buffer.from(combined.subarray(combined.length - retained)));
    },
    async close() {
      if (!closed) {
        closed = true;
        for (const [stream, handle] of handles) {
          try { if (!failure) append(stream, pending.get(stream)); }
          catch (error) { logError(stream, error); }
          finally { try { closeSync(handle); } catch (error) { logError(stream, error); } }
        }
      }
      if (failure) throw failure;
    },
  };
}

export const CODEX_BLIP_RE = /workspace routing discovery failed|Reconnecting\.\.\. 5\/5|Connection failed: error sending request/;
// attempt owns fresh result filenames and returns validation failures with their stderr intact.
// hasWrittenOutputs compares bytes AND modes against the immediate pre-launch snapshot,
// including creation/deletion. onRetry persists retries/retryReason before the second launch.
export async function runCodexWithRetry(attempt, { hasWrittenOutputs, onRetry, cancelled = () => false }) {
  const result = await attempt(0);
  if (result.status !== 'failed' || result.cleanupError || result.refusedBeforeStart ||
      result.terminationReason || result.cancelled || result.timedOut || result.code === 'adapter-log-failed' || await cancelled()) return result;
  const match = CODEX_BLIP_RE.exec(result.stderr ?? '');
  if (!match) return result;
  if (await hasWrittenOutputs()) return result;
  if (await cancelled()) return result;
  await onRetry(`codex-blip: ${match[0]}`);
  if (await cancelled()) return result;
  return attempt(1);
}
