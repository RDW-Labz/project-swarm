// SPDX-License-Identifier: Apache-2.0
// Discover running swarm board / remote-serve processes by command line (no registry record required).
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROC_TCP_LISTEN_STATE = '0A';
const IPV4_LOOPBACK_HEX = '0100007F';
const IPV4_ANY_HEX = '00000000';
const IPV6_ANY_HEX = '0000000000000000';
const IPV6_LOOPBACK_HEX = '01000000000000000000000000000000';

export function validServerPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function argvWithoutOpen(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter(arg => arg !== '--open');
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
    const code = error?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.error('[tools/server-discovery.mjs] installRunnerCandidates readdir versions:', error?.message ?? error);
    }
  }
  return out;
}

function resolvePathReal(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  try { return realpathSync(candidate); } catch {
    try { return path.resolve(candidate); } catch { return null; }
  }
}

export function acceptedRunnerRealpaths(installRoot) {
  const seen = new Set();
  const out = [];
  for (const candidate of installRunnerCandidates(installRoot)) {
    const resolved = resolvePathReal(candidate);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function parsePsAxLine(line) {
  const raw = String(line).trim();
  if (!raw) return null;
  const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(raw);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  return { pid, ppid, etime: match[3], args: match[4] };
}

export function buildExcludedPidSet(selfPid, rows) {
  const byPid = new Map(rows.map(row => [row.pid, row.ppid]));
  const exclude = new Set();
  let current = selfPid;
  while (Number.isInteger(current) && current > 0) {
    if (exclude.has(current)) break;
    exclude.add(current);
    current = byPid.get(current) ?? 0;
  }
  return exclude;
}

function runnerTokenIndex(tokens, acceptedRunners) {
  for (let i = 0; i < tokens.length; i += 1) {
    const resolved = resolvePathReal(tokens[i]);
    if (resolved && acceptedRunners.includes(resolved)) return i;
  }
  return -1;
}

function classifySwarmArgv(tokens, runnerIndex) {
  const rest = tokens.slice(runnerIndex + 1);
  if (rest.includes('remote') && rest.includes('serve')) {
    return { kind: 'remote', argv: argvWithoutOpen(rest) };
  }
  if (rest.includes('watch')) {
    return { kind: 'board', argv: argvWithoutOpen(rest) };
  }
  return null;
}

export function parseLsofFnOutput(text) {
  const fields = { pid: null, cwd: null };
  const lines = String(text).split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('p')) fields.pid = Number(line.slice(1));
    else if (line === 'cwd' && lines[i + 1]?.startsWith('n')) {
      fields.cwd = lines[i + 1].slice(1);
      i += 1;
    } else if (line.startsWith('n') && line.includes('/') && !fields.cwd) {
      fields.cwd = line.slice(1);
    }
  }
  return fields;
}

export function parseLsofListenPorts(text) {
  const ports = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('n')) continue;
    const name = line.slice(1);
    const m = /127\.0\.0\.1:(\d+)/.exec(name) ?? /\[::1\]:(\d+)/.exec(name);
    if (m) {
      const port = Number(m[1]);
      if (validServerPort(port)) ports.push(port);
    }
  }
  return [...new Set(ports)];
}

export function parseReadlinkSocketInode(target) {
  const m = /^socket:\[(\d+)\]$/.exec(String(target).trim());
  if (!m) return null;
  const inode = Number(m[1]);
  return Number.isInteger(inode) && inode > 0 ? inode : null;
}

export function isAcceptableProcListenLocalAddress(ipHex, ipv6) {
  const ip = String(ipHex).trim().toUpperCase();
  if (!ipv6) {
    return ip === IPV4_LOOPBACK_HEX || ip === IPV4_ANY_HEX;
  }
  return ip === IPV6_ANY_HEX || ip === IPV6_LOOPBACK_HEX;
}

/** Parse /proc/net/tcp or /proc/net/tcp6; returns inode -> listen port for loopback or any-address sockets. */
export function parseProcNetTcpListenInodes(text, { ipv6 = false } = {}) {
  const byInode = new Map();
  for (const line of String(text).split('\n')) {
    const row = parseProcNetTcpListenRow(line, { ipv6 });
    if (row) byInode.set(row.inode, row.port);
  }
  return byInode;
}

