// SPDX-License-Identifier: Apache-2.0
// After `swarm update`, restart board and remote-serve processes that still run an older version.
import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { boardFile, safeEnvSubset, serverMode } from './watch-cli.mjs';
import { discoverRunningServers } from './server-discovery.mjs';

export { safeEnvSubset, serverMode };
export {
  discoverRunningServers,
  listenPortsForPid,
  parseLsofFnOutput,
  parseLsofListenPorts,
  parseReadlinkSocketInode,
  parseProcNetTcpListenRow,
  parseProcNetTcpListenInodes,
  listenPortsMatchingProcInodes,
} from './server-discovery.mjs';

const execFileAsync = promisify(execFile);

export const remoteServerFile = (env = process.env, home = os.homedir()) => {
  const board = boardFile(env, home);
  return env.SWARM_REMOTE_SERVER_FILE || path.join(path.dirname(board), 'remote-server.json');
};

export function pidProbe(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'EPERM') return 'denied';
    return 'dead';
  }
}

export function pidAlive(pid) {
  return pidProbe(pid) === 'alive';
}

export function validServerPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export async function writeRegistryRecord(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, file);
}

export async function removeRegistryRecord(file, { pid, url } = {}) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (pid !== undefined && data.pid !== pid) return;
    if (url !== undefined && data.url !== url) return;
    await fs.rm(file, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        console.error('[tools/server-restart.mjs] corrupt registry (SyntaxError)');
      } else {
        console.error('[tools/server-restart.mjs] removeRegistryRecord:', error?.code ?? error?.name ?? 'unknown');
      }
    }
  }
}

export async function removeRegistryRecordIfUnchanged(file, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.pid !== snapshot.pid) return false;
    if (snapshot.startedAt !== undefined && data.startedAt !== snapshot.startedAt) return false;
    if (snapshot.url !== undefined && data.url !== snapshot.url) return false;
    if (snapshot.version !== undefined && data.version !== snapshot.version) return false;
    await fs.rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function manualCommand({ runner, argv, cwd, env }) {
  const restartArgv = argvWithoutOpen(argv);
  const parts = [shellQuote(process.execPath), shellQuote(runner), ...restartArgv.map(a => shellQuote(a))];
  const prefix = cwd && cwd !== process.cwd() ? `cd ${shellQuote(cwd)} && ` : '';
  const envKeys = Object.keys(env ?? {});
  const envPrefix = envKeys.length
    ? `${envKeys.map(k => `export ${k}`).join('; ')}; `
    : '';
  return `${prefix}${envPrefix}${parts.join(' ')}`;
}

export function argvWithoutOpen(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter(arg => arg !== '--open');
}

function parseRecord(text, kind) {
  let data;
  try { data = JSON.parse(text); } catch { return { error: `could not parse ${kind} server record` }; }
  if (!data || typeof data !== 'object') return { error: `could not parse ${kind} server record` };
  if (!Number.isInteger(data.pid) || data.pid <= 0) return { error: `invalid pid in ${kind} server record` };
  const version = (typeof data.version === 'string' && data.version) ? data.version : null;
  if (!Array.isArray(data.argv) || !data.argv.every(a => typeof a === 'string')) return { error: `invalid argv in ${kind} server record` };
  if (typeof data.cwd !== 'string' || !data.cwd) return { error: `missing cwd in ${kind} server record` };
  if (!Number.isInteger(data.port)) return { error: `missing port in ${kind} server record` };
  if (data.mode !== 'terminal' && data.mode !== 'background') return { error: `invalid mode in ${kind} server record` };
  const env = data.env && typeof data.env === 'object' && !Array.isArray(data.env)
    ? safeEnvSubset(data.env)
    : {};
  return { record: { ...data, version, env, kind } };
}

async function readKind(file, kind) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = parseRecord(text, kind);
    if (parsed.error) return { kind, file, ...parsed };
    return { kind, file, record: parsed.record };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { kind, file, readError: true };
  }
}

export function registryEnv(env = process.env, home = os.homedir()) {
  const h = home ?? env.HOME ?? os.homedir();
  const out = { HOME: h, PATH: env.PATH ?? process.env.PATH ?? '' };
  if (typeof env.SWARM_BOARD_FILE === 'string' && env.SWARM_BOARD_FILE) {
    out.SWARM_BOARD_FILE = env.SWARM_BOARD_FILE;
  }
  if (typeof env.SWARM_REMOTE_SERVER_FILE === 'string' && env.SWARM_REMOTE_SERVER_FILE) {
    out.SWARM_REMOTE_SERVER_FILE = env.SWARM_REMOTE_SERVER_FILE;
  }
  return out;
}

