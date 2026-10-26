// SPDX-License-Identifier: Apache-2.0
// Re-run only failing gate-check tests with bounded, redacted output.
import { spawn as defaultSpawn } from 'node:child_process';

const MAX_FAILED = 50;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 65_536;
const KILL_AFTER_TERM_MS = 250;
const EXIT_DRAIN_MS = 50;

const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const SECRET_ENV_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PAT)(?:_|$)|(?:KEY|TOKEN|SECRET|PASSWORD|PAT)$/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const SK_RE = /sk-[A-Za-z0-9_-]{8,}/g;

function basename(cmd) {
  const part = String(cmd ?? '').split(/[/\\]/).pop() ?? '';
  return part.toLowerCase();
}

function detectKind(output) {
  const text = String(output ?? '');
  if (/^(?:FAILED|ERROR)\s+/m.test(text)) return 'pytest';
  if (/^\s*not ok \d+ - /m.test(text)) return 'node-test';
  return null;
}

function resolveKind(kind, output) {
  if (kind === 'pytest' || kind === 'node-test') return kind;
  if (kind === 'auto') return detectKind(output) ?? 'pytest';
  return 'pytest';
}

function parsePytestFailures(output) {
  const out = [];
  const seen = new Set();
  for (const line of String(output ?? '').split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('FAILED ') && !trimmed.startsWith('ERROR ')) continue;
    const dash = trimmed.indexOf(' - ');
    const id = (dash === -1 ? trimmed.replace(/^(FAILED|ERROR)\s+/, '') : trimmed.slice(0, dash).replace(/^(FAILED|ERROR)\s+/, '')).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
    if (out.length >= MAX_FAILED) break;
  }
  return out;
}

function fileFromLocationLine(line) {
  const location = /^\s*location:\s*(.+)$/i.exec(line)?.[1]?.trim();
  if (location) {
    const file = location.split(':')[0]?.trim();
    if (file) return file;
  }
  const testAt = /^\s*test at\s+(.+)$/i.exec(line)?.[1]?.trim();
  if (testAt) {
    const file = testAt.split(':')[0]?.trim();
    if (file) return file;
  }
  return undefined;
}

function parseNodeTestFailures(output) {
  const lines = String(output ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(lines[i]);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    let file;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      if (/^\s*not ok \d+ - /.test(lines[j])) break;
      const fromLine = fileFromLocationLine(lines[j]);
      if (fromLine) {
        file = fromLine;
        break;
      }
    }
    const id = file ? `${file}::${name}` : name;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, ...(file ? { file } : {}) });
    if (out.length >= MAX_FAILED) break;
  }
  return out;
}

export function parseFailedTests(output, kind = 'auto') {
  const resolved = resolveKind(kind, output);
  if (resolved === 'node-test') return parseNodeTestFailures(output);
  if (resolved === 'pytest') return parsePytestFailures(output);
  return [];
}

function normalizeFailed(failed) {
  if (!Array.isArray(failed)) return [];
  const out = [];
  for (const item of failed) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ id: item.trim(), name: item.trim() });
      continue;
    }
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) continue;
    const id = item.id.trim();
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    const file = typeof item.file === 'string' && item.file.trim() ? item.file.trim() : undefined;
    out.push({ id, name, ...(file ? { file } : {}) });
  }
  return out;
}

function findPytestIndex(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'pytest') return i;
    if ((argv[i] === 'python' || argv[i] === 'python3') && argv[i + 1] === '-m' && argv[i + 2] === 'pytest') return i + 2;
  }
  return -1;
}

function isUnsafeShellArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return true;
  const bin = basename(argv[0]);
  if (SHELL_BINS.has(bin)) return true;
  if (argv.includes('-c') && SHELL_BINS.has(bin)) return true;
  return false;
}

function isPytestTailArg(arg) {
  if (arg === '-q' || arg === '--quiet' || arg === '{affected}') return true;
  if (arg.startsWith('-')) return false;
  if (arg.includes('::')) return true;
  if (/\.py$/i.test(arg)) return true;
  if (arg.startsWith('./')) return true;
  if (arg.includes('/')) return true;
  return false;
}

function pytestIds(failed) {
  return [...new Set(normalizeFailed(failed).map(entry => entry.id))];
}