export function parseProcNetTcpListenRow(line, { ipv6 = false } = {}) {
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith('sl')) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 10) return null;
  const localAddr = parts[1];
  const state = parts[3];
  if (state !== PROC_TCP_LISTEN_STATE) return null;
  const colon = localAddr.indexOf(':');
  if (colon < 0) return null;
  const ipHex = localAddr.slice(0, colon);
  const portHex = localAddr.slice(colon + 1);
  if (!isAcceptableProcListenLocalAddress(ipHex, ipv6)) return null;
  const port = Number.parseInt(portHex, 16);
  if (!validServerPort(port)) return null;
  const inode = Number(parts[9]);
  if (!Number.isInteger(inode) || inode <= 0) return null;
  return { inode, port };
}

/** Match socket inodes from /proc/PID/fd against parsed /proc/net/tcp(+6) listen rows. */
export function listenPortsMatchingProcInodes(socketInodes, tcpText, tcp6Text = '') {
  const inodeSet = new Set(socketInodes);
  const ports = [];
  for (const [inode, port] of parseProcNetTcpListenInodes(tcpText).entries()) {
    if (inodeSet.has(inode)) ports.push(port);
  }
  for (const [inode, port] of parseProcNetTcpListenInodes(tcp6Text, { ipv6: true }).entries()) {
    if (inodeSet.has(inode)) ports.push(port);
  }
  return [...new Set(ports)];
}

