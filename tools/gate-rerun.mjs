// SPDX-License-Identifier: Apache-2.0
// Re-run only failing gate-check tests with bounded, redacted output.
import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';

const MAX_FAILED = 50;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 65_536;
const KILL_AFTER_TERM_MS = 250;
const EXIT_DRAIN_MS = 50;

const SHELL_BINS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const SECRET_ENV_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PAT|AUTH|CREDENTIAL|PASSWD|PRIVATE|COOKIE|DSN)(?:_|$)|(?:KEY|TOKEN|SECRET|PASSWORD|PAT|AUTH|CREDENTIAL|PASSWD|PRIVATE|COOKIE|DSN)$/i;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_RE = /sk-[A-Za-z0-9_-]{8,}/g;
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]+/g;
const GITHUB_PAT_RE = /github_pat_[A-Za-z0-9_]+/g;
const XOX_RE = /xox[a-z]-[A-Za-z0-9-]+/gi;
const URL_CREDENTIALS_RE = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^\s/]+@[^\s/]+/gi;
const AKIA_RE = /AKIA[0-9A-Z]{16}/g;
const REDACT_MARGIN_BYTES = 4096;
const MIN_ENV_REDACT_LEN = 6;
const PYTEST_ID_RE = /^[\w./-]+\.py(?:::\S.*)?$/;
const SHORT_SUMMARY_HEADER_RE = /^={3,}\s*short test summary info\s*={3,}\s*$/i;

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

function isValidPytestId(id) {
  const s = String(id ?? '').trim();
  if (!s || s.startsWith('-')) return false;
  if (s.includes('..')) return false;
  if (path.isAbsolute(s)) return false;
  return PYTEST_ID_RE.test(s);
}

function shortTestSummaryLines(output) {
  const lines = String(output ?? '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SHORT_SUMMARY_HEADER_RE.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return [];
  const section = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^={3,}/.test(line)) break;
    section.push(line);
  }
  return section;
}

function parsePytestFailures(output) {
  const out = [];
  const seen = new Set();
  for (const line of shortTestSummaryLines(output)) {
    if (!line.startsWith('FAILED ') && !line.startsWith('ERROR ')) continue;
    const dash = line.indexOf(' - ');
    const id = (dash === -1 ? line.replace(/^(FAILED|ERROR)\s+/, '') : line.slice(0, dash).replace(/^(FAILED|ERROR)\s+/, '')).trim();
    if (!isValidPytestId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id });
    if (out.length >= MAX_FAILED) break;
  }
  return out;
}

function looksLikeTestFile(file) {
  if (!file || file.startsWith('-')) return false;
  return /\.test\.(mjs|cjs|js|ts)$/i.test(file);
}

function isSafeRelativeTestFile(file, cwd = process.cwd()) {
  if (!looksLikeTestFile(file)) return false;
  if (path.isAbsolute(file)) return false;
  if (file.includes('..')) return false;
  const resolved = path.resolve(cwd, file);
  const root = path.resolve(cwd);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(prefix);
}

function unescapeTapName(name) {
  return String(name ?? '').replace(/\\(.)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    return ch;
  });
}

function normalizeLocationPath(raw, cwd = process.cwd()) {
  let loc = String(raw ?? '').trim();
  if (
    (loc.startsWith("'") && loc.endsWith("'"))
    || (loc.startsWith('"') && loc.endsWith('"'))
  ) {
    loc = loc.slice(1, -1);
  }
  loc = loc.replace(/:\d+:\d+$/, '');
  if (path.isAbsolute(loc)) {
    const rel = path.relative(cwd, loc);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return rel;
  }
  return loc;
}

function fileFromLocationLine(line, cwd = process.cwd()) {
  const location = /^\s*location:\s*(.+)$/i.exec(line)?.[1]?.trim();
  if (location) {
    const file = normalizeLocationPath(location, cwd);
    if (file && isSafeRelativeTestFile(file, cwd)) return file;
  }
  const testAt = /^\s*test at\s+(.+)$/i.exec(line)?.[1]?.trim();
  if (testAt) {
    const file = normalizeLocationPath(testAt, cwd);
    if (file && isSafeRelativeTestFile(file, cwd)) return file;
  }
  return undefined;
}