function buildPytestRerunArgv(argv, failed) {
  if (isUnsafeShellArgv(argv)) return null;
  const pytestAt = findPytestIndex(argv);
  if (pytestAt < 0) return null;
  const ids = pytestIds(failed);
  if (!ids.length) return null;
  const prefix = argv.slice(0, pytestAt + 1);
  const tail = argv.slice(pytestAt + 1).filter(arg => !isPytestTailArg(arg));
  return [...prefix, ...tail, '-rA', '-p', 'no:cacheprovider', ...ids];
}

function isNodeTestFileArg(arg) {
  if (arg === '{affected}') return true;
  if (arg.startsWith('-')) return false;
  if (/\.test\.(mjs|cjs|js|ts)$/i.test(arg)) return true;
  if (arg.startsWith('./tests/') || arg.startsWith('tests/')) return true;
  if (arg.startsWith('./') && arg.includes('.')) return true;
  return false;
}

function escapeRegExp(text) {
  return String(text).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function buildNodeTestRerunArgv(argv, failed) {
  if (isUnsafeShellArgv(argv)) return null;
  const testIndex = argv.indexOf('--test');
  if (testIndex < 0) return null;
  const entries = normalizeFailed(failed);
  if (!entries.length) return null;
  const names = [...new Set(entries.map(entry => entry.name))];
  const files = [...new Set([
    ...entries.map(entry => entry.file).filter(Boolean),
    ...argv.filter(isNodeTestFileArg),
  ])];
  if (!files.length) return null;
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (isNodeTestFileArg(arg)) continue;
    if (arg.startsWith('--test-name-pattern=')) continue;
    if (arg === '--test-name-pattern') {
      i += 1;
      continue;
    }
    kept.push(arg);
  }
  const patterns = names.map(name => `--test-name-pattern=${escapeRegExp(name)}`);
  return [...kept, ...patterns, ...files];
}

export function buildRerunArgv(argv, failed, kind = 'auto') {
  const list = normalizeFailed(failed);
  if (!list.length) return null;
  let resolved = kind;
  if (resolved === 'auto') {
    if (findPytestIndex(argv) >= 0) resolved = 'pytest';
    else if (argv.includes('--test')) resolved = 'node-test';
    else return null;
  }
  if (resolved === 'pytest') return buildPytestRerunArgv(argv, list);
  if (resolved === 'node-test') return buildNodeTestRerunArgv(argv, list);
  return null;
}

function redactEnvValues(text, env) {
  let out = String(text ?? '');
  const pairs = Object.entries(env ?? {})
    .filter(([key, value]) => typeof value === 'string' && value && SECRET_ENV_RE.test(key))
    .sort((a, b) => b[1].length - a[1].length);
  for (const [, value] of pairs) {
    out = out.split(value).join('[redacted]');
  }
  return out;
}

export function redactRerunTail(text, env) {
  let out = redactEnvValues(text, env);
  out = out.replace(BEARER_RE, 'Bearer [redacted]');
  out = out.replace(SK_RE, 'sk-[redacted]');
  return out;
}

function trimTail(stdout, stderr, maxBytes) {
  const combined = `${stdout ?? ''}${stderr ?? ''}`;
  if (combined.length <= maxBytes) return combined;
  return combined.slice(-maxBytes);
}

function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

export async function rerunFailed({
  argv,
  cwd,
  env = process.env,
  failed,
  kind = 'auto',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = defaultSpawn,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const rerunArgv = buildRerunArgv(argv, failed, kind);
  if (!rerunArgv) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      tail: '',
      argv: null,
    };
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(rerunArgv[0], rerunArgv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        tail: redactRerunTail(String(error?.message ?? error), env),
        argv: rerunArgv,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    let done = false;
    let killTimer = null;
    const keep = (current, chunk) => {
      const next = current + String(chunk);
      return next.length > maxBytes ? next.slice(-maxBytes) : next;
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const tail = redactRerunTail(trimTail(stdout, stderr, maxBytes), env);
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal,
        timedOut,
        tail,
        argv: rerunArgv,
      });
    };
    let drainTimer = null;
    child.stdout?.on('data', chunk => { stdout = keep(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = keep(stderr, chunk); });
    child.on('error', error => {
      stderr = keep(stderr, error?.message ?? error);
      finish();
    });
    child.on('exit', (code, sig) => {
      exitCode = code;
      signal = sig;
      killProcessGroup(child, 'SIGKILL');
      drainTimer = setTimeout(finish, EXIT_DRAIN_MS);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), KILL_AFTER_TERM_MS);
      drainTimer = setTimeout(finish, KILL_AFTER_TERM_MS + EXIT_DRAIN_MS + 50);
    }, timeoutMs);
  });
}