export function expectedSubcommandForRecord(record) {
  if (record.kind === 'remote') return { tokens: ['remote', 'serve'] };
  return { tokens: ['watch'] };
}

function tokenizeCommandLine(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) break;
    const quote = line[i];
    if (quote === '\'' || quote === '"') {
      i += 1;
      let word = '';
      while (i < line.length && line[i] !== quote) {
        if (quote === '\'' && line[i] === '\\' && i + 1 < line.length) {
          word += line[i + 1];
          i += 2;
          continue;
        }
        word += line[i];
        i += 1;
      }
      if (line[i] === quote) i += 1;
      tokens.push(word);
      continue;
    }
    const start = i;
    while (i < line.length && !/\s/.test(line[i])) i += 1;
    tokens.push(line.slice(start, i));
  }
  return tokens;
}

/** Tokenize ps -o args= output; paths that exist on disk stay one token even with spaces. */
export function tokenizePsArgs(line) {
  const raw = String(line).trim();
  if (!raw) return [];
  const tokens = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (i >= raw.length) break;
    if (raw[i] === '\'' || raw[i] === '"') {
      const quote = raw[i];
      i += 1;
      let word = '';
      while (i < raw.length && raw[i] !== quote) {
        word += raw[i];
        i += 1;
      }
      if (raw[i] === quote) i += 1;
      tokens.push(word);
      continue;
    }
    let end = raw.length;
    for (let j = i; j < raw.length; j += 1) {
      if (/\s/.test(raw[j])) {
        end = j;
        break;
      }
    }
    let candidate = raw.slice(i, end);
    let sliceEnd = end;
    while (sliceEnd < raw.length) {
      const nextSpace = raw.indexOf(' ', sliceEnd + 1);
      const tryEnd = nextSpace === -1 ? raw.length : nextSpace;
      if (tryEnd <= sliceEnd) break;
      const tryPath = raw.slice(i, tryEnd);
      if (!existsSync(tryPath)) break;
      candidate = tryPath;
      sliceEnd = tryEnd;
    }
    tokens.push(candidate);
    i += candidate.length;
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
  }
  return tokens;
}

function resolvePathReal(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  try { return realpathSync(candidate); } catch {
    try { return path.resolve(candidate); } catch { return null; }
  }
}

export function installRunnerCandidates(installRoot) {
  if (!installRoot || typeof installRoot !== 'string') return [];
  const out = [];
  out.push(path.join(installRoot, 'current', 'tools', 'swarm.mjs'));
  const versionsDir = path.join(installRoot, 'versions');
  try {
    for (const name of readdirSync(versionsDir)) {
      out.push(path.join(versionsDir, name, 'tools', 'swarm.mjs'));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('[tools/server-restart.mjs] versions dir:', error?.code ?? 'unknown');
    }
  }
  return out;
}

export function resolvedRunnerPathsForRecord(record, { installRoot, fallbackRunner } = {}) {
  const seen = new Set();
  const paths = [];
  const add = candidate => {
    if (!candidate || typeof candidate !== 'string') return;
    const resolved = resolvePathReal(candidate);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    paths.push(resolved);
  };
  if (typeof record?.runnerRealpath === 'string') add(record.runnerRealpath);
  if (typeof record?.runner === 'string') add(record.runner);
  if (fallbackRunner) add(fallbackRunner);
  for (const candidate of installRunnerCandidates(installRoot)) add(candidate);
  return paths;
}

export function commandLineMatchesRecord(commandLine, record, runnerPathOrOpts) {
  if (!commandLine || typeof commandLine !== 'string' || !record) return false;
  const opts = typeof runnerPathOrOpts === 'string'
    ? { fallbackRunner: runnerPathOrOpts }
    : (runnerPathOrOpts ?? {});
  const { installRoot, fallbackRunner, tokenize = tokenizePsArgs } = opts;
  const accepted = resolvedRunnerPathsForRecord(record, { installRoot, fallbackRunner });
  if (!accepted.length) return false;
  const tokenizers = tokenize === tokenizePsArgs ? [tokenizePsArgs, tokenizeCommandLine] : [tokenize];
  for (const tokenizer of tokenizers) {
    const tokens = tokenizer(commandLine.trim());
    if (!tokens.length) continue;
    const hasRunner = tokens.some(token => {
      const resolved = resolvePathReal(token);
      return resolved !== null && accepted.includes(resolved);
    });
    if (!hasRunner) continue;
    const { tokens: subcommand } = expectedSubcommandForRecord(record);
    let argvOk = true;
    for (const token of subcommand) {
      if (!tokens.includes(token)) argvOk = false;
    }
    if (!argvOk) continue;
    for (const arg of argvWithoutOpen(record.argv ?? [])) {
      if (!tokens.includes(arg)) argvOk = false;
    }
    if (argvOk) return true;
  }
  return false;
}

