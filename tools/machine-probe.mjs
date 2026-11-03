// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WORKER_LANE_CLIS = Object.freeze(['claude', 'codex', 'gemini', 'opencode', 'cursor-agent']);

export async function defaultRun(command, args = [], options = {}) {
  if (options.input !== undefined) return defaultRunInput(command, args, options);
  try {
    const result = await execFileAsync(command, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, ...options });
    return { code: 0, stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') };
  } catch (error) {
    return { code: typeof error?.code === 'number' ? error.code : 1, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? '') };
  }
}

export function defaultRunInput(command, args = [], { input = '', timeout = 20000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`${command} timed out`), { stdout, stderr, code: 'ETIMEDOUT' })); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; onData?.(String(chunk), 'stdout'); });
    child.stderr.on('data', chunk => { stderr += chunk; onData?.(String(chunk), 'stderr'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve({ stdout, stderr, code }); else reject(Object.assign(new Error(`${command} exited ${code}`), { stdout, stderr, code })); });
    child.stdin.end(input);
  });
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return undefined;
}

export function parseFreeDiskKb(output) {
  const lines = String(output ?? '').trim().split('\n').filter(Boolean);
  const line = lines.at(-1);
  if (!line) return undefined;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return undefined;
  const availableKb = Number(parts[3]);
  return Number.isFinite(availableKb) ? availableKb : undefined;
}

export function parsePmsetBattery(output) {
  const text = String(output ?? '');
  const ac = /AC Power/i.test(text);
  const battery = /Battery Power/i.test(text);
  const percent = /(\d{1,3})%/.exec(text);
  return {
    ...(ac || battery ? { onCharger: ac && !battery } : {}),
    ...(percent ? { batteryPercent: Number(percent[1]) } : {}),
  };
}

export function parsePmsetTherm(output) {
  const text = String(output ?? '');
  const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text);
  const scheduler = /CPU_Scheduler_Limit\s*=\s*(\d+)/.exec(text);
  const result = {};
  if (speed) result.cpuSpeedLimit = Number(speed[1]);
  if (scheduler) result.cpuSchedulerLimit = Number(scheduler[1]);
  if (speed || scheduler) result.throttled = [speed?.[1], scheduler?.[1]].some(value => value !== undefined && Number(value) < 100);
  return result;
}

export function parseSleepSettings(output) {
  const text = String(output ?? '');
  const disablesleep = /disablesleep\s+(\d+)/.exec(text);
  const sleep = /(?:^|\s)sleep\s+(\d+)/m.exec(text);
  return {
    ...(disablesleep ? { disablesleep: Number(disablesleep[1]) === 1 } : {}),
    ...(sleep ? { sleepMinutes: Number(sleep[1]) } : {}),
  };
}

async function runSafe(run, command, args = [], options = {}) {
  try {
    const result = await run(command, args, options);
    return { ok: true, stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? error?.message ?? '') };
  }
}


export function firstIp(output) {
  for (const token of String(output ?? '').split(/\s+/)) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(token) && !token.startsWith('127.')) return token;
  }
  return undefined;
}

export async function localAddresses({ run = defaultRun } = {}) {
  const darwin = (await runSafe(run, 'sh', ['-c', 'ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true'])).stdout;
  const linux = (await runSafe(run, 'sh', ['-c', "hostname -I 2>/dev/null | tr ' ' '\\n' | grep -v '^127\\.' | head -1"])).stdout;
  const ip = firstIp(darwin) ?? firstIp(linux);
  const ts = await runSafe(run, 'tailscale', ['ip', '-4']);
  const tailscaleHost = firstIp(ts.stdout);
  return { ...(ip ? { ip } : {}), ...(tailscaleHost ? { tailscaleHost } : {}) };
}

export function parseLanCLIs(pathList) {
  const seen = new Set();
  for (const line of String(pathList ?? '').split('\n')) {
    const name = line.trim();
    if (!name) continue;
    if (name === 'cursor-agent') seen.add('cursor');
    else if (WORKER_LANE_CLIS.includes(name)) seen.add(name);
  }
  return [...seen];
}

