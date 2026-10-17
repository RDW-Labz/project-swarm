import { spawn } from 'node:child_process';
import { findUnsafeText, redactText } from './lesson-schema.mjs';

const HOOK_KINDS = ['smoke', 'preview'];
const HOOK_KEYS = ['argv', 'timeoutSec', 'everyBatches'];
const SECRET_KEY_RE = /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE/i;
const ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TZ', 'CI', 'NODE_ENV', 'PORT', 'TMPDIR', 'SWARM_PORT_BASE', 'FORCE_COLOR', 'NO_COLOR']);
const PROGRAM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROD_PARTS = new Set(['--prod', '--production', 'prod', 'production', 'promote', '-p']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh']);
const PREVIEW_URL_RE = new RegExp('https://[A-Za-z0-9.-]+(?:/[A-Za-z0-9._~%/-]*)?', 'g');
const SPLIT_RE = new RegExp('[=:,\s]+');
const BACKSLASH = String.fromCharCode(92);
const DEFAULT_TIMEOUT_SEC = 600;
const TAIL_CHARS = 1500;
const OUTPUT_CAP = 65536;
const DRAIN_MS = 2000;
const KILL_MS = 2000;
const HARD_MS = 5000;
const WITHHELD = '[output withheld: it held private data]';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function hasControl(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function isRelPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes(BACKSLASH)
    && !/^[A-Za-z]:/.test(p) && !hasControl(p) && !p.split('/').includes('..');
}

function unknownKeysMessage(obj, keys, where) {
  const n = Object.keys(obj).filter((k) => !keys.includes(k)).length;
  return n ? `${n} unknown key${n === 1 ? '' : 's'} in ${where}` : null;
}

function checkArgv(argv, where, errors) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 20) {
    errors.push(`${where}.argv must be 1 to 20 items`);
    return;
  }
  if (!argv.every((a) => typeof a === 'string' && a.length > 0 && !hasControl(a))) {
    errors.push(`${where}.argv items must be non-empty strings`);
    return;
  }
  const first = argv[0];
  if (!(PROGRAM_RE.test(first) || isRelPath(first))) {
    errors.push(`${where}.argv[0] must be a program name or a relative path`);
  }
}

function checkHook(name, raw, errors) {
  if (!isObj(raw)) {
    errors.push(`ci.${name} must be an object`);
    return null;
  }
  const unknown = unknownKeysMessage(raw, HOOK_KEYS, `ci.${name}`);
  if (unknown) errors.push(unknown);
  checkArgv(raw.argv, `ci.${name}`, errors);
  const timeoutSec = raw.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 30 || timeoutSec > 1800) {
    errors.push(`ci.${name}.timeoutSec must be an integer 30 to 1800`);
  }
  const everyBatches = raw.everyBatches ?? 1;
  if (!Number.isInteger(everyBatches) || everyBatches < 1 || everyBatches > 50) {
    errors.push(`ci.${name}.everyBatches must be an integer 1 to 50`);
  }
  if (name === 'preview' && Array.isArray(raw.argv) && isProductionArgv(raw.argv)) {
    errors.push('ci.preview must not be a production command (previews only)');
  }
  return { argv: raw.argv, timeoutSec, everyBatches };
}

export function validateCiConfig(raw) {
  const errors = [];
  if (raw === undefined) return { config: {}, errors };
  if (!isObj(raw)) return { config: {}, errors: ['ci must be an object'] };
  const unknown = unknownKeysMessage(raw, HOOK_KINDS, 'ci');
  if (unknown) errors.push(unknown);
  const config = {};
  for (const kind of HOOK_KINDS) {
    if (raw[kind] === undefined) continue;
    const hook = checkHook(kind, raw[kind], errors);
    if (hook) config[kind] = hook;
  }
  if (errors.length) return { config: {}, errors };
  return { config, errors };
}

export function isProductionArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return true;
  if (!argv.every((item) => typeof item === 'string')) return true;
  const base = argv[0].toLowerCase().split('/').pop().split(BACKSLASH).pop();
  const program = base.endsWith('.exe') ? base.slice(0, -4) : base;
  if (SHELLS.has(program)) return true;
  return argv.some((item) => {
    const lower = item.toLowerCase();
    if (lower === '-c') return true;
    return lower.split(SPLIT_RE).some((part) => PROD_PARTS.has(part));
  });
}

export function shouldRun(everyBatches, batchNumber) {
  if (!Number.isInteger(everyBatches) || everyBatches < 1) return false;
  if (!Number.isInteger(batchNumber) || batchNumber < 1) return false;
  return batchNumber % everyBatches === 0;
}