function looksLikePsCommandLine(line) {
  const raw = String(line).trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return false;
  if (parsePsEtime(raw) !== null && !raw.includes('/') && !raw.includes('\\') && !/\bnode\b/i.test(raw)) {
    return false;
  }
  if (!raw.includes('/') && !raw.includes('\\') && !/\bnode\b/i.test(raw)) return false;
  return true;
}

export function parsePsEtime(etimeStr) {
  const raw = String(etimeStr).trim();
  if (!raw) return null;
  let days = 0;
  let timePart = raw;
  if (raw.includes('-')) {
    const [dayText, rest] = raw.split('-', 2);
    days = Number(dayText);
    timePart = rest ?? '';
    if (!Number.isFinite(days) || days < 0) return null;
  }
  const parts = timePart.split(':').map(part => Number(part));
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return null;
  let seconds = 0;
  if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;
  return seconds + days * 86_400;
}

export async function readProcessIdentity(pid, { execFileImpl = execFileAsync, now = Date.now } = {}) {
  let command;
  try {
    const { stdout: argsOut } = await execFileImpl('ps', ['-o', 'args=', '-p', String(pid)]);
    const argsLine = String(argsOut).trim();
    // Some test mocks return etime text for every non-command ps field; ignore that shape here.
    if (argsLine && looksLikePsCommandLine(argsLine)) command = argsLine;
  } catch { /* fall through */ }
  if (!command) {
    try {
      const { stdout: commandOut } = await execFileImpl('ps', ['-o', 'command=', '-p', String(pid)]);
      command = String(commandOut).trim();
    } catch {
      return null;
    }
  }
  if (!command) return null;

  let startedAt = null;
  try {
    const { stdout: etimeOut } = await execFileImpl('ps', ['-o', 'etime=', '-p', String(pid)]);
    let elapsedSec = parsePsEtime(etimeOut);
    if (elapsedSec === null) {
      const asNumber = Number(String(etimeOut).trim());
      if (Number.isFinite(asNumber) && asNumber >= 0) elapsedSec = asNumber;
    }
    if (elapsedSec !== null) startedAt = now() - elapsedSec * 1000;
  } catch { /* start time unknown */ }

  if (startedAt === null) {
    try {
      const { stdout: lstartOut } = await execFileImpl('ps', ['-o', 'lstart=', '-p', String(pid)]);
      const parsed = Date.parse(String(lstartOut).trim());
      if (Number.isFinite(parsed)) startedAt = parsed;
    } catch { /* start time unknown */ }
  }

  return { command, startedAt };
}

export function identityMismatchRemovesRecord(reason) {
  return reason === 'process start time is newer than the server record';
}

export function defaultLaunchdBoardPlistPath(home = os.homedir()) {
  return path.join(home, 'Library', 'LaunchAgents', 'com.project-swarm.board.plist');
}

function restartHintCommand(tokens) {
  return tokens.map(shellQuote).join(' ');
}

export function restartHintContextLine(pid, port) {
  return `# pid ${pid}, port ${port}`;
}

export function identityUnverifiedRestartHint(kind, record, { launchdBoardPlistExists, getuid } = {}) {
  if (kind === 'remote') {
    return `${restartHintCommand(['swarm', 'remote', 'off'])} && ${restartHintCommand(['swarm', 'remote', 'on'])}`;
  }
  if (kind === 'board') {
    const hasLaunchd = launchdBoardPlistExists
      ? launchdBoardPlistExists()
      : existsSync(defaultLaunchdBoardPlistPath());
    if (hasLaunchd) {
      const uid = typeof getuid === 'function' ? getuid() : process.getuid();
      const target = `gui/${uid}/com.project-swarm.board`;
      return restartHintCommand(['launchctl', 'kickstart', '-k', target]);
    }
    return restartHintCommand(['swarm', 'watch', '--all', '--keep-up']);
  }
  const manual = record.argv?.length
    ? restartHintCommand(['swarm', ...record.argv])
    : restartHintCommand(['swarm']);
  return manual;
}

function emitIdentityUnverifiedRestart(emit, { label, record, kind, reasonSuffix, launchdBoardPlistExists, getuid }) {
  const restartHint = identityUnverifiedRestartHint(kind, record, { launchdBoardPlistExists, getuid });
  emit(`${label} server record (pid ${record.pid}): ${reasonSuffix}`);
  emit('restart to pick up the update:');
  emit(restartHintContextLine(record.pid, record.port));
  emit(restartHint);
  return restartHint;
}

