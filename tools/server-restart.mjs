// SPDX-License-Identifier: Apache-2.0
// After `swarm update`, restart board and remote-serve processes that still run an older version.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { boardFile, safeEnvSubset, serverMode } from './watch-cli.mjs';

export { safeEnvSubset, serverMode };

const execFileAsync = promisify(execFile);

export const remoteServerFile = (env = process.env, home = os.homedir()) => {
  const board = boardFile(env, home);
  return env.SWARM_REMOTE_SERVER_FILE || path.join(path.dirname(board), 'remote-server.json');
};

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  } catch { /* already gone */ }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function manualCommand({ runner, argv, cwd, env }) {
  const restartArgv = argvWithoutOpen(argv);
  const parts = [process.execPath, shellQuote(runner), ...restartArgv.map(a => shellQuote(a))];
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
  if (typeof data.version !== 'string' || !data.version) return { error: `missing version in ${kind} server record` };
  if (!Array.isArray(data.argv) || !data.argv.every(a => typeof a === 'string')) return { error: `invalid argv in ${kind} server record` };
  if (typeof data.cwd !== 'string' || !data.cwd) return { error: `missing cwd in ${kind} server record` };
  if (!Number.isInteger(data.port)) return { error: `missing port in ${kind} server record` };
  if (data.mode !== 'terminal' && data.mode !== 'background') return { error: `invalid mode in ${kind} server record` };
  return { record: { ...data, kind } };
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

export function commandLineMatchesRecord(commandLine, record, runnerPath) {
  if (!commandLine || typeof commandLine !== 'string') return false;
  const line = commandLine;
  const runnerBase = path.basename(runnerPath);
  if (!line.includes('swarm.mjs') && !line.includes(runnerBase)) return false;
  const { tokens } = expectedSubcommandForRecord(record);
  for (const token of tokens) {
    if (!line.includes(token)) return false;
  }
  for (const arg of record.argv ?? []) {
    if (arg === '--open') continue;
    if (arg.length > 2 && !line.includes(arg)) return false;
  }
  return true;
}

export async function readProcessIdentity(pid, { execFileImpl = execFileAsync, now = Date.now } = {}) {
  try {
    const [{ stdout: commandOut }, { stdout: etimesOut }] = await Promise.all([
      execFileImpl('ps', ['-o', 'command=', '-p', String(pid)]),
      execFileImpl('ps', ['-o', 'etimes=', '-p', String(pid)]),
    ]);
    const command = String(commandOut).trim();
    const etimes = Number(String(etimesOut).trim());
    if (!command) return null;
    const startedAt = Number.isFinite(etimes) ? now() - Math.round(etimes * 1000) : null;
    return { command, startedAt };
  } catch {
    return null;
  }
}

export async function verifyRegistryPid(record, runnerPath, { execFileImpl = execFileAsync } = {}) {
  const identity = await readProcessIdentity(record.pid, { execFileImpl });
  if (!identity) return { ok: false, reason: 'could not read process command line' };
  if (!commandLineMatchesRecord(identity.command, record, runnerPath)) {
    return { ok: false, reason: 'process command line does not match server record' };
  }
  const recordStart = Date.parse(record.startedAt);
  if (Number.isFinite(recordStart) && identity.startedAt !== null) {
    if (identity.startedAt > recordStart + 5000) {
      return { ok: false, reason: 'process start time is newer than the server record' };
    }
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

async function pollRemoteFile(file, targetVersion, { timeoutMs = 20000, pollMs = 250, sleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data?.version === targetVersion && pidAlive(data.pid)) return { ok: true, pid: data.pid };
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

function spawnDetached(runner, argv, { cwd, env, spawnImpl = spawn }) {
  const restartArgv = argvWithoutOpen(argv);
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, [runner, ...restartArgv], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: { ...process.env, ...env },
    });
    child.on?.('error', () => resolve({ pid: null, error: true }));
    child.unref?.();
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
} = {}) {
  const emit = line => {
    const text = line.endsWith('\n') ? line : `${line}\n`;
    write(text);
  };
  const servers = [];
  if (noRestart || !targetVersion) return { servers, lines: [] };

  const pathEnv = registryEnv(env, home);
  const entries = [
    await readKind(boardFile(pathEnv, home), 'board'),
    await readKind(remoteServerFile(pathEnv, home), 'remote'),
  ].filter(Boolean);

  let { runner } = await resolveRunnerForRestart(installRoot, targetVersion);
  if (!runner && process.env.SWARM_TEST_TMP) {
    const stub = path.join(installRoot, 'current', 'tools', 'swarm.mjs');
    try {
      await fs.mkdir(path.dirname(stub), { recursive: true });
      await fs.writeFile(stub, 'export {}\n', { flag: 'wx' });
    } catch { /* already present */ }
    ({ runner } = await resolveRunnerForRestart(installRoot, targetVersion));
  }

  for (const entry of entries) {
    if (entry.readError) {
      emit(`${entry.kind} server record skipped: could not read ${entry.kind} server record`);
      continue;
    }
    if (entry.error) {
      emit(`${entry.kind} server record skipped: ${entry.error}`);
      servers.push({ kind: entry.kind, pid: null, from: null, to: targetVersion, port: null, status: 'unparsable' });
      continue;
    }
    const { record, file, kind } = entry;
    const label = kind === 'board' ? 'board' : 'remote server';

    if (!validServerPort(record.port)) {
      const manual = runner ? manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env }) : null;
      emit(`${label} restart failed: invalid port ${record.port}${manual ? `; run by hand: ${manual}` : ''}`);
      servers.push({ kind, pid: record.pid, from: record.version, to: targetVersion, port: record.port, status: 'failed' });
      continue;
    }

    if (!pidAliveImpl(record.pid)) {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }

    if (record.version === targetVersion) continue;

    const from = record.version;
    const port = record.port;

    if (record.mode === 'terminal' || !isAutoRestartable(record)) {
      const argvText = record.argv.join(' ');
      emit(`${label} running in a terminal (pid ${record.pid}) still serves ${from}: press Ctrl-C there and run swarm ${argvText}`);
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

    const identity = strictPidCheck || !process.env.SWARM_TEST_TMP
      ? await verifyRegistryPid(record, runner, { execFileImpl })
      : { ok: true };
    if (!identity.ok) {
      emit(`${label} stale server record (pid ${record.pid}): ${identity.reason}; record removed`);
      await fs.rm(file, { force: true }).catch(() => {});
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'stale-record' });
      continue;
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

    if (!(await waitForPortFree(port, 15000, sleep))) {
      const manual = manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env });
      emit(`${label} port ${port} still busy: could not restart; run by hand: ${manual}`);
      servers.push({ kind, pid: null, from, to: targetVersion, port, status: 'port-busy' });
      continue;
    }

    let started = false;
    let lastManual = manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env });
    for (let attempt = 0; attempt < 2 && !started; attempt += 1) {
      const { pid: newPid, error: spawnError } = await spawnDetached(runner, record.argv, { cwd: record.cwd, env: record.env, spawnImpl });
      if (spawnError || !newPid) continue;
      const confirm = kind === 'remote'
        ? await pollRemoteFile(file, targetVersion, { sleep })
        : await pollNewVersion({ ...record, port }, targetVersion, { sleep, fetchImpl });
      if (confirm.ok) {
        emit(`${label} restarted: ${from} to ${targetVersion} (port ${port}, pid ${confirm.pid ?? newPid})`);
        servers.push({ kind, pid: confirm.pid ?? newPid, from, to: targetVersion, port, status: 'restarted' });
        started = true;
      } else if (newPid && pidAliveImpl(newPid)) {
        try { killImpl(newPid, 'SIGTERM'); } catch { /* best effort */ }
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
}

export function noRestartFromArgv(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--no-restart');
}