async function fetchHealthPid(port, fetchImpl) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout?.(2000),
      headers: { Host: `127.0.0.1:${port}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object') return null;
    return {
      pid: Number.isInteger(body.pid) ? body.pid : null,
      version: typeof body.version === 'string' ? body.version : null,
    };
  } catch {
    return null;
  }
}

async function pickPortForPid(pid, ports, fetchImpl) {
  if (!ports.length) return { port: null, version: null };
  const matching = [];
  for (const port of ports) {
    const health = await fetchHealthPid(port, fetchImpl);
    if (health?.pid === pid) matching.push({ port, version: health.version });
  }
  if (matching.length === 1) return matching[0];
  if (matching.length > 1) return matching[0];
  return { port: ports[0] ?? null, version: null };
}

async function readProcessCwd(pid, { execFileImpl, platform }) {
  if (platform === 'linux') {
    try {
      const { stdout } = await execFileImpl('readlink', [`/proc/${pid}/cwd`]);
      const cwd = String(stdout).trim();
      return cwd || null;
    } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        console.error('[tools/server-discovery.mjs] readProcessCwd readlink /proc cwd:', error?.message ?? error);
      }
    }
  }
  try {
    const { stdout } = await execFileImpl('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const parsed = parseLsofFnOutput(stdout);
    return parsed.cwd ?? null;
  } catch {
    return null;
  }
}

async function collectSocketInodesForPid(pid, { readdirImpl = fs.readdir, readlinkImpl = fs.readlink } = {}) {
  const fdDir = `/proc/${pid}/fd`;
  const names = await readdirImpl(fdDir);
  const inodes = [];
  for (const name of names) {
    try {
      const target = await readlinkImpl(path.join(fdDir, name));
      const inode = parseReadlinkSocketInode(target);
      if (inode !== null) inodes.push(inode);
    } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        console.error('[tools/server-discovery.mjs] collectSocketInodesForPid readlink fd:', error?.message ?? error);
      }
    }
  }
  return inodes;
}

async function readListenPortsFromProcLinux(pid, {
  readFileImpl = fs.readFile,
  readdirImpl = fs.readdir,
  readlinkImpl = fs.readlink,
} = {}) {
  try {
    const socketInodes = await collectSocketInodesForPid(pid, { readdirImpl, readlinkImpl });
    if (!socketInodes.length) return [];
    let tcpText = '';
    let tcp6Text = '';
    try { tcpText = await readFileImpl('/proc/net/tcp', 'utf8'); } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        console.error('[tools/server-discovery.mjs] readListenPortsFromProcLinux read /proc/net/tcp:', error?.message ?? error);
      }
    }
    try { tcp6Text = await readFileImpl('/proc/net/tcp6', 'utf8'); } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
        console.error('[tools/server-discovery.mjs] readListenPortsFromProcLinux read /proc/net/tcp6:', error?.message ?? error);
      }
    }
    return listenPortsMatchingProcInodes(socketInodes, tcpText, tcp6Text);
  } catch {
    return [];
  }
}

export async function listenPortsForPid(pid, {
  execFileImpl,
  platform = process.platform,
  lsofAvailable = true,
  readFileImpl = fs.readFile,
  readdirImpl = fs.readdir,
  readlinkImpl = fs.readlink,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (lsofAvailable) {
    try {
      const { stdout } = await execFileImpl('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
      const ports = parseLsofListenPorts(stdout);
      if (ports.length) return ports;
    } catch (error) {
      const code = error?.code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM' && code !== 1) {
        console.error('[tools/server-discovery.mjs] listenPortsForPid lsof:', error?.message ?? error);
      }
    }
  }
  try {
    const { stdout } = await execFileImpl('ss', ['-ltn', 'p']);
    const ports = [];
    for (const line of String(stdout).split('\n')) {
      if (!line.includes(`pid=${pid}`)) continue;
      const m = /127\.0\.0\.1:(\d+)/.exec(line);
      if (m && validServerPort(Number(m[1]))) ports.push(Number(m[1]));
    }
    const fromSs = [...new Set(ports)];
    if (fromSs.length) return fromSs;
  } catch (error) {
    const code = error?.code;
    if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM' && code !== 1) {
      console.error('[tools/server-discovery.mjs] listenPortsForPid ss:', error?.message ?? error);
    }
  }
  if (platform === 'linux') {
    return await readListenPortsFromProcLinux(pid, { readFileImpl, readdirImpl, readlinkImpl });
  }
  return [];
}

async function readListenPorts(pid, deps) {
  return listenPortsForPid(pid, deps);
}

async function processHasControllingTty(pid, execFileImpl) {
  try {
    const { stdout } = await execFileImpl('ps', ['-o', 'tty=', '-p', String(pid)]);
    const tty = String(stdout).trim();
    return Boolean(tty && tty !== '?' && tty !== '??' && tty !== '-');
  } catch {
    return false;
  }
}

export async function discoverRunningServers({
  execFileImpl,
  installRoot,
  platform = process.platform,
  selfPid = process.pid,
  fetchImpl = globalThis.fetch,
  lsofAvailable,
  readFileImpl,
  readdirImpl,
  readlinkImpl,
} = {}) {
  if (!execFileImpl || !installRoot) return [];
  const acceptedRunners = acceptedRunnerRealpaths(installRoot);
  if (!acceptedRunners.length) return [];

  let psOut;
  try {
    ({ stdout: psOut } = await execFileImpl('ps', ['-axo', 'pid=,ppid=,etime=,args=']));
  } catch {
    return [];
  }

  const rows = [];
  for (const line of String(psOut).split('\n')) {
    const row = parsePsAxLine(line);
    if (row) rows.push(row);
  }
  const exclude = buildExcludedPidSet(selfPid, rows);
  const discovered = [];

  for (const row of rows) {
    if (exclude.has(row.pid)) continue;
    const tokens = tokenizePsArgs(row.args);
    if (!tokens.length) continue;
    const runnerIndex = runnerTokenIndex(tokens, acceptedRunners);
    if (runnerIndex < 0) continue;
    const classified = classifySwarmArgv(tokens, runnerIndex);
    if (!classified) continue;

    const cwd = await readProcessCwd(row.pid, { execFileImpl, platform });
    if (!cwd) continue;

    const ports = await readListenPorts(row.pid, {
      execFileImpl,
      platform,
      lsofAvailable: lsofAvailable !== false,
      readFileImpl,
      readdirImpl,
      readlinkImpl,
    });
    const { port, version } = await pickPortForPid(row.pid, ports, fetchImpl);

    const elapsedSec = parsePsEtime(row.etime);
    const startedAt = elapsedSec !== null
      ? new Date(Date.now() - elapsedSec * 1000).toISOString()
      : new Date().toISOString();

    const hasTty = await processHasControllingTty(row.pid, execFileImpl);

    discovered.push({
      kind: classified.kind,
      pid: row.pid,
      version,
      argv: classified.argv,
      cwd,
      port: validServerPort(port) ? port : null,
      env: {},
      mode: hasTty ? 'terminal' : 'background',
      modeFromTty: hasTty,
      explicitBackground: !hasTty,
      startedAt,
      fromDiscovery: true,
      url: validServerPort(port) ? `http://127.0.0.1:${port}/?t=discovered` : null,
    });
  }

  return discovered;
}