export async function verifyRegistryPid(record, runnerPath, { execFileImpl = execFileAsync, installRoot } = {}) {
  const identity = await readProcessIdentity(record.pid, { execFileImpl });
  if (!identity) return { ok: false, reason: 'could not read process command line', removeRecord: false };
  if (!commandLineMatchesRecord(identity.command, record, { installRoot, fallbackRunner: runnerPath })) {
    return { ok: false, reason: 'process command line does not match server record', removeRecord: false };
  }
  if (identity.startedAt === null) {
    return { ok: false, reason: 'could not read process start time', removeRecord: false };
  }
  const recordStart = Date.parse(record.startedAt);
  if (Number.isFinite(recordStart) && identity.startedAt > recordStart + 5000) {
    return { ok: false, reason: 'process start time is newer than the server record', removeRecord: true };
  }
  return { ok: true, identity };
}

export function isAutoRestartable(record) {
  if (record.mode === 'terminal') return false;
  if (record.mode !== 'background') return false;
  if (record.explicitBackground === false) return false;
  if (record.explicitBackground === true || record.modeFromTty === true) return true;
  return record.explicitBackground === undefined && record.modeFromTty === undefined;
}

export async function resolveRunnerForRestart(installRoot, targetVersion) {
  const current = path.join(installRoot, 'current', 'tools', 'swarm.mjs');
  try {
    await fs.access(current);
    return { runner: current, source: 'current' };
  } catch { /* fall through */ }
  if (typeof targetVersion === 'string' && targetVersion) {
    const versioned = path.join(installRoot, 'versions', targetVersion, 'tools', 'swarm.mjs');
    try {
      await fs.access(versioned);
      return { runner: versioned, source: 'versions' };
    } catch { /* fall through */ }
  }
  return { runner: null, source: null };
}

async function waitForExit(pid, timeoutMs, sleep = ms => new Promise(r => setTimeout(r, ms)), isAlive = pidAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

async function waitForPortFree(port, timeoutMs, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await new Promise(resolve => {
      const s = net.createServer();
      s.once('error', () => resolve(true));
      s.listen(port, '127.0.0.1', () => { s.close(() => resolve(false)); });
    });
    if (!busy) return true;
    await sleep(100);
  }
  return false;
}

function healthUrl(record) {
  return `http://127.0.0.1:${record.port}/api/health`;
}

async function fetchHealth(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout?.(2000),
      headers: { Host: new URL(url).host },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.version !== 'string') return null;
    return body;
  } catch { return null; }
}

async function pollNewVersion(record, targetVersion, { timeoutMs = 20000, pollMs = 250, sleep, fetchImpl } = {}) {
  const url = healthUrl(record);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await fetchHealth(url, fetchImpl);
    if (body?.version === targetVersion) return { ok: true, pid: body.pid ?? null };
    await (sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(pollMs);
  }
  return { ok: false };
}

async function pollRemoteFile(file, targetVersion, { timeoutMs = 20000, pollMs = 250, sleep, pidAliveImpl = pidAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version === targetVersion && pidAliveImpl(data.pid)) return { ok: true, pid: data.pid };
    } catch { /* not ready */ }
    await (sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(pollMs);
  }
  return { ok: false };
}

async function pollBoardRecord(file, targetVersion, { timeoutMs = 20000, pollMs = 250, sleep, fetchImpl, pidAliveImpl = pidAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      const port = data?.port;
      if (data?.version === targetVersion && pidAliveImpl(data.pid) && validServerPort(port)) {
        const body = await fetchHealth(`http://127.0.0.1:${port}/api/health`, fetchImpl);
        if (body?.version === targetVersion) {
          return { ok: true, pid: data.pid, port };
        }
      }
    } catch { /* not ready */ }
    await (sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(pollMs);
  }
  return { ok: false };
}

async function assertStartable({ runner, cwd, argv }) {
  if (!runner || typeof runner !== 'string') return { ok: false, reason: 'runner missing' };
  try {
    await fs.access(runner);
  } catch {
    return { ok: false, reason: `runner missing at ${runner}` };
  }
  if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) {
    return { ok: false, reason: 'invalid argv in server record' };
  }
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) return { ok: false, reason: `cwd is not a directory: ${cwd}` };
  } catch {
    return { ok: false, reason: `cwd missing: ${cwd}` };
  }
  return { ok: true };
}

const RESTART_LOCK_BASENAME = '.server-restart.lock';

