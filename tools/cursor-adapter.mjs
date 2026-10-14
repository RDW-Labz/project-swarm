// SPDX-License-Identifier: Apache-2.0
// Cursor CLI (cursor-agent) as a worktree writer, mirroring codex-adapter.mjs: the outer macOS
// seatbelt (codexProfile plus the cursor install dir and ~/.cursor), not cursor's own sandbox or
// prompt, is the boundary. The Keychain stays denied, so the worker authenticates only through
// CURSOR_API_KEY in its own environment; the key never appears in argv, the prompt or a log.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execViaFile } from './cli-adapters.mjs';
import { codexProfile, codexMessage, parseCodexReply, codexWorktreeFallback, sandboxPath, validateReadPaths, DEFAULT_MAX_ATTEMPTS } from './codex-adapter.mjs';

export const CURSOR_BINARY = 'cursor-agent';
// Plain names (composer-2.5, gpt-5) plus cursor's quoted bracket parameters (model[effort=high]).
export const CURSOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}(?:\[[A-Za-z0-9=,._-]{1,120}\])?$/;
// Every flag cursorArgs passes; doctor refuses a cursor-agent whose --help lacks one.
export const CURSOR_FLAGS = ['-p', '--output-format', '--model', '--trust', '--workspace', '--sandbox', '--force'];
// Never passed: --api-key puts the key in argv; --worktree/--approve-mcps leave the swarm boundary.
export const CURSOR_FORBIDDEN_FLAGS = ['--api-key', '--worktree', '-w', '--approve-mcps', '--yolo'];
export const CURSOR_DEFAULTS = Object.freeze({ model: 'composer-2.5', timeoutMs: 300000, maxAttempts: DEFAULT_MAX_ATTEMPTS, allowedPaths: [] });
export const CURSOR_NOT_AUTHENTICATED = 'cursor-not-authenticated: set CURSOR_API_KEY in the swarm environment (Keychain login is blocked by the sandbox)';
// Transient transport failures only; a model or auth error is never retried.
export const CURSOR_BLIP_RE = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)\b|socket hang up|network error|Connection (?:error|failed|reset)|\b(?:502|503|504) (?:Bad Gateway|Service Unavailable|Gateway Timeout)\b/i;

export function requireCursorPlatform(platform = process.platform) {
  if (platform !== 'darwin') throw Error('cursor is unsupported on this platform: macOS seatbelt is required');
}

// config.cursor, with defaults; allowedPaths are extra read-only paths, validated like readPaths.
export function cursorConfig(config = {}, home = os.homedir()) {
  const raw = config?.cursor ?? {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('config.cursor must be an object');
  const merged = { ...CURSOR_DEFAULTS, ...raw };
  if (typeof merged.model !== 'string' || !CURSOR_MODEL.test(merged.model)) throw Error('config.cursor.model is not a valid cursor model name');
  if (!Number.isInteger(merged.timeoutMs) || merged.timeoutMs < 50 || merged.timeoutMs > 3600000) throw Error('config.cursor.timeoutMs must be 50–3600000');
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1 || merged.maxAttempts > 5) throw Error('config.cursor.maxAttempts must be 1–5');
  return { ...merged, allowedPaths: validateReadPaths(merged.allowedPaths, home, config) };
}

// The key itself is checked only for presence and shape; it is never printed.
export function requireCursorApiKey(env = process.env) {
  const key = env?.CURSOR_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw Object.assign(new Error(CURSOR_NOT_AUTHENTICATED), { code: 'cursor-not-authenticated' });
  if (/[\s\0]/.test(key) || key.length < 8) throw Object.assign(new Error('cursor-not-authenticated: CURSOR_API_KEY is malformed (whitespace, control characters or too short)'), { code: 'cursor-not-authenticated' });
  return key;
}