export async function probeLocal({ run = defaultRun, home = os.homedir(), env = process.env, now = Date.now } = {}) {
  const platform = os.platform();
  const addresses = await localAddresses({ run });
  const result = {
    host: os.hostname(),
    ...addresses,
    os: platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : platform,
    arch: os.arch(),
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    cores: os.cpus().length,
    measuredAt: new Date(now()).toISOString(),
  };
  const df = await runSafe(run, 'df', ['-Pk', home]);
  if (df.ok) {
    const availableKb = parseFreeDiskKb(df.stdout);
    if (availableKb !== undefined) result.freeDiskGb = Math.round((availableKb / 1024 ** 2) * 10) / 10;
  }
  const which = await runSafe(run, 'sh', ['-c', 'for c in claude codex gemini opencode cursor-agent; do command -v "$c" 2>/dev/null; done']);
  if (which.ok) result.lanes = parseLanCLIs(which.stdout.replace(/^.*\/([^/]+)$/gm, '$1'));
  if (platform === 'darwin') {
    const batt = await runSafe(run, 'pmset', ['-g', 'batt']);
    if (batt.ok) Object.assign(result, parsePmsetBattery(batt.stdout));
    const therm = await runSafe(run, 'pmset', ['-g', 'therm']);
    if (therm.ok) Object.assign(result, parsePmsetTherm(therm.stdout));
    const custom = await runSafe(run, 'pmset', ['-g', 'custom']);
    if (custom.ok) Object.assign(result, parseSleepSettings(custom.stdout));
    const fv = await runSafe(run, 'fdesetup', ['status']);
    if (fv.ok) result.fileVault = /FileVault is On/i.test(fv.stdout);
    const mem = await runSafe(run, 'memory_pressure', ['-Q']);
    if (mem.ok) {
      const level = /System-wide memory free percentage:\s*(\d+)%/i.exec(mem.stdout);
      const percent = level ? Number(level[1]) : undefined;
      if (percent !== undefined) result.memoryPressure = percent < 10 ? 'hard' : percent < 25 ? 'soft' : 'normal';
    }
    const lid = await runSafe(run, 'sh', ['-c', "ioreg -r -k AppleClamshellState -d 1 2>/dev/null | grep -q 'AppleClamshellState\" = Yes' && echo closed || echo open"]);
    if (lid.ok && /open|closed/.test(lid.stdout)) result.lidOpen = /open/.test(lid.stdout);
    const idle = await runSafe(run, 'sh', ['-c', "ioreg -c IOHIDSystem 2>/dev/null | awk '/HIDIdleTime/ {print $NF; exit}'"]);
    const idleNs = Number(String(idle.stdout ?? '').trim());
    if (Number.isFinite(idleNs) && idleNs >= 0) {
      result.userIdleSeconds = Math.round(idleNs / 1e9);
      result.userActive = result.userIdleSeconds < 120;
    }
  } else if (platform === 'linux') {
    const mem = await runSafe(run, 'sh', ['-c', "free -b | awk '/^Mem:/{print $3, $2}'"]);
    if (mem.ok) {
      const [used, total] = mem.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(used) && Number.isFinite(total) && total > 0) result.memoryPressure = used / total > 0.9 ? 'hard' : used / total > 0.75 ? 'soft' : 'normal';
    }
  }
  const ncWait = platform === 'darwin' ? '-G 1' : '-w 1';
  const ssh = await runSafe(run, 'sh', ['-c', `nc -z ${ncWait} 127.0.0.1 22 >/dev/null 2>&1 && echo on || echo off`]);
  if (ssh.ok) result.remoteLogin = /on/.test(ssh.stdout);
  const screen = await runSafe(run, 'sh', ['-c', `nc -z ${ncWait} 127.0.0.1 5900 >/dev/null 2>&1 && echo on || echo off`]);
  if (screen.ok) result.screenSharing = /on/.test(screen.stdout);
  const runner = await runSafe(run, 'sh', ['-c', "pgrep -f 'swarm.*worker' >/dev/null 2>&1 && echo running || echo stopped"]);
  if (runner.ok) result.runner = /running/.test(runner.stdout) ? 'running' : 'stopped';
  return result;
}