export const STALE_LOCK_MAX_AGE_MS = 60_000;
export const LOCK_REFRESH_INTERVAL_MS = 5_000;

export function formatProcessLockPayload(pid = process.pid, ownerStartedAt = new Date().toISOString(), refreshedAt = ownerStartedAt) {
  const owner = typeof ownerStartedAt === 'string' ? ownerStartedAt : new Date(ownerStartedAt).toISOString();
  const refreshed = typeof refreshedAt === 'string' ? refreshedAt : new Date(refreshedAt).toISOString();
  return `${pid}\n${owner}\n${refreshed}\n`;
}

export function parseProcessLockPayload(text) {
  const lines = String(text).trim().split('\n');
  const pid = Number(lines[0]);
  const ownerStartedAt = lines[1] ? Date.parse(lines[1]) : NaN;
  const refreshedAt = lines[2] ? Date.parse(lines[2]) : ownerStartedAt;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    ownerStartedAt: Number.isFinite(ownerStartedAt) ? ownerStartedAt : null,
    refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : null,
    createdAt: Number.isFinite(refreshedAt) ? refreshedAt : (Number.isFinite(ownerStartedAt) ? ownerStartedAt : null),
  };
}

export function lockOwnerIdentity(payload) {
  if (!payload || payload.pid === null) return null;
  return { pid: payload.pid, ownerStartedAt: payload.ownerStartedAt };
}

export function lockOwnerIdentityEqual(a, b) {
  if (!a || !b) return false;
  return a.pid === b.pid && a.ownerStartedAt === b.ownerStartedAt;
}

export async function processStartMatchesLockOwner(pid, ownerStartedAt, { execFileImpl = execFileAsync } = {}) {
  if (ownerStartedAt === null || ownerStartedAt === undefined) return false;
  const identity = await readProcessIdentity(pid, { execFileImpl });
  if (!identity || identity.startedAt === null) return false;
  return Math.abs(identity.startedAt - ownerStartedAt) <= 5000;
}