function parseNodeTestFailures(output, cwd = process.cwd()) {
  const lines = String(output ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(lines[i]);
    if (!match) continue;
    const name = unescapeTapName(match[1].trim());
    if (!name) continue;
    let file;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      if (/^\s*not ok \d+ - /.test(lines[j])) break;
      const fromLine = fileFromLocationLine(lines[j], cwd);
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
  return false;
}

const PYTEST_OPT_CONSUMES_NEXT = new Set([
  '--basetemp',
  '--rootdir',
  '-c',
  '--confcutdir',
  '-p',
  '-o',
  '--junitxml',
  '--log-file',
  '--override-ini',
  '--pythonpath',
  '--config-file',
  '--import-mode',
  '-k',
  '-m',
  '--ignore',
  '--ignore-glob',
  '--deselect',
  '--cov',
  '--tb',
  '-n',
  '--maxfail',
  '--durations',
  '--log-level',
]);

function pytestOptConsumesNext(arg) {
  return PYTEST_OPT_CONSUMES_NEXT.has(arg);
}

function isPytestPositionalToDrop(arg) {
  if (arg === '-q' || arg === '--quiet' || arg === '{affected}') return true;
  if (arg.startsWith('-')) return false;
  if (arg.includes('::')) return true;
  if (/\.py$/i.test(arg)) return true;
  if (arg.startsWith('./')) return true;
  if (/^tests?(?:\/|$)/i.test(arg)) return true;
  if (arg.endsWith('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return true;
  return false;
}

function filterPytestArgvTail(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '-q' || arg === '--quiet') continue;
    if (pytestOptConsumesNext(arg)) {
      out.push(arg);
      if (i + 1 < argv.length) {
        out.push(argv[i + 1]);
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      out.push(arg);
      continue;
    }
    if (isPytestPositionalToDrop(arg)) continue;
    out.push(arg);
  }
  return out;
}

function pytestIds(failed) {
  return [...new Set(normalizeFailed(failed).map(entry => entry.id).filter(isValidPytestId))];
}

function buildPytestRerunArgv(argv, failed) {
  if (isUnsafeShellArgv(argv)) return null;
  const pytestAt = findPytestIndex(argv);
  if (pytestAt < 0) return null;
  const ids = pytestIds(failed);
  if (!ids.length) return null;
  const prefix = argv.slice(0, pytestAt + 1);
  const tail = filterPytestArgvTail(argv.slice(pytestAt + 1));
  return [...prefix, ...tail, '-rA', '-p', 'no:cacheprovider', '--', ...ids];
}

function isNodeTestFileArg(arg) {
  if (arg === '{affected}') return true;
  return looksLikeTestFile(arg);
}

const NODE_ARG_CONSUMES_NEXT = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--test-reporter',
  '--test-reporter-destination',
]);

function nodeArgConsumesNext(arg) {
  if (NODE_ARG_CONSUMES_NEXT.has(arg)) return true;
  if (arg === '--test-name-pattern') return true;
  return false;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNodeTestRerunArgv(argv, failed, cwd = process.cwd()) {
  if (isUnsafeShellArgv(argv)) return null;
  const testIndex = argv.indexOf('--test');
  if (testIndex < 0) return null;
  const entries = normalizeFailed(failed);
  if (!entries.length) return null;
  const names = [...new Set(entries.map(entry => entry.name))];
  const files = [...new Set([
    ...entries.map(entry => entry.file).filter(file => file && isSafeRelativeTestFile(file, cwd)),
    ...argv.filter(arg => isNodeTestFileArg(arg) && arg !== '{affected}' && isSafeRelativeTestFile(arg, cwd)),
  ])];
  if (!files.length) return null;
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '{affected}') continue;
    if (isNodeTestFileArg(arg)) continue;
    if (arg.startsWith('--test-name-pattern=')) continue;
    if (arg === '--test-name-pattern') {
      i += 1;
      continue;
    }
    kept.push(arg);
    if (nodeArgConsumesNext(arg) && i + 1 < argv.length) {
      kept.push(argv[i + 1]);
      i += 1;
    }
  }
  const patterns = names.map(name => `--test-name-pattern=^${escapeRegExp(name)}$`);
  return [...kept, ...patterns, ...files];
}

function resolveRerunKind(argv, kind) {
  if (kind === 'pytest' || kind === 'node-test') return kind;
  if (kind === 'auto') {
    if (findPytestIndex(argv) >= 0) return 'pytest';
    if (argv.includes('--test')) return 'node-test';
  }
  return null;
}