export function extractPreviewUrl(text) {
  if (typeof text !== 'string') return null;
  let found = null;
  for (const m of text.matchAll(PREVIEW_URL_RE)) {
    const next = text.charAt(m.index + m[0].length);
    if (next === ':' || next === '@') continue;
    const url = m[0].replace(/[.-]+$/, '');
    const host = url.slice('https://'.length).split('/')[0];
    if (host.includes('.') && !host.includes('..')) found = url;
  }
  return found;
}

function safeTail(text) {
  let t = String(text ?? '');
  if (findUnsafeText(t).length > 0) t = redactText(t);
  if (findUnsafeText(t).length > 0) return WITHHELD;
  return t.slice(-TAIL_CHARS);
}

function filterEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string' || SECRET_KEY_RE.test(k)) continue;
    if (ENV_KEYS.has(k) || k.startsWith('LC_')) out[k] = v;
  }
  return out;
}

function defaultRun(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err.message), spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let code = null;
    let timedOut = false;
    let spawnError = false;
    let done = false;
    let timer = null;
    let killTimer = null;
    let drainTimer = null;
    let hardTimer = null;
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of [timer, killTimer, drainTimer, hardTimer]) clearTimeout(t);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, stdout, stderr, timedOut, spawnError });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-OUTPUT_CAP); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-OUTPUT_CAP); });
    child.on('error', (err) => {
      spawnError = true;
      stderr = (stderr + String(err.message)).slice(-OUTPUT_CAP);
      finish();
    });
    child.on('exit', (c) => {
      if (done) return;
      code = c;
      clearTimeout(timer);
      clearTimeout(killTimer);
      killGroup('SIGKILL');
      drainTimer = setTimeout(finish, DRAIN_MS);
    });
    child.on('close', (c) => {
      if (code === null) code = c;
      finish();
    });
    timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_MS);
      hardTimer = setTimeout(finish, HARD_MS);
    }, options.timeoutMs);
  });
}

export async function runHook(kind, hook, { cwd, env = process.env, run = defaultRun, timeoutMs } = {}) {
  const started = Date.now();
  const finish = (status, extra = {}) => ({
    kind, status, exitCode: null, durationMs: Date.now() - started, tail: '', ...extra
  });
  if (!HOOK_KINDS.includes(kind) || !isObj(hook)) {
    return finish('cannot-run', { tail: 'hook is not configured' });
  }
  const problems = [];
  checkArgv(hook.argv, `ci.${kind}`, problems);
  if (problems.length === 0 && kind === 'preview' && isProductionArgv(hook.argv)) {
    problems.push('preview must not be a production command');
  }
  if (problems.length) return finish('cannot-run', { tail: safeTail(`hook is invalid: ${problems[0]}`) });
  const seconds = Number.isInteger(hook.timeoutSec) ? hook.timeoutSec : DEFAULT_TIMEOUT_SEC;
  const timeout = timeoutMs ?? seconds * 1000;
  let guard = null;
  const deadline = new Promise((resolve) => {
    guard = setTimeout(() => resolve({ code: null, stdout: '', stderr: '', timedOut: true }), timeout + HARD_MS + 1000);
  });
  let res;
  try {
    res = await Promise.race([
      Promise.resolve().then(() => run(hook.argv[0], hook.argv.slice(1), { cwd, env: filterEnv(env), timeoutMs: timeout })),
      deadline
    ]);
  } catch (err) {
    return finish('cannot-run', { tail: safeTail(err && err.message ? err.message : 'run failed') });
  } finally {
    clearTimeout(guard);
  }
  const out = res && typeof res === 'object' ? res : {};
  const combined = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  let status;
  if (out.spawnError) status = 'cannot-run';
  else if (out.timedOut) status = 'timeout';
  else if (out.code === 0) status = 'passed';
  else status = 'failed';
  const result = finish(status, {
    exitCode: typeof out.code === 'number' ? out.code : null,
    tail: safeTail(combined)
  });
  if (kind === 'preview') {
    const url = status === 'passed' ? extractPreviewUrl(combined) : null;
    result.url = url && findUnsafeText(url).length === 0 ? url : null;
  }
  return result;
}

export function fixTicketFromFailure({ kind, batchNumber, files, tail, summary } = {}) {
  const label = String(kind ?? 'check');
  const title = `Fix ${label} failure after batch ${batchNumber}`.slice(0, 140);
  const context = (Array.isArray(files) ? files : []).filter(isRelPath).slice(0, 10);
  const notes = safeTail(summary || tail || '').slice(0, 600);
  return {
    title,
    type: 'build',
    stage: 'S0',
    epic: 'E-99 Continuous integration',
    scopeRefs: [],
    acceptance: [`The ${label} check passes again on the batch's files.`],
    files: context,
    context,
    contracts: [],
    dependsOn: [],
    size: 'M',
    risk: 'high',
    sensitive: true,
    status: 'todo',
    origin: 'ci',
    notes
  };
}