export async function isProcessLockStale(lockPath, {
  isAlive = pidAlive,
  now = Date.now,
  maxAgeMs = STALE_LOCK_MAX_AGE_MS,
  execFileImpl = execFileAsync,
} = {}) {
  try {
    const text = await fs.readFile(lockPath, 'utf8');
    const payload = parseProcessLockPayload(text);
    const { pid, ownerStartedAt, refreshedAt } = payload;
    if (pid !== null && !isAlive(pid)) return true;
    if (pid !== null && isAlive(pid)) {
      if (await processStartMatchesLockOwner(pid, ownerStartedAt, { execFileImpl })) return false;
    }
    const ageAnchor = refreshedAt ?? ownerStartedAt;
    if (ageAnchor !== null) return now() - ageAnchor > maxAgeMs;
    const stat = await fs.stat(lockPath);
    return now() - stat.mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

export async function stealProcessLockIfStale(lockPath, opts = {}) {
  const renameImpl = opts.renameImpl ?? ((from, to) => fs.rename(from, to));
  let snapshotText;
  try {
    snapshotText = await fs.readFile(lockPath, 'utf8');
  } catch {
    return false;
  }
  const snapshotOwner = lockOwnerIdentity(parseProcessLockPayload(snapshotText));
  if (!(await isProcessLockStale(lockPath, opts))) return false;
  try {
    const stolen = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
    await renameImpl(lockPath, stolen);
    try {
      const afterText = await fs.readFile(lockPath, 'utf8');
      const recreatedOwner = lockOwnerIdentity(parseProcessLockPayload(afterText));
      if (!lockOwnerIdentityEqual(snapshotOwner, recreatedOwner)) {
        await fs.rm(stolen, { force: true });
        return false;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof SyntaxError) {
          console.error('[tools/server-restart.mjs] corrupt lock (SyntaxError)');
        } else {
          console.error('[tools/server-restart.mjs] stale lock re-read:', error?.code ?? error?.name ?? 'unknown');
        }
      }
    }
    await fs.rm(stolen, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function releaseProcessLock(lockPath, { pid = process.pid, clearRefreshTimer } = {}) {
  if (typeof clearRefreshTimer === 'function') clearRefreshTimer();
  try {
    const text = await fs.readFile(lockPath, 'utf8');
    const { pid: owner } = parseProcessLockPayload(text);
    if (owner === pid) await fs.rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        console.error('[tools/server-restart.mjs] corrupt lock (SyntaxError)');
      } else {
        console.error('[tools/server-restart.mjs] releaseProcessLock:', error?.code ?? error?.name ?? 'unknown');
      }
    }
  }
}

async function refreshProcessLockFile(lockPath, ownerIdentity) {
  const refreshedAt = new Date().toISOString();
  const payload = formatProcessLockPayload(
    ownerIdentity.pid,
    new Date(ownerIdentity.ownerStartedAt).toISOString(),
    refreshedAt,
  );
  await fs.writeFile(lockPath, payload, { mode: 0o600 });
}

export function startProcessLockRefresh(lockPath, ownerIdentity, {
  intervalMs = LOCK_REFRESH_INTERVAL_MS,
  refresh = refreshProcessLockFile,
} = {}) {
  if (!ownerIdentity?.pid) return () => {};
  const timer = setInterval(() => {
    void refresh(lockPath, ownerIdentity).catch(error => {
      if (error?.code !== 'ENOENT') {
        console.error('[tools/server-restart.mjs] lock refresh:', error?.code ?? error?.name ?? 'unknown');
      }
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function withProcessLock(lockPath, fn, {
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  timeoutMs = 60_000,
  openFlags = 'wx',
  isAlive = pidAlive,
  maxAgeMs = STALE_LOCK_MAX_AGE_MS,
  execFileImpl = execFileAsync,
} = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(error => {
    console.error('[tools/server-restart.mjs] process lock dir:', error?.code ?? error?.name ?? 'unknown');
  });
  const deadline = Date.now() + timeoutMs;
  let handle = null;
  let ownerIdentity = null;
  let clearRefreshTimer = () => {};
  const identity = await readProcessIdentity(process.pid, { execFileImpl });
  const ownerStartedAt = identity?.startedAt ?? Date.now();
  while (Date.now() < deadline) {
    try {
      handle = await fs.open(lockPath, openFlags, 0o600);
      const nowIso = new Date().toISOString();
      ownerIdentity = { pid: process.pid, ownerStartedAt };
      await handle.writeFile(formatProcessLockPayload(process.pid, ownerStartedAt, nowIso));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await stealProcessLockIfStale(lockPath, { isAlive, maxAgeMs, execFileImpl });
      await sleep(50);
    }
  }
  if (!handle) throw Object.assign(new Error('process-lock-timeout'), { code: 'EBUSY' });
  clearRefreshTimer = startProcessLockRefresh(lockPath, ownerIdentity);
  try {
    return await fn();
  } finally {
    clearRefreshTimer();
    await handle.close().catch(() => {});
    await releaseProcessLock(lockPath, { clearRefreshTimer: () => {} });
  }
}

async function withRestartLock(installRoot, fn, { sleep = ms => new Promise(r => setTimeout(r, ms)), lockTimeoutMs = 60_000 } = {}) {
  const lockPath = path.join(installRoot, RESTART_LOCK_BASENAME);
  try {
    const result = await withProcessLock(lockPath, fn, { sleep, timeoutMs: lockTimeoutMs });
    return { ok: true, result };
  } catch (error) {
    if (error?.code === 'EBUSY') return { ok: false, reason: 'another server restart is already in progress' };
    throw error;
  }
}

function restartLogPath(installRoot, kind, pid) {
  return path.join(installRoot, 'state', 'logs', `${kind}-${pid}.log`);
}

function spawnDetached(runner, argv, { cwd, env, spawnImpl = spawn, installRoot, kind = 'board', logPid } = {}) {
  const restartArgv = argvWithoutOpen(argv);
  const childEnv = safeEnvSubset(env ?? {});
  const logPath = installRoot ? restartLogPath(installRoot, kind, logPid ?? process.pid) : null;
  let logFd = null;
  if (logPath) {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      logFd = openSync(logPath, 'a', 0o600);
    } catch { logFd = null; }
  }
  const stdio = logFd !== null ? ['ignore', logFd, logFd] : 'ignore';
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, [runner, ...restartArgv], {
      detached: true,
      stdio,
      cwd,
      env: { ...safeEnvSubset(process.env), ...childEnv },
    });
    child.on?.('error', () => {
      if (logFd !== null) { try { closeSync(logFd); } catch { /* closed */ } }
      resolve({ pid: null, error: true });
    });
    child.unref?.();
    if (logFd !== null && child.pid) {
      try { closeSync(logFd); } catch { /* parent must not keep fd open */ }
    }
    resolve({ pid: child.pid ?? null, error: false });
  });
}

export async function restartRegisteredServers({
  installRoot,
  targetVersion,
  noRestart = false,
  env = process.env,
  home = os.homedir(),
  write = () => {},
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  execFileImpl = execFileAsync,
  strictPidCheck = execFileImpl !== execFileAsync,
  stopTimeoutMs = 15000,
  pidAliveImpl = pidAlive,
  killImpl = (pid, signal) => process.kill(pid, signal),
  launchdBoardPlistExists,
  getuid,
} = {}) {
  const emit = line => {
    const text = line.endsWith('\n') ? line : `${line}\n`;
    write(text);
  };
  const servers = [];
  if (noRestart || !targetVersion) return { servers, lines: [] };

  const locked = await withRestartLock(installRoot, async () => {
  const pathEnv = registryEnv(env, home);
  const boardPath = boardFile(pathEnv, home);
  const remotePath = remoteServerFile(pathEnv, home);
  const registryEntries = [
    await readKind(boardPath, 'board'),
    await readKind(remotePath, 'remote'),
  ].filter(Boolean);

  const workByPid = new Map();

  for (const entry of registryEntries) {
    if (entry.readError) {
      emit(`${entry.kind} server record skipped: could not read ${entry.kind} server record`);
      continue;
    }
    if (entry.error) {
      emit(`${entry.kind} server record skipped: ${entry.error}`);
      servers.push({ kind: entry.kind, pid: null, from: null, to: targetVersion, port: null, status: 'unparsable' });
      continue;
    }
    workByPid.set(entry.record.pid, {
      kind: entry.kind,
      file: entry.file,
      record: entry.record,
      fromDiscovery: false,
    });
  }

  const discovered = await discoverRunningServers({
    execFileImpl,
    installRoot,
    platform: process.platform,
    fetchImpl,
  });
  for (const disc of discovered) {
    if (workByPid.has(disc.pid)) continue;
    const file = disc.kind === 'remote' ? remotePath : boardPath;
    workByPid.set(disc.pid, {
      kind: disc.kind,
      file,
      record: disc,
      fromDiscovery: true,
    });
  }

  let { runner } = await resolveRunnerForRestart(installRoot, targetVersion);
  if (!runner && process.env.SWARM_TEST_TMP) {
    const stub = path.join(installRoot, 'current', 'tools', 'swarm.mjs');
    try {
      await fs.mkdir(path.dirname(stub), { recursive: true });
      await fs.writeFile(stub, 'export {}\n', { flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        console.error('[tools/server-restart.mjs] test stub runner:', error?.code ?? 'unknown');
      }
    }
    ({ runner } = await resolveRunnerForRestart(installRoot, targetVersion));
  }

  const emitBoardUrl = async file => {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (typeof data.url === 'string' && data.url) emit(data.url);
    } catch { /* no url */ }
  };

  for (const { kind, file, record, fromDiscovery } of workByPid.values()) {
    const label = kind === 'board' ? 'board' : 'remote server';
    const hadTerminal = record.mode === 'terminal' || record.modeFromTty === true;

    if (!fromDiscovery && !validServerPort(record.port)) {
      const manual = runner ? manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env }) : null;
      emit(`${label} restart failed: invalid port ${record.port}${manual ? `; run by hand: ${manual}` : ''}`);
      servers.push({ kind, pid: record.pid, from: record.version, to: targetVersion, port: record.port, status: 'failed' });
      continue;
    }

    const probe = pidAliveImpl === pidAlive ? pidProbe(record.pid) : (pidAliveImpl(record.pid) ? 'alive' : 'dead');
    if (probe === 'denied') {
      emit(`${label} server record (pid ${record.pid}): process exists but is not owned by this user; record kept`);
      servers.push({ kind, pid: record.pid, from: record.version, to: targetVersion, port: record.port, status: 'unowned-pid' });
      continue;
    }
    if (probe === 'dead') {
      if (!fromDiscovery) {
        await removeRegistryRecordIfUnchanged(file, {
          pid: record.pid,
          startedAt: record.startedAt,
          url: record.url,
          version: record.version,
        });
      }
      continue;
    }

    if (record.version === targetVersion) continue;

    const from = record.version ?? null;
    const port = record.port;

    if (!fromDiscovery && (record.mode === 'terminal' || !isAutoRestartable(record))) {
      const argvText = record.argv.join(' ');
      emit(`${label} running in a terminal (pid ${record.pid}) still serves ${from ?? 'unknown'}: press Ctrl-C there and run swarm ${argvText}`);
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'terminal' });
      continue;
    }

    if (!runner) {
      emit(`${label} restart skipped: installed runner not found under ${installRoot}; leave pid ${record.pid} running`);
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'failed' });
      continue;
    }

    const startable = await assertStartable({ runner, cwd: record.cwd, argv: record.argv });
    if (!startable.ok) {
      const manual = manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env });
      emit(`${label} restart failed: ${startable.reason}; run by hand: ${manual}`);
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'failed' });
      continue;
    }

    if (!fromDiscovery) {
      const identity = strictPidCheck || !process.env.SWARM_TEST_TMP
        ? await verifyRegistryPid(record, runner, { execFileImpl, installRoot })
        : { ok: true };
      if (!identity.ok) {
        const remove = identity.removeRecord === true || identityMismatchRemovesRecord(identity.reason);
        if (remove) {
          const removed = await removeRegistryRecordIfUnchanged(file, {
            pid: record.pid,
            startedAt: record.startedAt,
            url: record.url,
            version: record.version,
          });
          if (removed) {
            emit(`${label} stale server record (pid ${record.pid}): ${identity.reason}; record removed`);
            servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'stale-record' });
          } else {
            const restartHint = emitIdentityUnverifiedRestart(emit, {
              label,
              record,
              kind,
              reasonSuffix: `${identity.reason}; record kept (changed concurrently)`,
              launchdBoardPlistExists,
              getuid,
            });
            servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'identity-unverified', restartHint });
          }
        } else {
          const restartHint = emitIdentityUnverifiedRestart(emit, {
            label,
            record,
            kind,
            reasonSuffix: `${identity.reason}; record kept`,
            launchdBoardPlistExists,
            getuid,
          });
          servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'identity-unverified', restartHint });
        }
        continue;
      }
    }

    const sigtermOk = await (async () => {
      try { killImpl(record.pid, 'SIGTERM'); } catch { return false; }
      return await waitForExit(record.pid, stopTimeoutMs, sleep, pidAliveImpl);
    })();

    if (!sigtermOk) {
      const manual = manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env });
      emit(`${label} still running (pid ${record.pid}) after SIGTERM: not killed; stop it by hand, then run: ${manual}`);
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'sigterm-timeout' });
      continue;
    }

    if (validServerPort(port) && !(await waitForPortFree(port, 15000, sleep))) {
      const manual = manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env });
      emit(`${label} port ${port} still busy: could not restart; run by hand: ${manual}`);
      servers.push({ kind, pid: null, from, to: targetVersion, port, status: 'port-busy' });
      continue;
    }

    let started = false;
    let lastManual = manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env });
    for (let attempt = 0; attempt < 2 && !started; attempt += 1) {
      const { pid: newPid, error: spawnError } = await spawnDetached(runner, record.argv, {
        cwd: record.cwd,
        env: record.env,
        spawnImpl,
        installRoot,
        kind,
        logPid: record.pid,
      });
      if (spawnError || !newPid) continue;
      const confirm = kind === 'remote'
        ? await pollRemoteFile(file, targetVersion, { sleep, pidAliveImpl })
        : await pollBoardRecord(file, targetVersion, { sleep, fetchImpl, pidAliveImpl });
      if (confirm.ok) {
        const confirmedPort = confirm.port ?? port;
        const fromLabel = from ?? 'unknown';
        if (hadTerminal) {
          emit(`${label} terminal session ended (pid ${record.pid}); restarted ${fromLabel} to ${targetVersion} (port ${confirmedPort}, pid ${confirm.pid ?? newPid})`);
        } else {
          emit(`${label} restarted: ${fromLabel} to ${targetVersion} (port ${confirmedPort}, pid ${confirm.pid ?? newPid})`);
        }
        if (kind === 'board') await emitBoardUrl(file);
        servers.push({ kind, pid: confirm.pid ?? newPid, from, to: targetVersion, port: confirmedPort, status: 'restarted' });
        started = true;
      } else if (newPid && pidAliveImpl(newPid)) {
        try { killImpl(newPid, 'SIGTERM'); } catch (error) {
          if (error?.code !== 'ESRCH') {
            console.error('[tools/server-restart.mjs] stop replacement after failed restart:', error?.code ?? error?.name ?? 'unknown');
          }
        }
        await waitForExit(newPid, 3000, sleep, pidAliveImpl);
      }
    }
    if (!started && !servers.some(s => s.kind === kind && s.from === from && s.port === port && s.status === 'restarted')) {
      emit(`${label} restart failed: old server stopped but replacement did not come up`);
      emit(`run by hand: ${lastManual}`);
      servers.push({ kind, pid: null, from, to: targetVersion, port, status: 'failed' });
    }
  }

  return { servers, lines: [] };
  }, { sleep });

  if (!locked.ok) {
    emit(locked.reason);
    return { servers, lines: [] };
  }
  return locked.result;
}

export function noRestartFromArgv(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--no-restart');
}