export function remoteProbeScript() {
  return [
    'set -u',
    'emit() { printf "%s=%s\\n" "$1" "$2"; }',
    'emit host "$(hostname)"',
    'case "$(uname -s)" in',
    '  Darwin) emit os macos ;;',
    '  Linux) emit os linux ;;',
    '  *) emit os "$(uname -s)" ;;',
    'esac',
    'emit arch "$(uname -m)"',
    'if [ "$(uname -s)" = Darwin ]; then RIP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true); else RIP=$(hostname -I 2>/dev/null | tr " " "\\n" | grep -v "^127\\." | head -1); fi',
    'if [ -n "$RIP" ]; then emit ip "$RIP"; fi',
    'if [ "$(uname -s)" = Darwin ]; then',
    '  emit ramGb "$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))"',
    '  emit cores "$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"',
    '  emit chip "$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"',
    'else',
    '  emit ramGb "$(( $(awk "/^MemTotal:/{print \\$2}" /proc/meminfo 2>/dev/null || echo 0) / 1048576 ))"',
    '  emit cores "$(nproc 2>/dev/null || echo 0)"',
    'fi',
    'DF=$(df -Pk "$HOME" 2>/dev/null | tail -1 | awk "{print \\$4}")',
    'if [ -n "$DF" ]; then emit freeDiskGb "$(( DF / 1048576 ))"; fi',
    'for c in claude codex gemini opencode cursor-agent; do command -v "$c" 2>/dev/null || true; done | sed "s#.*/##" | while read -r c; do emit lane "$c"; done',
    'if [ "$(uname -s)" = Darwin ]; then',
    '  B=$(pmset -g batt 2>/dev/null || true)',
    '  case "$B" in *"AC Power"*) emit onCharger true ;; *"Battery Power"*) emit onCharger false ;; esac',
    '  P=$(printf "%s" "$B" | sed -n "s/.*[^0-9]\\([0-9][0-9]*\\)%.*/\\1/p" | head -1)',
    '  if [ -n "$P" ]; then emit batteryPercent "$P"; fi',
    '  T=$(pmset -g therm 2>/dev/null || true)',
    '  S=$(printf "%s" "$T" | sed -n "s/.*CPU_Speed_Limit *= *\\([0-9]*\\).*/\\1/p" | head -1)',
    '  if [ -n "$S" ]; then emit cpuSpeedLimit "$S"; fi',
    '  C=$(pmset -g custom 2>/dev/null || true)',
    '  D=$(printf "%s" "$C" | sed -n "s/.*disablesleep *\\([0-9]*\\).*/\\1/p" | head -1)',
    '  if [ -n "$D" ]; then emit disablesleep "$D"; fi',
    '  FL=$(pmset -g custom 2>/dev/null | sed -n "s/^ *sleep *\\([0-9][0-9]*\\).*/\\1/p" | head -1)',
    '  if [ -n "$FL" ]; then emit sleepMinutes "$FL"; fi',
    '  if fdesetup status 2>/dev/null | grep -q "FileVault is On"; then emit fileVault true; else emit fileVault false; fi',
    'fi',
    'NCW="-w 1"; if [ "$(uname -s)" = Darwin ]; then NCW="-G 1"; fi',
    'if nc -z $NCW 127.0.0.1 22 >/dev/null 2>&1; then emit remoteLogin true; else emit remoteLogin false; fi',
    'if [ "$(uname -s)" = Darwin ]; then if nc -z $NCW 127.0.0.1 5900 >/dev/null 2>&1; then emit screenSharing true; else emit screenSharing false; fi; fi',
    'if pgrep -f "swarm.*worker" >/dev/null 2>&1; then emit runner running; else emit runner stopped; fi',
  ].join('\n');
}

export function parseRemoteProbe(stdout) {
  const result = { lanes: [] };
  for (const line of String(stdout ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (key === 'lane') { if (value) result.lanes.push(value === 'cursor-agent' ? 'cursor' : value); continue; }
    if (['ramGb', 'cores', 'freeDiskGb', 'batteryPercent', 'cpuSpeedLimit'].includes(key)) {
      const n = number(value);
      if (n !== undefined) result[key] = n;
    } else if (['onCharger', 'lidOpen', 'fileVault', 'remoteLogin', 'screenSharing', 'disablesleep'].includes(key)) {
      const b = bool(value);
      if (b !== undefined) result[key] = b;
    } else if (key === 'sleepMinutes') {
      const n = number(value);
      if (n !== undefined) result.sleepMinutes = n;
    } else if (['host', 'os', 'arch', 'chip', 'runner', 'ip', 'tailscaleHost'].includes(key) && value) {
      result[key] = value;
    }
  }
  result.lanes = [...new Set(result.lanes)];
  return result;
}

export function sshProbeArgv(machine, { batch = true } = {}) {
  const key = machine.key ?? path.join(os.homedir(), '.ssh', 'swarm_ed25519');
  return [
    'ssh', '-T',
    ...(batch ? ['-o', 'BatchMode=yes'] : []),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes',
    '-i', key,
    '--', `${machine.user}@${machine.host}`, 'sh -s',
  ];
}

export async function probeRemote(machine, { run = defaultRunInput, script = remoteProbeScript(), now = Date.now } = {}) {
  const argv = sshProbeArgv(machine);
  const command = argv[0];
  const args = argv.slice(1);
  const result = await run(command, args, { timeout: 20000, input: `${script}\n` });
  return { ...parseRemoteProbe(result?.stdout), measuredAt: new Date(now()).toISOString() };
}

export function measuredOnly(machine) {
  const out = {};
  for (const [key, value] of Object.entries(machine ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
