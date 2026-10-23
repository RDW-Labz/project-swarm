// SPDX-License-Identifier: Apache-2.0
// Managed SSH port-forward tunnels for the local lane (macOS launchd).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadLocalLaneConfig, LOCAL_DOCTOR_TIMEOUT_MS } from './local-lane.mjs';

function modelsUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

export const TUNNEL_LABEL_PREFIX = 'com.project-swarm.tunnel.';
const SAFE_TOKEN = /^[A-Za-z0-9._@-]+$/;
const VALUE_FLAGS = new Set(['host', 'key', 'local-port', 'remote-port', 'remote-host']);

export class TunnelError extends Error {
  constructor(message, code = 'tunnel-error') {
    super(message);
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new TunnelError(message, code);
};

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function tunnelLabel(name) {
  return `${TUNNEL_LABEL_PREFIX}${name}`;
}

export function tunnelPlistPath(home, name) {
  return path.join(home, 'Library', 'LaunchAgents', `${tunnelLabel(name)}.plist`);
}

export function tunnelLogPath(home, name) {
  return path.join(home, 'Library', 'Logs', `project-swarm-tunnel-${name}.log`);
}

export function launchAgentsDir(home) {
  return path.join(home, 'Library', 'LaunchAgents');
}

export function validateTunnelName(name) {
  if (typeof name !== 'string' || !name || !SAFE_TOKEN.test(name)) {
    fail('tunnel-invalid: name must use only [A-Za-z0-9._@-]', 'tunnel-invalid');
  }
  return name;
}

export function validateTunnelHost(host) {
  if (typeof host !== 'string' || !host || !SAFE_TOKEN.test(host)) {
    fail('tunnel-invalid: host must use only [A-Za-z0-9._@-]', 'tunnel-invalid');
  }
  return host;
}

function parsePort(raw, field) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`tunnel-invalid: ${field} must be a port 1–65535`, 'tunnel-invalid');
  }
  return port;
}

export function buildSshProgramArguments({ key, localPort, remoteHost, remotePort, host }) {
  return [
    '/usr/bin/ssh',
    '-N',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-i', key,
    '-L', `${localPort}:${remoteHost}:${remotePort}`,
    host,
  ];
}

