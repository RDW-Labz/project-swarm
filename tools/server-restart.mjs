// SPDX-License-Identifier: Apache-2.0
// After `swarm update`, restart board and remote-serve processes that still run an older version.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { boardFile, safeEnvSubset, serverMode } from './watch-cli.mjs';

export { safeEnvSubset, serverMode };

export const remoteServerFile = (env = process.env, home = os.homedir()) => {
  const board = boardFile(env, home);
  return env.SWARM_REMOTE_SERVER_FILE || path.join(path.dirname(board), 'remote-server.json');
};

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  const parts = [process.execPath, shellQuote(runner), ...argv.map(a => shellQuote(a))];
  const prefix = cwd && cwd !== process.cwd() ? `cd ${shellQuote(cwd)} && ` : '';
  const envKeys = Object.keys(env ?? {});
  const envPrefix = envKeys.length
    ? `${envKeys.map(k => `${k}=${shellQuote(env[k])}`).join(' ')} `
    : '';
  return `${prefix}${envPrefix}${parts.join(' ')}`;
}

function parseRecord(text, kind) {
  let data;
  try { data = JSON.parse(text); } catch { return { error: `could not parse ${kind} server record` }; }
  if (!data || typeof data !== 'object') return { error: `could not parse ${kind} server record` };
  if (!Number.isInteger(data.pid) || data.pid <= 0) return { error: `invalid pid in ${kind} server record` };
  if (typeof data.version !== 'string' || !data.version) return { error: `missing version in ${kind} server record` };
  if (!Array.isArray(data.argv) || !data.argv.every(a => typeof a === 'string')) return { error: `invalid argv in ${kind} server record` };
  if (typeof data.cwd !== 'string' || !data.cwd) return { error: `missing cwd in ${kind} server record` };
  if (!Number.isInteger(data.port) || data.port <= 0) return { error: `missing port in ${kind} server record` };
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
  return { HOME: h, PATH: env.PATH ?? process.env.PATH ?? '' };
}

async function waitForExit(pid, timeoutMs, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
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
  if (record.url && typeof record.url === 'string') {
    try {
      const u = new URL(record.url);
      return `http://127.0.0.1:${record.port}/api/health`;
    } catch { /* fall through */ }
  }
  return `http://127.0.0.1:${record.port}/api/health`;
}

async function fetchHealth(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout?.(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || body.ok !== true || typeof body.version !== 'string') return null;
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

function spawnDetached(runner, argv, { cwd, env, spawnImpl = spawn }) {
  const child = spawnImpl(process.execPath, [runner, ...argv], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: { ...process.env, ...env },
  });
  child.unref?.();
  return child.pid ?? null;
}

function runnerForInstall(installRoot) {
  return path.join(installRoot, 'current', 'tools', 'swarm.mjs');
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
} = {}) {
  const lines = [];
  const servers = [];
  if (noRestart || !targetVersion) return { servers, lines };

  const pathEnv = registryEnv(env, home);
  const entries = [
    await readKind(boardFile(pathEnv, home), 'board'),
    await readKind(remoteServerFile(pathEnv, home), 'remote'),
  ].filter(Boolean);

  const runner = runnerForInstall(installRoot);

  for (const entry of entries) {
    if (entry.readError) {
      lines.push(`${entry.kind} server record skipped: could not read ${entry.kind} server record`);
      continue;
    }
    if (entry.error) {
      lines.push(`${entry.kind} server record skipped: ${entry.error}`);
      servers.push({ kind: entry.kind, pid: null, from: null, to: targetVersion, port: null, status: 'unparsable' });
      continue;
    }
    const { record, file, kind } = entry;
    const label = kind === 'board' ? 'board' : 'remote server';

    if (!pidAlive(record.pid)) {
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }

    if (record.version === targetVersion) continue;

    const from = record.version;
    const port = record.port;

    if (record.mode === 'terminal') {
      const argvText = record.argv.join(' ');
      lines.push(`${label} running in a terminal (pid ${record.pid}) still serves ${from}: press Ctrl-C there and run swarm ${argvText}`);
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'terminal' });
      continue;
    }

    const sigtermOk = await (async () => {
      try { process.kill(record.pid, 'SIGTERM'); } catch { return false; }
      return await waitForExit(record.pid, 15000, sleep);
    })();

    if (!sigtermOk) {
      lines.push(`${label} still running (pid ${record.pid}) after SIGTERM: not killed; stop it by hand, then run: ${manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env })}`);
      servers.push({ kind, pid: record.pid, from, to: targetVersion, port, status: 'sigterm-timeout' });
      continue;
    }

    if (!(await waitForPortFree(port, 15000, sleep))) {
      lines.push(`${label} port ${port} still busy: could not restart; run by hand: ${manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env })}`);
      servers.push({ kind, pid: null, from, to: targetVersion, port, status: 'port-busy' });
      continue;
    }

    let newPid = null;
    let started = false;
    for (let attempt = 0; attempt < 2 && !started; attempt += 1) {
      try {
        await fs.access(runner);
      } catch {
        lines.push(`${label} restart failed: runner missing at ${runner}; run by hand: ${manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env })}`);
        servers.push({ kind, pid: null, from, to: targetVersion, port, status: 'failed' });
        started = true;
        break;
      }
      newPid = spawnDetached(runner, record.argv, { cwd: record.cwd, env: record.env, spawnImpl });
      if (!newPid) continue;
      const confirm = kind === 'remote'
        ? await pollRemoteFile(file, targetVersion, { sleep })
        : await pollNewVersion({ ...record, port }, targetVersion, { sleep, fetchImpl });
      if (confirm.ok) {
        lines.push(`${label} restarted: ${from} to ${targetVersion} (port ${port}, pid ${confirm.pid ?? newPid})`);
        servers.push({ kind, pid: confirm.pid ?? newPid, from, to: targetVersion, port, status: 'restarted' });
        started = true;
      } else if (newPid && pidAlive(newPid)) {
        try { process.kill(newPid, 'SIGTERM'); } catch { /* best effort */ }
        await waitForExit(newPid, 3000, sleep);
      }
    }
    if (!started && !servers.some(s => s.kind === kind && s.from === from && s.port === port)) {
      lines.push(`${label} restart failed after retry; run by hand: ${manualCommand({ runner, argv: record.argv, cwd: record.cwd, env: record.env })}`);
      servers.push({ kind, pid: null, from, to: targetVersion, port, status: 'failed' });
    }
  }

  for (const line of lines) write(line.endsWith('\n') ? line : `${line}\n`);
  return { servers, lines };
}

export function noRestartFromArgv(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--no-restart');
}