// Resolves cursor-agent on the given PATH to its real file: ~/.local/bin/cursor-agent is a symlink
// into ~/.local/share/cursor-agent/versions/<ver>/, and only that version directory is granted.
export async function resolveCursorBinary(env = process.env, { access = file => fs.access(file, fs.constants?.X_OK ?? 1), realpath = file => fs.realpath(file) } = {}) {
  for (const dir of String(env?.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) {
    const candidate = path.join(dir, CURSOR_BINARY);
    try { await access(candidate); } catch { continue; }
    const real = await realpath(candidate);
    return { bin: real, installDir: path.dirname(real) };
  }
  throw Object.assign(new Error(`cursor-not-installed: ${CURSOR_BINARY} was not found on PATH; install the Cursor CLI (https://cursor.com/cli) or add its bin directory to PATH`), { code: 'cursor-not-installed' });
}

// Exactly codexProfile, plus read+exec of the cursor install dir and read+write of ~/.cursor.
// Worktree-only writes, the denied home dirs and the Keychain mach-lookup deny are unchanged.
export function cursorProfile({ home = os.homedir(), installDir, readPaths = [], ...options }) {
  home = sandboxPath(home);
  return codexProfile({ ...options, home, readPaths: [...readPaths, sandboxPath(installDir)], extraWrites: [path.join(home, '.cursor')] });
}

export function cursorArgs(job, { worktree, message }) {
  if (typeof job.model !== 'string' || !CURSOR_MODEL.test(job.model)) throw Error('cursor requires a valid explicit model');
  if (typeof message !== 'string' || !message) throw Error('cursor requires a prompt message');
  // --sandbox disabled: cursor's own sandbox is itself seatbelt, and a nested sandbox_init inside
  // this profile fails, so every shell command would error. --force: without it print mode denies
  // non-allowlisted commands and the worker cannot run the project's tests. The outer profile is
  // the boundary, exactly as codex runs with --dangerously-bypass-approvals-and-sandbox inside it.
  return ['-p', '--output-format', 'json', '--model', job.model, '--trust', '--workspace', sandboxPath(worktree), '--sandbox', 'disabled', '--force', message];
}

// sandbox-exec argv. apiKey is used only to prove it is absent from every argument.
export function cursorLaunchArgs(job, { profile, bin, worktree, message, apiKey = null }) {
  const args = ['-f', sandboxPath(profile), sandboxPath(bin), ...cursorArgs(job, { worktree, message })];
  if (args.some(arg => CURSOR_FORBIDDEN_FLAGS.includes(arg) || arg.startsWith('--api-key='))) throw Error('cursor argv contains a forbidden flag');
  if (apiKey && args.some(arg => arg.includes(apiKey))) throw Object.assign(new Error('cursor-key-in-argv: refusing to launch cursor-agent with CURSOR_API_KEY in its arguments'), { code: 'cursor-key-in-argv' });
  return args;
}

// Allowlisted, unlike codexEnvironment's pass-through: no other provider key or token reaches the
// worker. CURSOR_API_ENDPOINT is deliberately not forwarded (it could redirect the key).
const CURSOR_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'TMPDIR', 'NO_COLOR', 'CI'];
export async function cursorEnvironment(env = process.env, exists = async file => fs.access(file).then(() => true, () => false)) {
  const clean = {};
  for (const key of CURSOR_ENV_KEYS) if (typeof env?.[key] === 'string' && !/[\0\r\n]/.test(env[key])) clean[key] = env[key];
  if (typeof env?.CURSOR_API_KEY === 'string' && env.CURSOR_API_KEY) clean.CURSOR_API_KEY = env.CURSOR_API_KEY;
  if (await exists('/etc/ssl/cert.pem')) clean.SSL_CERT_FILE = '/etc/ssl/cert.pem';
  return clean;
}

// Same prompt as a codex worker (ownership, design-only, contract, checks, gotchas); refuses a
// prompt that would carry the key.
export function cursorMessage(job, options = {}) {
  const message = codexMessage(job, options);
  if (options.apiKey && message.includes(options.apiKey)) throw Object.assign(new Error('cursor-key-in-prompt: refusing to send CURSOR_API_KEY in the worker prompt'), { code: 'cursor-key-in-prompt' });
  return message;
}

// `--output-format json` prints one result object: {type:"result",subtype,is_error,result,...}.
export function parseCursorOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  let found = null;
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try { const value = JSON.parse(text); if (value && value.type === 'result') found = value; } catch { /* not a result line */ }
  }
  if (!found) return null;
  const usage = found.usage && typeof found.usage === 'object' ? found.usage : null;
  return { response: typeof found.result === 'string' ? found.result : '', isError: found.is_error === true || (typeof found.subtype === 'string' && found.subtype !== 'success'), subtype: found.subtype ?? null, usage, raw: found };
}

// The codex envelope rule over cursor's final text, then the same outputs-only worktree fallback.
export async function resolveCursorEnvelope(stdout, worktree, job) {
  const parsed = parseCursorOutput(stdout);
  const reply = parseCodexReply(parsed?.response ?? '');
  if (reply) return { result: reply, response: parsed.response, fallback: null };
  const fromWorktree = await codexWorktreeFallback(worktree, job);
  if (fromWorktree) return { result: fromWorktree, response: parsed?.response ?? '', fallback: 'worktree' };
  return null;
}

export const redactCursorKey = (text, key) => (key && typeof text === 'string' ? text.split(key).join('[cursor-key-redacted]') : text);

export async function cursorDoctor({ platform = process.platform, exec = execViaFile, env = process.env } = {}) {
  if (platform !== 'darwin') return { agent: 'cursor', status: 'unsupported', platform, configured: false, liveVerified: false, note: 'macOS seatbelt is required' };
  const options = { timeout: 10000, maxBuffer: 1024 * 1024, env: Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key !== 'CURSOR_API_KEY')) };
  const { bin } = await resolveCursorBinary(env);
  await exec('/usr/bin/which', ['sandbox-exec'], { ...options, env: { ...options.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  const version = await exec(bin, ['--version'], options);
  const help = await exec(bin, ['--help'], options).catch(() => ({ stdout: '' }));
  if (!help.stdout) throw Error('Cursor help probe failed (no or empty output)');
  const missing = CURSOR_FLAGS.filter(flag => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=<]|$)`, 'm').test(help.stdout));
  if (missing.length) throw Error(`Cursor lacks required flags: ${missing.join(', ')}`);
  let auth = 'CURSOR_API_KEY set', status = 'compatible', note;
  try { requireCursorApiKey(env); } catch (error) { auth = 'missing'; status = 'not-authenticated'; note = error.message; }
  return { agent: 'cursor', status, platform, version: version.stdout.trim(), binary: bin, auth, ...(note ? { note } : {}), liveVerified: false };
}