export function buildTunnelPlist({ name, programArguments, logPath }) {
  const label = tunnelLabel(name);
  const argsXml = programArguments.map(item => `    <string>${xmlEscape(item)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function parseForwardFromArgv(programArguments) {
  if (!Array.isArray(programArguments)) return null;
  const index = programArguments.indexOf('-L');
  if (index < 0 || index + 1 >= programArguments.length) return null;
  const match = /^(\d+):([^:]+):(\d+)$/.exec(programArguments[index + 1]);
  if (!match) return null;
  return { localPort: Number(match[1]), remoteHost: match[2], remotePort: Number(match[3]) };
}

export function parsePlistProgramArguments(plistText) {
  const strings = [];
  const re = /<string>([^<]*)<\/string>/g;
  let match;
  while ((match = re.exec(plistText)) !== null) strings.push(match[1]);
  const start = strings.findIndex(item => item === '/usr/bin/ssh');
  if (start < 0) return null;
  return strings.slice(start);
}

export function listTunnelPlists(deps) {
  const dir = launchAgentsDir(deps.home);
  let names;
  try {
    names = deps.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(name => name.startsWith(TUNNEL_LABEL_PREFIX) && name.endsWith('.plist'))
    .map(file => file.slice(TUNNEL_LABEL_PREFIX.length, -'.plist'.length));
}

export function readTunnelRecord(deps, name) {
  const plistPath = tunnelPlistPath(deps.home, name);
  let text;
  try {
    text = deps.readFileSync(plistPath, 'utf8');
  } catch {
    return null;
  }
  const programArguments = parsePlistProgramArguments(text);
  const forward = parseForwardFromArgv(programArguments);
  const host = programArguments?.[programArguments.length - 1] ?? null;
  const keyIndex = programArguments?.indexOf('-i');
  const key = keyIndex >= 0 ? programArguments[keyIndex + 1] : null;
  return {
    name,
    label: tunnelLabel(name),
    plistPath,
    logPath: tunnelLogPath(deps.home, name),
    programArguments,
    forward,
    host,
    keyPath: key,
  };
}

export function collectTunnelLocalPorts(deps, exceptName = null) {
  const ports = new Set();
  for (const name of listTunnelPlists(deps)) {
    if (name === exceptName) continue;
    const record = readTunnelRecord(deps, name);
    if (record?.forward?.localPort) ports.add(record.forward.localPort);
  }
  return ports;
}

export function portAcceptsConnection(port, { connect = defaultPortProbe, host = '127.0.0.1', timeoutMs = 300 } = {}) {
  return connect({ host, port, timeoutMs });
}

function defaultPortProbe({ host, port, timeoutMs }) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = busy => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

export function parseLaunchctlPrint(text) {
  const state = /^\s*state\s*=\s*(\S+)/m.exec(text)?.[1] ?? null;
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(text)?.[1];
  return { state, pid: pid ? Number(pid) : null };
}

export function tailLogLines(text, count = 3) {
  const lines = String(text).split('\n').filter(line => line.length);
  return lines.slice(-count);
}

function baseUrlPort(baseUrl) {
  try {
    return new URL(baseUrl).port ? Number(new URL(baseUrl).port) : (new URL(baseUrl).protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
}

export async function endpointReachabilityForPort(localPort, endpoints, { fetchImpl = fetch, timeoutMs = LOCAL_DOCTOR_TIMEOUT_MS, now = Date.now } = {}) {
  const matches = endpoints.filter(ep => baseUrlPort(ep.baseUrl) === localPort);
  const out = [];
  for (const ep of matches) {
    const url = modelsUrl(ep.baseUrl);
    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reachable = false;
    let status = null;
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal });
      await response.body?.cancel();
      reachable = response.ok;
      status = response.status;
    } catch {
      reachable = false;
    } finally {
      clearTimeout(timer);
    }
    out.push({
      endpoint: ep.name,
      modelsUrl: url,
      reachable,
      httpStatus: status,
      latencyMs: now() - started,
    });
  }
  return out;
}

export function defaultTunnelDeps(env = process.env) {
  const home = env.HOME || env.USERPROFILE || '';
  return {
    platform: process.platform,
    home,
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    env,
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    writeFileSync: (file, data, opts) => fs.writeFileSync(file, data, opts),
    mkdirSync: (dir, opts) => fs.mkdirSync(dir, opts),
    unlinkSync: file => fs.unlinkSync(file),
    existsSync: file => fs.existsSync(file),
    readdirSync: dir => fs.readdirSync(dir),
    statSync: file => fs.statSync(file),
    launchctl: (args) => {
      try {
        const stdout = execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout, stderr: '' };
      } catch (error) {
        return {
          code: error.status ?? 1,
          stdout: String(error.stdout ?? ''),
          stderr: String(error.stderr ?? error.message),
        };
      }
    },
    connect: defaultPortProbe,
    fetchImpl: fetch,
    now: Date.now,
    loadEndpoints: envIn => loadLocalLaneConfig(envIn).endpoints,
  };
}

function requireDarwin(deps) {
  if (deps.platform !== 'darwin') fail('tunnel-not-macos: swarm tunnel is only supported on macOS', 'tunnel-not-macos');
}

function assertReadableKey(deps, keyPath) {
  const expanded = keyPath.startsWith('~/') ? path.join(deps.home, keyPath.slice(2)) : keyPath;
  let stat;
  try {
    stat = deps.statSync(expanded);
  } catch {
    fail('tunnel-invalid-key: key path is not readable', 'tunnel-invalid-key');
  }
  if (!stat.isFile()) fail('tunnel-invalid-key: key path must be a regular file', 'tunnel-invalid-key');
  return expanded;
}

export async function tunnelAdd(name, options, depsIn = {}) {
  const deps = { ...defaultTunnelDeps(depsIn.env), ...depsIn };
  requireDarwin(deps);
  validateTunnelName(name);
  const host = validateTunnelHost(options.host);
  const key = assertReadableKey(deps, options.key);
  const localPort = parsePort(options.localPort, '--local-port');
  const remotePort = parsePort(options.remotePort, '--remote-port');
  const remoteHost = options.remoteHost === undefined ? '127.0.0.1' : validateTunnelHost(options.remoteHost);

  const plistPath = tunnelPlistPath(deps.home, name);
  if (deps.existsSync(plistPath)) fail(`tunnel-exists: ${name} is already configured`, 'tunnel-exists');

  const usedPorts = collectTunnelLocalPorts(deps);
  if (usedPorts.has(localPort)) fail(`tunnel-port-busy: local port ${localPort} is used by another swarm tunnel`, 'tunnel-port-busy');
  if (await portAcceptsConnection(localPort, { connect: deps.connect })) {
    fail(`tunnel-port-busy: local port ${localPort} is already in use`, 'tunnel-port-busy');
  }

  const programArguments = buildSshProgramArguments({ key, localPort, remoteHost, remotePort, host });
  const logPath = tunnelLogPath(deps.home, name);
  const plist = buildTunnelPlist({ name, programArguments, logPath });

  deps.mkdirSync(launchAgentsDir(deps.home), { recursive: true });
  deps.mkdirSync(path.dirname(logPath), { recursive: true });
  deps.writeFileSync(plistPath, plist, { mode: 0o644 });

  const domain = `gui/${deps.uid}`;
  const boot = deps.launchctl(['bootstrap', domain, plistPath]);
  if (boot.code !== 0) {
    try { deps.unlinkSync(plistPath); } catch { /* partial install */ }
    fail((boot.stderr || boot.stdout || 'launchctl bootstrap failed').trim(), 'tunnel-launchctl-failed');
  }

  return { name, label: tunnelLabel(name), plistPath, logPath, programArguments };
}

export async function tunnelRemove(name, depsIn = {}) {
  const deps = { ...defaultTunnelDeps(depsIn.env), ...depsIn };
  requireDarwin(deps);
  validateTunnelName(name);
  const plistPath = tunnelPlistPath(deps.home, name);
  const domain = `gui/${deps.uid}`;
  const label = tunnelLabel(name);
  deps.launchctl(['bootout', `${domain}/${label}`]);
  if (deps.existsSync(plistPath)) deps.unlinkSync(plistPath);
  return { name, plistPath, removed: true };
}

async function statusOne(deps, name) {
  const record = readTunnelRecord(deps, name);
  if (!record) return null;
  const domain = `gui/${deps.uid}`;
  const printed = deps.launchctl(['print', `${domain}/${record.label}`]);
  const launch = printed.code === 0 ? parseLaunchctlPrint(printed.stdout) : { state: 'not-loaded', pid: null };
  const localPort = record.forward?.localPort ?? null;
  const portOpen = localPort ? await portAcceptsConnection(localPort, { connect: deps.connect }) : false;
  let logTail = [];
  try {
    logTail = tailLogLines(deps.readFileSync(record.logPath, 'utf8'));
  } catch {
    logTail = [];
  }
  let endpoints = [];
  try {
    endpoints = deps.loadEndpoints(deps.env);
  } catch {
    endpoints = [];
  }
  const reachability = localPort
    ? await endpointReachabilityForPort(localPort, endpoints, { fetchImpl: deps.fetchImpl, now: deps.now })
    : [];
  return {
    ...record,
    launchctl: launch,
    localPortOpen: portOpen,
    logTail,
    reachability,
  };
}

export async function tunnelStatus(name, depsIn = {}) {
  const deps = { ...defaultTunnelDeps(depsIn.env), ...depsIn };
  requireDarwin(deps);
  if (name === undefined || name === null) {
    const names = listTunnelPlists(deps).sort();
    const items = [];
    for (const item of names) items.push(await statusOne(deps, item));
    return { tunnels: items };
  }
  validateTunnelName(name);
  const one = await statusOne(deps, name);
  if (!one) fail(`tunnel-missing: no tunnel named ${name}`, 'tunnel-missing');
  return one;
}

export function parseTunnelFlags(args) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!VALUE_FLAGS.has(key)) fail(`tunnel-usage: unknown flag --${key}`, 'tunnel-usage');
    const value = args[index + 1];
    if (value === undefined) fail(`tunnel-usage: --${key} needs a value`, 'tunnel-usage');
    flags[key] = value;
    index += 1;
  }
  return { positionals, flags };
}

export function formatTunnelStatus(result) {
  if (result.tunnels) {
    return result.tunnels.map(item => formatTunnelStatus(item)).join('\n\n');
  }
  const lines = [
    `${result.name}: state=${result.launchctl.state ?? 'unknown'} pid=${result.launchctl.pid ?? '—'} localPort=${result.forward?.localPort ?? '—'} open=${result.localPortOpen}`,
  ];
  if (result.logTail?.length) lines.push(`log: ${result.logTail.join(' | ')}`);
  for (const ep of result.reachability ?? []) {
    lines.push(`  ${ep.endpoint} GET /v1/models: ${ep.reachable ? 'ok' : 'unreachable'}${ep.httpStatus ? ` (${ep.httpStatus})` : ''}`);
  }
  return lines.join('\n');
}

export function patchZshCompletion(script) {
  const summary = 'Managed SSH tunnels for the local lane (launchd).';
  if (script.includes("'tunnel:")) return script;
  return script
    .replace(
      /(  commands=\(\n)/,
      `$1    'tunnel:${summary}'\n`,
    )
    .replace(
      /(\n    \*\) return ;;)/,
      `\n    tunnel)\n      flags=('add' 'remove' 'status' '--host' '--key' '--local-port' '--remote-port' '--remote-host')\n      argument='none'\n      ;;$1`,
    );
}

export async function runTunnelCommand(args, depsIn = {}) {
  const [verb, ...rest] = args;
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    return { stdout: '', exitCode: 2, usage: true };
  }
  const deps = { ...defaultTunnelDeps(depsIn.env), ...depsIn };
  const out = depsIn.out ?? (text => `${text}\n`);
  try {
    if (verb === 'add') {
      const { positionals, flags } = parseTunnelFlags(rest);
      if (flags.help) return { stdout: '', exitCode: 0, usage: true };
      const name = positionals[0];
      if (!name) fail('tunnel-usage: add requires NAME', 'tunnel-usage');
      if (positionals.length > 1) fail('tunnel-usage: unexpected positional arguments', 'tunnel-usage');
      for (const required of ['host', 'key', 'local-port', 'remote-port']) {
        if (flags[required] === undefined) fail(`tunnel-usage: add requires --${required}`, 'tunnel-usage');
      }
      const added = await tunnelAdd(name, {
        host: flags.host,
        key: flags['key'],
        localPort: flags['local-port'],
        remotePort: flags['remote-port'],
        remoteHost: flags['remote-host'],
      }, deps);
      return { stdout: out(`installed ${added.name} (${added.plistPath})`), exitCode: 0 };
    }
    if (verb === 'remove') {
      const name = rest[0];
      if (!name || name.startsWith('-')) fail('tunnel-usage: remove requires NAME', 'tunnel-usage');
      if (rest.length > 1 && !rest[1].startsWith('-')) fail('tunnel-usage: unexpected arguments', 'tunnel-usage');
      const removed = await tunnelRemove(name, deps);
      return { stdout: out(`removed ${removed.name}`), exitCode: 0 };
    }
    if (verb === 'status') {
      const name = rest[0];
      if (name && name.startsWith('-')) fail('tunnel-usage: unexpected flag', 'tunnel-usage');
      const status = await tunnelStatus(name && !name.startsWith('-') ? name : undefined, deps);
      return { stdout: out(formatTunnelStatus(status)), exitCode: 0 };
    }
    fail(`tunnel-usage: unknown subcommand ${verb}`, 'tunnel-usage');
  } catch (error) {
    const message = error instanceof TunnelError ? error.message : String(error);
    const code = error instanceof TunnelError ? error.code : 'tunnel-error';
    return { stdout: '', stderr: message, exitCode: code === 'tunnel-usage' ? 2 : 1 };
  }
}