function nodeTestResultNames(output) {
  const names = [];
  for (const line of String(output ?? '').split('\n')) {
    const match = /^\s*(?:ok|not ok) \d+ - (.+?)(?:\s+#\s.*)?$/.exec(line);
    if (match) names.push(unescapeTapName(match[1].trim()));
  }
  return names;
}

function verifyRerunRanMatchingTests(output, failed, resolvedKind) {
  const entries = normalizeFailed(failed);
  if (!entries.length) {
    return { ran: false, reason: 'rerun ran no matching tests' };
  }
  const text = String(output ?? '');
  if (resolvedKind === 'node-test') {
    const testsMatch = /#\s*tests\s+(\d+)/.exec(text);
    const testCount = testsMatch ? Number(testsMatch[1]) : 0;
    if (!Number.isFinite(testCount) || testCount <= 0) {
      return { ran: false, reason: 'rerun ran no matching tests' };
    }
    const ranNames = new Set(nodeTestResultNames(text));
    const targets = [...new Set(entries.map(entry => entry.name))];
    for (const name of targets) {
      if (!ranNames.has(name)) {
        return { ran: false, reason: 'rerun ran no matching tests' };
      }
    }
    return { ran: true };
  }
  if (resolvedKind === 'pytest') {
    if (!/\d+\s+passed\b/i.test(text) && !/\d+\s+failed\b/i.test(text)) {
      return { ran: false, reason: 'rerun ran no matching tests' };
    }
    return { ran: true };
  }
  return { ran: true };
}

export function buildRerunArgv(argv, failed, kind = 'auto', cwd = process.cwd()) {
  const list = normalizeFailed(failed);
  if (!list.length) return null;
  let resolved = kind;
  if (resolved === 'auto') {
    if (findPytestIndex(argv) >= 0) resolved = 'pytest';
    else if (argv.includes('--test')) resolved = 'node-test';
    else return null;
  }
  if (resolved === 'pytest') return buildPytestRerunArgv(argv, list);
  if (resolved === 'node-test') return buildNodeTestRerunArgv(argv, list, cwd);
  return null;
}

function envValueLooksLikeUrlCredentials(value) {
  return /:\/\//.test(value) && /@[^@]+/.test(value) && /:[^@\s/]+@/.test(value);
}

function shouldRedactEnvPair(key, value) {
  if (typeof value !== 'string' || value.length < MIN_ENV_REDACT_LEN) return false;
  if (SECRET_ENV_RE.test(key)) return true;
  if (/URL/i.test(key) && envValueLooksLikeUrlCredentials(value)) return true;
  return false;
}

function redactEnvValues(text, env) {
  let out = String(text ?? '');
  const pairs = Object.entries(env ?? {})
    .filter(([key, value]) => shouldRedactEnvPair(key, value))
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
  out = out.replace(GH_TOKEN_RE, (m) => `${m.slice(0, 4)}[redacted]`);
  out = out.replace(GITHUB_PAT_RE, 'github_pat_[redacted]');
  out = out.replace(XOX_RE, (m) => `${m.slice(0, 3)}[redacted]`);
  out = out.replace(URL_CREDENTIALS_RE, (m) => {
    const credAt = m.lastIndexOf('@');
    const schemeSlash = m.indexOf('://');
    if (schemeSlash === -1 || credAt <= schemeSlash) return m;
    return `${m.slice(0, schemeSlash + 3)}[redacted]${m.slice(credAt)}`;
  });
  out = out.replace(AKIA_RE, 'AKIA[redacted]');
  return out;
}

function utf8TailBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let start = 0;
  let end = s.length;
  while (start < end) {
    const mid = Math.floor((start + end) / 2);
    const slice = s.slice(mid);
    if (Buffer.byteLength(slice, 'utf8') <= maxBytes) end = mid;
    else start = mid + 1;
  }
  return s.slice(start);
}

function utf8DropHeadBytes(text, dropBytes) {
  const s = String(text ?? '');
  if (dropBytes <= 0) return s;
  if (Buffer.byteLength(s, 'utf8') <= dropBytes) return '';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const head = s.slice(0, mid);
    if (Buffer.byteLength(head, 'utf8') <= dropBytes) lo = mid + 1;
    else hi = mid;
  }
  return s.slice(lo);
}

export function dropTruncatedStreamHeadAfterRedaction(text, truncated) {
  if (!truncated) return String(text ?? '');
  const s = String(text ?? '');
  const totalBytes = Buffer.byteLength(s, 'utf8');
  const newlineIdx = s.indexOf('\n');
  if (totalBytes <= REDACT_MARGIN_BYTES) {
    if (newlineIdx >= 0) return s.slice(newlineIdx + 1);
    return '';
  }
  let dropBytes = REDACT_MARGIN_BYTES;
  if (newlineIdx >= 0) {
    dropBytes = Math.max(dropBytes, Buffer.byteLength(s.slice(0, newlineIdx + 1), 'utf8'));
  }
  return utf8DropHeadBytes(s, Math.min(dropBytes, totalBytes));
}

function trimTail(stdout, stderr, maxBytes) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  const total = Buffer.byteLength(out, 'utf8') + Buffer.byteLength(err, 'utf8');
  if (total <= maxBytes) return out + err;
  const minEach = Math.floor(maxBytes / 4);
  const outBytes = Buffer.byteLength(out, 'utf8');
  const errBytes = Buffer.byteLength(err, 'utf8');
  let outBudget = Math.max(minEach, Math.floor((maxBytes * outBytes) / total));
  let errBudget = Math.max(minEach, maxBytes - outBudget);
  if (outBudget + errBudget > maxBytes) {
    const excess = outBudget + errBudget - maxBytes;
    if (outBudget >= errBudget) outBudget -= excess;
    else errBudget -= excess;
  }
  let combined = utf8TailBytes(out, outBudget) + utf8TailBytes(err, errBudget);
  if (Buffer.byteLength(combined, 'utf8') > maxBytes) {
    combined = utf8TailBytes(combined, maxBytes);
  }
  return combined;
}

function defaultKill(pid, signal) {
  process.kill(pid, signal);
}

function killProcessGroup(child, signal, killImpl = defaultKill) {
  if (Number.isInteger(child.pid) && child.pid > 1) {
    try {
      killImpl(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') console.error('[tools/gate-rerun.mjs] killProcessGroup process group:', error?.message ?? error);
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') console.error('[tools/gate-rerun.mjs] killProcessGroup child.kill:', error?.message ?? error);
  }
}

function appendStreamTail(state, chunk, maxBytes) {
  const prev = typeof state === 'string' ? { text: state, truncated: false } : state;
  const next = prev.text + String(chunk);
  const truncated = prev.truncated || Buffer.byteLength(next, 'utf8') > maxBytes;
  return { text: utf8TailBytes(next, maxBytes), truncated };
}

export async function rerunFailed({
  argv,
  cwd,
  env = process.env,
  failed,
  kind = 'auto',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = defaultSpawn,
  killImpl = defaultKill,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const rerunArgv = buildRerunArgv(argv, failed, kind, cwd ?? process.cwd());
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
    let stdout = { text: '', truncated: false };
    let stderr = { text: '', truncated: false };
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    let done = false;
    let timeoutTimer = null;
    let killTimer = null;
    let drainTimer = null;
    const streamCaptureMax = maxBytes;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const outText = stdout.text;
      const errText = stderr.text;
      const full = `${outText}${errText}`;
      const redactedOut = dropTruncatedStreamHeadAfterRedaction(
        redactRerunTail(outText, env),
        stdout.truncated,
      );
      const redactedErr = dropTruncatedStreamHeadAfterRedaction(
        redactRerunTail(errText, env),
        stderr.truncated,
      );
      const outLen = Buffer.byteLength(redactedOut, 'utf8');
      const errLen = Buffer.byteLength(redactedErr, 'utf8');
      let tail;
      if (outLen + errLen === 0) {
        tail = '';
      } else if (outLen + errLen <= maxBytes) {
        tail = redactedOut + redactedErr;
      } else if (errLen === 0) {
        tail = utf8TailBytes(redactedOut, maxBytes);
      } else if (outLen === 0) {
        tail = utf8TailBytes(redactedErr, maxBytes);
      } else {
        tail = trimTail(redactedOut, redactedErr, maxBytes);
      }
      let ok = exitCode === 0 && !timedOut;
      let reason;
      if (!timedOut) {
        const resolvedKind = resolveRerunKind(rerunArgv, kind);
        const check = verifyRerunRanMatchingTests(full, failed, resolvedKind);
        if (!check.ran) {
          ok = false;
          reason = check.reason;
        }
      }
      resolve({
        ok,
        exitCode,
        signal,
        timedOut,
        tail,
        argv: rerunArgv,
        ...(reason ? { reason } : {}),
      });
    };
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM', killImpl);
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL', killImpl), KILL_AFTER_TERM_MS);
      drainTimer = setTimeout(finish, KILL_AFTER_TERM_MS + EXIT_DRAIN_MS + 50);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout = appendStreamTail(stdout, chunk, streamCaptureMax); });
    child.stderr?.on('data', chunk => { stderr = appendStreamTail(stderr, chunk, streamCaptureMax); });
    child.on('error', error => {
      stderr = appendStreamTail(stderr, error?.message ?? error, streamCaptureMax);
      finish();
    });
    child.on('exit', (code, sig) => {
      exitCode = code;
      signal = sig;
      killProcessGroup(child, 'SIGKILL', killImpl);
      drainTimer = setTimeout(finish, EXIT_DRAIN_MS);
    });
  });
}
