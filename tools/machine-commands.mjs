// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  addMachine, acquireBrainLock, brainPointerFile, failoverOrder, machinesFile, MACHINE_HOST_RE, MACHINE_NAME_RE, nextBrain,
  readBrainPointer, readRegistry, releaseBrainLock, removeMachine, setBrain, withRegistryLock, withoutStaleMeasurements, writeBrainPointer, writeRegistry,
} from './machine-registry.mjs';
import { measuredOnly, parseRemoteProbe, probeLocal, probeRemote, defaultRun, defaultRunInput, sshProbeArgv, localAddresses, WORKER_LANE_CLIS } from './machine-probe.mjs';
import { laneLoginHint, laneLoginFiles, WORKER_LANE_NAMES } from './lane-plugins.mjs';
import {
  brainDiskState, BRAIN_DISK_CLEAN_GB, BRAIN_DISK_WARN_GB,
  claimWorkerItem, clearFinishedWorkerItems, diskGuard, enqueueManifest, listWorkerItems, nextWorkerItem,
  pauseWorkerQueue, releaseExpiredWorkerItems, renewWorkerItem, reportWorkerItem, resumeWorkerQueue, workerPauseFile, workerQueueFile, workerQueuePaused,
} from './worker-queue.mjs';
import {
  cleanWorktrees, createSshTransport, ensureRepo, executeItem, laptopGate, laptopState, mirrorRepo, readWorkerLanes, runWorkerOnce, slotsForMachine, tuneSlots, workerPaths,
} from './worker-runner.mjs';
import { projectSwarmHome } from './machine-registry.mjs';
import { loadMachineLocalConfig } from './machine-local-config.mjs';
import { snapshotProjectState, snapshotCatalog, machineStateDir, restoreProjectState } from './state-sync.mjs';
import { runBench, benchSummary } from './worker-bench.mjs';
import { listProjects, projectsFile } from './projects.mjs';

export const MACHINE_USAGE = [
  'Usage:',
  '  swarm machine add <user>@<host> [--name NAME] [--role worker|both|brain] [--slots N] [--filevault warn|fail] [--capabilities docker,tmux] [--key PATH] [--register-only]',
  '  swarm machine rollback <name> [--forget]   restore the snapshot machine add took before changing the target',
  '  swarm machine login <name>',
  '  swarm machine doctor [name]',
  '  swarm machine list [--no-probe]',
  '  swarm machine remove <name>',
  '  swarm remote setup <user>@<brain-host>',
  '  swarm attach',
  '  swarm screen <name>',
  '  swarm brain move <name> [--force] | swarm brain watch | swarm brain status',
  '  swarm worker queue add <manifest> [--project P] [--lane L] | queue list | sweep',
  '  swarm worker next --lanes a,b | claim ID --holder H | renew ID --holder H | report ID --holder H --report B',
  '  swarm worker run [--once] | install | status | bench <manifest> [--workers N]',
].join('\n') + '\n';

export const WORKER_USAGE = [
  'Usage:',
  '  swarm worker queue add <manifest> [--project P] [--lane L] | list | sweep | clear | resume',
  '  swarm worker next --lanes a,b [--machine NAME] [--json]',
  '  swarm worker claim ID --holder H | renew ID --holder H | report ID --holder H --report B',
  '  swarm worker run [--once] | mirror <name> <repo-path> | bench <manifest> [--workers N] [--work-ms N]',
  '  swarm worker install | status',
].join('\n') + '\n';

const out = text => ({ stdout: text, exitCode: 0 });
const bad = (text, code = 1) => ({ stdout: text, exitCode: code });

function flag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return { value: undefined, rest: args };
  return { value: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

function flagBool(args, name) {
  const at = args.indexOf(name);
  return { value: at !== -1, rest: at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 1)] };
}

function sanitize(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500);
}

export function parseTarget(target) {
  const match = /^([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*)$/.exec(String(target ?? ''));
  if (!match) return null;
  return { user: match[1], host: match[2].replace(/\.local$/, '') };
}

function nameFromHost(host) {
  return host.replace(/\.local$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export function sshCommandArgv(target, command, { key, tty = false } = {}) {
  return [
    'ssh', ...(tty ? ['-tt'] : ['-T']),
    ...(tty ? [] : ['-o', 'BatchMode=yes']),
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
    '-i', key, '--', `${target.user}@${target.host}`, command,
  ];
}

export function spawnInherit(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', () => resolve(1));
    child.on('close', code => resolve(code ?? 1));
  });
}

export async function ensureKey(key, { run = spawnInherit } = {}) {
  try { await fs.stat(key); return { created: false, key }; } catch {}
  const code = await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `swarm@${os.hostname()}`, '-f', key]);
  if (code !== 0) throw Object.assign(new Error(`could not create ${key}`), { code: 'machine-key-failed' });
  return { created: true, key };
}

export async function copyKey(target, key, { run = spawnInherit } = {}) {
  const code = await run('ssh-copy-id', ['-i', `${key}.pub`, '-o', 'StrictHostKeyChecking=accept-new', `${target.user}@${target.host}`]);
  if (code !== 0) throw Object.assign(new Error(`could not install the key on ${target.host}; run ssh-copy-id by hand`), { code: 'machine-key-copy-failed' });
  return true;
}

async function keyWorks(target, key, { run = defaultRun } = {}) {
  try {
    const argv = sshCommandArgv(target, 'true', { key });
    const result = await run(argv[0], argv.slice(1), { timeout: 12000 });
    return result?.code === 0;
  } catch { return false; }
}

export async function syncRunner({ target, key, installRoot, home = os.homedir(), run = defaultRun, version } = {}) {
  let runnerVersion = version;
  if (!runnerVersion) {
    try { runnerVersion = JSON.parse(await fs.readFile(path.join(installRoot, 'package.json'), 'utf8')).version; } catch { runnerVersion = 'current'; }
  }
  const remoteHome = `.project-swarm/versions/${runnerVersion}`;
  const mkdir = await run('ssh', sshCommandArgv(target, 'mkdir -p "$HOME/.project-swarm/versions"', { key }).slice(1), { timeout: 30000 });
  if (mkdir.code !== 0) throw Object.assign(new Error(`could not create the runner folder: ${String(mkdir.stderr ?? '').trim()}`), { code: 'machine-runner-sync-failed' });
  const argv = ['rsync', '-a', '--delete', '--timeout=600', '-e', `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -i ${key}`, `${installRoot}/`, `${target.user}@${target.host}:~/${remoteHome}/`];
  const result = await run(argv[0], argv.slice(1), { timeout: 10 * 60 * 1000 });
  if (result.code !== 0) throw Object.assign(new Error(`runner sync failed: ${String(result.stderr ?? '').trim()}`), { code: 'machine-runner-sync-failed' });
  const link = `mkdir -p ~/.project-swarm && ln -sfn "$HOME/${remoteHome}" ~/.project-swarm/current`;
  const linked = await run('ssh', sshCommandArgv(target, link, { key }).slice(1), { timeout: 30000 });
  if (linked.code !== 0) throw Object.assign(new Error(`runner link failed: ${String(linked.stderr ?? '').trim()}`), { code: 'machine-runner-link-failed' });
  return { version: runnerVersion, path: `~/${remoteHome}` };
}

export async function readBootstrapScript() {
  return fs.readFile(new URL('./machine-bootstrap.sh', import.meta.url), 'utf8');
}

// Snapshot the target once, before machine add changes anything, and leave a single script the
// owner can run to put the machine back (services, current symlink, PATH line, power, pointer).
export function rollbackSnapshotScript() {
  return [
    'set -u',
    'R="$HOME/swarm-worker/rollback"',
    'mkdir -p "$R"',
    'if [ ! -f "$R/.prepared" ]; then',
    '  date -u +%Y-%m-%dT%H:%M:%SZ > "$R/prepared-at"',
    '  [ -f "$HOME/.zshenv" ] && cp "$HOME/.zshenv" "$R/zshenv.before" || true',
    '  if [ -f "$HOME/.project-swarm/brain.json" ]; then cp "$HOME/.project-swarm/brain.json" "$R/brain.json.before"; fi',
    '  if [ -e "$HOME/.project-swarm/current" ] || [ -L "$HOME/.project-swarm/current" ]; then readlink "$HOME/.project-swarm/current" > "$R/current.before" 2>/dev/null || true; fi',
    '  for L in com.project-swarm.worker com.project-swarm.brainwatch; do',
    '    if [ -f "$HOME/Library/LaunchAgents/$L.plist" ]; then cp "$HOME/Library/LaunchAgents/$L.plist" "$R/$L.plist.before"; fi',
    '  done',
    '  pmset -g custom > "$R/pmset.before" 2>/dev/null || true',
    '  scutil --get ComputerName > "$R/computername.before" 2>/dev/null || true',
    '  scutil --get LocalHostName > "$R/localhostname.before" 2>/dev/null || true',
    '  scutil --get HostName > "$R/hostname.before" 2>/dev/null || true',
    '  touch "$R/.prepared"',
    'fi',
    `cat > "$HOME/swarm-worker/rollback.sh" <<'SWARM_ROLLBACK'`,
    '#!/bin/bash',
    'set -u',
    'R="$HOME/swarm-worker/rollback"',
    'say() { printf "rollback: %s\n" "$*"; }',
    'for L in com.project-swarm.worker com.project-swarm.brainwatch; do',
    '  launchctl bootout "gui/$(id -u)/$L" >/dev/null 2>&1 || true',
    '  if [ -f "$R/$L.plist.before" ]; then',
    '    cp "$R/$L.plist.before" "$HOME/Library/LaunchAgents/$L.plist"',
    '    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$L.plist" >/dev/null 2>&1 || true',
    '  else',
    '    rm -f "$HOME/Library/LaunchAgents/$L.plist"',
    '  fi',
    'done',
    'say "worker services restored"',
    'if [ -f "$R/current.before" ]; then',
    '  OLD="$(cat "$R/current.before")"',
    '  if [ -n "$OLD" ] && [ -d "$OLD" ]; then ln -sfn "$OLD" "$HOME/.project-swarm/current"; say "current -> $OLD"; else rm -f "$HOME/.project-swarm/current"; say "current removed"; fi',
    'fi',
    'if [ -f "$R/zshenv.before" ]; then cp "$R/zshenv.before" "$HOME/.zshenv"; else',
    '  if [ -f "$HOME/.zshenv" ]; then grep -v "# swarm-worker" "$HOME/.zshenv" > "$HOME/.zshenv.rollback" || true; mv "$HOME/.zshenv.rollback" "$HOME/.zshenv"; fi',
    'fi',
    'say "PATH restored"',
    'if [ -f "$R/brain.json.before" ]; then cp "$R/brain.json.before" "$HOME/.project-swarm/brain.json"; else rm -f "$HOME/.project-swarm/brain.json"; fi',
    'say "brain pointer restored"',
    'if [ -f "$R/pmset.before" ]; then',
    '  if grep -q "disablesleep *1" "$R/pmset.before"; then sudo -n pmset -a disablesleep 1 >/dev/null 2>&1 || true; else sudo -n pmset -a disablesleep 0 >/dev/null 2>&1 || true; fi',
    '  AC=$(awk "/^AC Power:/{ac=1;next}/^Battery Power:/{ac=0} ac&&/^ *sleep /{print \$2; exit}" "$R/pmset.before")',
    '  BAT=$(awk "/^AC Power:/{ac=1;next}/^Battery Power:/{ac=0} !ac&&/^ *sleep /{print \$2; exit}" "$R/pmset.before")',
    '  [ -n "$AC" ] && sudo -n pmset -c sleep "$AC" >/dev/null 2>&1 || true',
    '  [ -n "$BAT" ] && sudo -n pmset -b sleep "$BAT" >/dev/null 2>&1 || true',
    '  say "power settings restored"',
    'fi',
    'if [ -f "$R/computername.before" ]; then sudo -n scutil --set ComputerName "$(cat "$R/computername.before")" >/dev/null 2>&1 || true; fi',
    'if [ -f "$R/localhostname.before" ]; then sudo -n scutil --set LocalHostName "$(cat "$R/localhostname.before")" >/dev/null 2>&1 || true; fi',
    'if [ -f "$R/hostname.before" ]; then sudo -n scutil --set HostName "$(cat "$R/hostname.before")" >/dev/null 2>&1 || true; fi',
    'say "done. Installed brew packages and lane CLIs were left in place."',
    'SWARM_ROLLBACK',
    'chmod +x "$HOME/swarm-worker/rollback.sh"',
    'printf "ROLLBACK_READY %s\n" "$HOME/swarm-worker/rollback.sh"',
  ].join('\n');
}

export async function prepareRollback({ target, key, run = defaultRunInput } = {}) {
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${rollbackSnapshotScript()}\n`, timeout: 60000 });
  if (result?.code !== 0) throw Object.assign(new Error(`rollback snapshot failed: ${String(result?.stderr ?? '').trim()}`), { code: 'machine-rollback-prepare-failed' });
  return { script: '$HOME/swarm-worker/rollback.sh' };
}

export async function runMachineRollback(name, { env = process.env, home = os.homedir(), run = defaultRunInput, forget = false, startBrain = true } = {}) {
  if (!MACHINE_NAME_RE.test(name)) return bad(`invalid machine name ${name}\n`);
  const file = machinesFile({ env, home });
  const registry = await readRegistry({ file, env, home });
  const machine = registry.machines[name];
  if (!machine) return bad(`unknown machine ${name}\n`);
  const target = { user: machine.user, host: machine.host };
  const key = path.join(home, '.ssh', 'swarm_ed25519');
  const argv = sshCommandArgv(target, 'bash "$HOME/swarm-worker/rollback.sh"', { key });
  const result = await run(argv[0], argv.slice(1), { timeout: 120000 });
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  if (result?.code !== 0) return bad(`rollback failed on ${name}: ${sanitize(stderr || stdout)}\n`);
  if (forget) await removeMachine(name, { file, env, home });
  return out(`${stdout}${stderr ? `\n${stderr}` : ''}${forget ? `removed ${name} from the registry\n` : ''}`);
}

export async function runBootstrap({ target, key, name, role, slots, capabilities = [], brainHost, brainUser, run = defaultRunInput, onProgress = null } = {}) {
  const mode = role === 'remote+worker' || role === 'both' ? 'both' : 'worker';
  const head = [
    `export SWARM_MACHINE_NAME=${JSON.stringify(name)}`,
    `export SWARM_MACHINE_MODE=${JSON.stringify(mode)}`,
    `export SWARM_MACHINE_HOST=${JSON.stringify(target.host)}`,
    ...(Number.isInteger(slots) ? [`export SWARM_MACHINE_SLOTS=${JSON.stringify(String(slots))}`] : []),
    ...(capabilities.length ? [`export SWARM_MACHINE_CAPABILITIES=${JSON.stringify(capabilities.join(','))}`] : []),
    `export SWARM_BRAIN_HOST=${JSON.stringify(brainHost ?? '')}`,
    `export SWARM_BRAIN_USER=${JSON.stringify(brainUser ?? '')}`,
  ].join('\n');
  const script = `${head}\n${await readBootstrapScript()}`;
  const argv = sshCommandArgv(target, 'bash -s', { key, tty: false });
  let buffer = '';
  const onData = onProgress ? chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onProgress(line);
  } : undefined;
  const result = await run(argv[0], argv.slice(1), { input: script, timeout: 30 * 60 * 1000, onData });
  if (buffer.trim()) onProgress?.(buffer.trim());
  const stdout = String(result.stdout ?? '');
  if (!/MACHINE_SETUP_OK/.test(stdout)) throw Object.assign(new Error(`bootstrap did not finish: ${stdout.slice(-800)}`), { code: 'machine-bootstrap-failed' });
  return { stdout, warnings: stdout.split('\n').filter(line => /WARN/.test(line)) };
}

export function workerServicePlist({ runner, machine, brainHost, brainUser, key, home }) {
  const args = ['/usr/bin/env', 'node', runner, 'worker', 'run'];
  const env = {
    PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${path.posix.join(home, '.local', 'node', 'bin')}:${path.posix.join(home, '.local', 'bin')}:/usr/bin:/bin`,
    SWARM_WORKER_NAME: machine,
    ...(brainHost ? { SWARM_BRAIN_HOST: brainHost } : {}),
    ...(brainUser ? { SWARM_BRAIN_USER: brainUser } : {}),
    SWARM_SSH_KEY: path.posix.join(home, '.ssh', 'swarm_ed25519'),
  };
  return {
    Label: 'com.project-swarm.worker',
    ProgramArguments: args,
    EnvironmentVariables: env,
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: path.join(home, 'swarm-worker', 'logs', 'worker.log'),
    StandardErrorPath: path.join(home, 'swarm-worker', 'logs', 'worker.err.log'),
    WorkingDirectory: home,
  };
}

export function plistXml(plist) {
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const env = Object.entries(plist.EnvironmentVariables ?? {}).map(([key, value]) => `    <key>${escape(key)}</key>\n    <string>${escape(value)}</string>`).join('\n');
  const args = (plist.ProgramArguments ?? []).map(value => `    <string>${escape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escape(plist.Label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><${plist.RunAtLoad ? 'true' : 'false'}/>
  <key>KeepAlive</key><${plist.KeepAlive ? 'true' : 'false'}/>
  <key>StandardOutPath</key><string>${escape(plist.StandardOutPath)}</string>
  <key>StandardErrorPath</key><string>${escape(plist.StandardErrorPath)}</string>
  <key>WorkingDirectory</key><string>${escape(plist.WorkingDirectory)}</string>
</dict>
</plist>
`;
}

export async function installWorkerService({ target, key, machine, brain, run = defaultRun, home }) {
  const targetHome = home ?? `/Users/${target.user}`;
  const runner = path.posix.join(targetHome, '.project-swarm', 'current', 'tools', 'swarm.mjs');
  const plist = workerServicePlist({ runner, machine, brainHost: brain?.host, brainUser: brain?.user, key: path.posix.join(targetHome, '.ssh', 'swarm_ed25519'), home: targetHome });
  const encoded = Buffer.from(plistXml(plist)).toString('base64');
  const script = [
    'set -e',
    'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/swarm-worker/logs"',
    `printf '%s' ${JSON.stringify(encoded)} | base64 -d > "$HOME/Library/LaunchAgents/com.project-swarm.worker.plist"`,
    'launchctl bootout "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 || true',
    'for i in 1 2 3; do launchctl print "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 || break; sleep 1; done',
    'if ! launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.project-swarm.worker.plist"; then',
    '  launchctl print "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 || { echo WORKER_SERVICE_FAILED; exit 5; }',
    'fi',
    'launchctl kickstart -k "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 || true',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 120000 });
  if (result.code !== 0) throw Object.assign(new Error(`worker service install failed: ${String(result.stderr ?? '').trim()}`), { code: 'worker-service-failed' });
  return { installed: true };
}


export function brainWatchPlist({ runner, home }) {
  return {
    Label: 'com.project-swarm.brainwatch',
    ProgramArguments: ['/usr/bin/env', 'node', runner, 'brain', 'watch'],
    EnvironmentVariables: { PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${path.posix.join(home, '.local', 'node', 'bin')}:${path.posix.join(home, '.local', 'bin')}:/usr/bin:/bin` },
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: path.join(home, 'swarm-worker', 'logs', 'brainwatch.log'),
    StandardErrorPath: path.join(home, 'swarm-worker', 'logs', 'brainwatch.err.log'),
    WorkingDirectory: home,
  };
}

export async function installBrainWatchService({ target, key, run = defaultRun, home }) {
  const targetHome = home ?? `/Users/${target.user}`;
  const plist = brainWatchPlist({ runner: path.posix.join(targetHome, '.project-swarm', 'current', 'tools', 'swarm.mjs'), home: targetHome });
  const encoded = Buffer.from(plistXml(plist)).toString('base64');
  const script = [
    'set -e',
    'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/swarm-worker/logs"',
    `printf '%s' ${JSON.stringify(encoded)} | base64 -d > "$HOME/Library/LaunchAgents/com.project-swarm.brainwatch.plist"`,
    'launchctl bootout "gui/$(id -u)/com.project-swarm.brainwatch" >/dev/null 2>&1 || true',
    'for i in 1 2 3; do launchctl print "gui/$(id -u)/com.project-swarm.brainwatch" >/dev/null 2>&1 || break; sleep 1; done',
    'if ! launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.project-swarm.brainwatch.plist"; then',
    '  launchctl print "gui/$(id -u)/com.project-swarm.brainwatch" >/dev/null 2>&1 || { echo BRAINWATCH_SERVICE_FAILED; exit 5; }',
    'fi',
    'launchctl kickstart -k "gui/$(id -u)/com.project-swarm.brainwatch" >/dev/null 2>&1 || true',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 120000 });
  if (result.code !== 0) throw Object.assign(new Error(`brain watchdog install failed: ${String(result.stderr ?? '').trim()}`), { code: 'brainwatch-service-failed' });
  return { installed: true };
}

export async function removeBrainWatchService({ target, key, run = defaultRun } = {}) {
  const script = [
    'set -u',
    'launchctl bootout "gui/$(id -u)/com.project-swarm.brainwatch" >/dev/null 2>&1 || true',
    'rm -f "$HOME/Library/LaunchAgents/com.project-swarm.brainwatch.plist"',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 30000 });
  return { removed: result?.code === 0 };
}

export async function installWorkerServiceLinux({ target, key, machine, brain, run = defaultRun }) {
  const unit = `[Unit]
Description=Project Swarm worker (${machine})
After=network-online.target

[Service]
ExecStart=/usr/bin/env node %h/.project-swarm/current/tools/swarm.mjs worker run
Restart=always
RestartSec=5
Environment=SWARM_WORKER_NAME=${machine}${brain?.host ? `\nEnvironment=SWARM_BRAIN_HOST=${brain.host}` : ''}${brain?.user ? `\nEnvironment=SWARM_BRAIN_USER=${brain.user}` : ''}

[Install]
WantedBy=default.target
`;
  const encoded = Buffer.from(unit).toString('base64');
  const script = [
    'set -e',
    'mkdir -p "$HOME/.config/systemd/user" "$HOME/swarm-worker/logs"',
    `printf '%s' ${JSON.stringify(encoded)} | base64 -d > "$HOME/.config/systemd/user/project-swarm-worker.service"`,
    'systemctl --user daemon-reload',
    'systemctl --user enable --now project-swarm-worker.service',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 120000 });
  if (result.code !== 0) throw Object.assign(new Error(`systemd worker install failed: ${String(result.stderr ?? '').trim()}`), { code: 'worker-service-failed' });
  return { installed: true };
}

export async function probeMachine(name, { registry, run = defaultRunInput, home = os.homedir(), env = process.env, now = Date.now, local = false } = {}) {
  const machine = registry.machines[name];
  if (!machine) throw Object.assign(new Error(`machine ${name} is not registered`), { code: 'machine-unknown' });
  const addresses = await localAddresses({ run: defaultRun }).catch(() => ({}));
  const localNames = new Set([os.hostname(), os.hostname().replace(/\.local$/, ''), addresses.ip, addresses.tailscaleHost].filter(Boolean));
  const hostnameMatches = os.hostname().toLowerCase().includes(String(machine.name ?? '').toLowerCase());
  if (local || hostnameMatches || localNames.has(machine.host) || (machine.ip && localNames.has(machine.ip))) {
    const local = await probeLocal({ run: defaultRun, home, env, now });
    return { ...machine, ...local, health: 'ok', host: local.ip ?? machine.host, ip: local.ip ?? machine.ip ?? machine.host };
  }
  const probed = await probeRemote({ ...machine, key: path.join(home, '.ssh', 'swarm_ed25519') }, { run, now });
  return { ...machine, ...probed, host: machine.host, ip: machine.ip ?? machine.host };
}

export function doctorLines(machine, { laneChecks = true } = {}) {
  const lines = [];
  const add = (ok, text) => lines.push(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  const warn = text => lines.push(`WARN ${text}`);
  const reachable = machine.health !== 'unreachable';
  add(reachable, `ssh ${machine.user}@${machine.host}`);
  if (!reachable) {
    for (const label of ['sleep settings', 'FileVault', 'Remote Login', 'Screen Sharing', 'worker runner', 'free disk', 'memory pressure', 'power', 'CPU throttling', 'lanes']) lines.push(`unknown ${label} (unreachable)`);
    return lines;
  }
  if (machine.os === 'macos') {
    const sleepBits = [];
    if (machine.disablesleep !== undefined) sleepBits.push(`SleepDisabled=${machine.disablesleep ? 1 : 0}`);
    if (machine.sleepMinutes !== undefined) sleepBits.push(`AC sleep=${machine.sleepMinutes}`);
    if (machine.disksleepMinutes !== undefined) sleepBits.push(`AC disksleep=${machine.disksleepMinutes}`);
    const sleepDetail = sleepBits.length ? ` (${sleepBits.join(', ')})` : '';
    if (machine.role === 'remote+worker') {
      add(machine.disablesleep === false, `sleep settings${sleepDetail}${machine.disablesleep === true ? ' (remote+worker must sleep with the lid closed and on battery)' : ''}`);
    } else {
      const sleepOk = machine.disablesleep === true
        && (machine.sleepMinutes === undefined || machine.sleepMinutes === 0)
        && (machine.disksleepMinutes === undefined || machine.disksleepMinutes === 0);
      add(sleepOk, `sleep settings${sleepDetail}`);
    }
    if (machine.fileVault === true) {
      // A carried laptop, or a machine the owner explicitly keeps encrypted, warns; a full-time worker fails.
      const text = 'FileVault is on (a reboot waits for the password at the machine)';
      if (machine.role === 'remote+worker' || machine.fileVaultPolicy === 'warn') warn(`${text}; owner keeps FileVault on`);
      else add(false, text);
    } else if (machine.fileVaultPolicy === 'warn') {
      warn('FileVault off (owner wants FileVault on this machine)');
    } else {
      add(true, 'FileVault off');
    }
  }
  if (machine.os === 'macos') {
    add(machine.remoteLogin === true, machine.remoteLogin ? 'Remote Login on' : 'Remote Login off: turn it on by hand');
    add(machine.screenSharing === true, machine.screenSharing ? 'Screen Sharing on' : 'Screen Sharing off: turn it on by hand');
  } else {
    add(machine.health !== 'unreachable', machine.health !== 'unreachable' ? 'ssh server reachable' : 'ssh server unreachable');
  }
  add(machine.runner === 'running', machine.runner === 'running' ? 'worker runner alive' : 'worker runner stopped: swarm worker install');
  if (Number.isFinite(machine.freeDiskGb)) {
    if (machine.role === 'brain') {
      const disk = brainDiskState(machine.freeDiskGb);
      if (disk.state === 'clean') warn(`free disk ${machine.freeDiskGb} GB (brain: auto-clean under ${BRAIN_DISK_CLEAN_GB} GB)`);
      else if (disk.state === 'warn') warn(`free disk ${machine.freeDiskGb} GB (brain: warn under ${BRAIN_DISK_WARN_GB} GB)`);
      else lines.push(`ok   free disk ${machine.freeDiskGb} GB`);
    } else {
      add(machine.freeDiskGb >= 20, `free disk ${machine.freeDiskGb} GB`);
    }
  }
  if (machine.memoryPressure) add(machine.memoryPressure !== 'hard', `memory pressure ${machine.memoryPressure}`);
  if (machine.onCharger !== undefined) {
    const power = `power ${machine.onCharger ? 'charger' : 'battery'}${machine.batteryPercent !== undefined ? ` ${machine.batteryPercent}%` : ''}`;
    if (!machine.onCharger && machine.role === 'remote+worker') warn(`${power} (normal for a carried laptop; takes no new work)`);
    else add(machine.onCharger || machine.role !== 'remote+worker', power);
  }
  if (machine.throttled !== undefined) add(!machine.throttled, machine.throttled ? 'CPU is throttling' : 'CPU not throttling');
  if (laneChecks) {
    const lanes = machine.lanes ?? [];
    add(lanes.length > 0, lanes.length ? `lanes ${lanes.join(', ')}` : 'no lane CLIs found');
  }
  return lines;
}

export async function listMachines({ registry, run = defaultRunInput, home = os.homedir(), env = process.env, now = Date.now, probe = false, persistFile = null } = {}) {
  const rows = [];
  let dirty = false;
  for (const name of failoverOrder(registry)) {
    const machine = registry.machines[name];
    if (!machine) continue;
    let data = machine;
    if (probe || name === registry.brain) {
      data = await probeMachine(name, { registry, run, home, env, now }).catch(error => ({ ...machine, health: 'unreachable', error: error.message }));
      data = { ...data, measuredAt: data.measuredAt ?? new Date(now()).toISOString() };
      if (persistFile) {
        registry.machines[name] = { ...machine, ...measuredOnly(data), updatedAt: new Date(now()).toISOString() };
        dirty = true;
      }
    }
    // Without a live probe, hide every measured value older than the freshness window.
    const fresh = withoutStaleMeasurements(data, { now: now() });
    const fields = [
      name === registry.brain ? '*' : ' ',
      name,
      fresh.role,
      fresh.host,
      fresh.os ?? '?',
      fresh.ramGb !== undefined ? `${fresh.ramGb}GB` : null,
      fresh.slots !== undefined ? `${fresh.slots}` : null,
      Array.isArray(fresh.lanes) && fresh.lanes.length ? fresh.lanes.join(',') : null,
      fresh.health ?? null,
      fresh.freeDiskGb !== undefined ? `${fresh.freeDiskGb}GB` : null,
      fresh.stale ? 'stale' : fresh.role === 'remote+worker' ? laptopState(fresh) : null,
    ].filter(value => value !== null && value !== undefined);
    rows.push(fields.join('\t'));
  }
  if (dirty && persistFile) await writeRegistry(registry, { file: persistFile, env, home });
  return rows.length ? `${rows.join('\n')}\n` : 'no machines registered\n';
}


export async function lockSshToKey({ target, key, run = defaultRunInput } = {}) {
  const script = [
    'set -e',
    'if [ -f /etc/ssh/sshd_config.d/000-swarm-keyonly.conf ] && grep -qi "^PasswordAuthentication no" /etc/ssh/sshd_config.d/000-swarm-keyonly.conf; then echo SSH_KEY_ONLY; exit 0; fi',
    'sudo -n true >/dev/null 2>&1 || { echo "NEED_SUDO"; exit 3; }',
    'sudo mkdir -p /etc/ssh/sshd_config.d',
    'printf "PasswordAuthentication no\nKbdInteractiveAuthentication no\nChallengeResponseAuthentication no\n" | sudo tee /etc/ssh/sshd_config.d/000-swarm-keyonly.conf >/dev/null',
    'sudo chmod 644 /etc/ssh/sshd_config.d/000-swarm-keyonly.conf',
    'sudo launchctl kickstart -k system/com.openssh.sshd >/dev/null 2>&1 || true',
    'if ! grep -q "^Include /etc/ssh/sshd_config.d/\*" /etc/ssh/sshd_config; then echo VERIFY_FAILED; exit 5; fi',
    'echo SSH_KEY_ONLY',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key, tty: false });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 60000 });
  const stdout = String(result.stdout ?? '');
  if (/SSH_KEY_ONLY/.test(stdout)) return { keyOnly: true };
  if (/NEED_SUDO/.test(stdout)) throw Object.assign(new Error('SSH key-only needs one sudo password on the target; run it by hand'), { code: 'ssh-key-only-sudo' });
  throw Object.assign(new Error(`SSH key-only failed: ${stdout.slice(-300)}`), { code: 'ssh-key-only-failed' });
}


export function gitMirrorShellScript() {
  return [
    '#!/bin/sh',
    'cmd="${SSH_ORIGINAL_COMMAND:-}"',
    'set -- $cmd',
    'service="${1:-}"; repo="${2:-}"',
    'repo="$(printf "%s" "$repo" | tr -d "\'")"',
    'case "$service" in git-upload-pack|git-receive-pack|git-upload-archive) ;; *) echo "git-mirror-shell: denied" >&2; exit 1 ;; esac',
    'case "$repo" in *.git) ;; *) echo "git-mirror-shell: denied" >&2; exit 1 ;; esac',
    'case "$repo" in */*|..*|"") echo "git-mirror-shell: denied" >&2; exit 1 ;; esac',
    'cd "$HOME/.project-swarm/mirrors" || exit 1',
    'exec "$service" "$repo"',
  ].join('\n') + '\n';
}

export async function ensureWorkerKey({ target, key, name, run = defaultRunInput, home = os.homedir(), runner, node = process.execPath } = {}) {
  const script = [
    'set -e',
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    `if [ ! -f "$HOME/.ssh/swarm_ed25519" ]; then ssh-keygen -t ed25519 -N "" -C "swarm-worker@${name}" -f "$HOME/.ssh/swarm_ed25519" >/dev/null; fi`,
    `if [ ! -f "$HOME/.ssh/swarm_git_ed25519" ]; then ssh-keygen -t ed25519 -N "" -C "swarm-git@${name}" -f "$HOME/.ssh/swarm_git_ed25519" >/dev/null; fi`,
    'cat "$HOME/.ssh/swarm_ed25519.pub"',
    'cat "$HOME/.ssh/swarm_git_ed25519.pub"',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 60000 });
  const pubs = String(result.stdout ?? '').trim().split('\n').filter(line => /^ssh-ed25519 [A-Za-z0-9+/=]+/.test(line));
  const pub = pubs[0];
  const gitPub = pubs[1];
  if (!pub || !gitPub) throw Object.assign(new Error('worker key generation failed'), { code: 'worker-key-failed' });
  const dir = path.join(home, '.ssh');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const binDir = path.join(home, '.project-swarm', 'bin');
  const shellFile = path.join(binDir, 'git-mirror-shell');
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(shellFile, gitMirrorShellScript(), { mode: 0o755 });
  await fs.chmod(shellFile, 0o755).catch(() => {});
  const authFile = path.join(dir, 'authorized_keys');
  const existing = await fs.readFile(authFile, 'utf8').catch(() => '');
  const forced = `command="${node} ${runner ?? path.join(home, '.project-swarm', 'current', 'tools', 'swarm.mjs')} worker-rpc --machine ${name}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ${pub}`;
  const gitForced = `command="${shellFile}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc ${gitPub}`;
  const kept = existing.split('\n').filter(line => !line.includes(pub) && !line.includes(gitPub));
  kept.push(forced, gitForced);
  await fs.writeFile(authFile, `${kept.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
  await fs.chmod(authFile, 0o600).catch(() => {});
  return { pub, gitPub, forced, gitForced };
}

export async function writeWorkerBrainPointer({ target, key, brain, name, run = defaultRunInput } = {}) {
  const payload = JSON.stringify({ host: brain.host, user: brain.user, machine: name, hosts: brainHostList(brain), epoch: brain.epoch ?? 0 });
  const script = `mkdir -p "$HOME/.project-swarm" && printf '%s\\n' '${payload}' > "$HOME/.project-swarm/brain.json" && chmod 600 "$HOME/.project-swarm/brain.json"`;
  const argv = sshCommandArgv(target, script, { key });
  const result = await run(argv[0], argv.slice(1), { timeout: 30000 });
  if (result.code !== 0) throw Object.assign(new Error('brain pointer write failed'), { code: 'brain-pointer-failed' });
  return { payload };
}

export async function runMachineAdd(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now, run = defaultRunInput, runShell = defaultRun, interactive = spawnInherit, installRoot = path.resolve('.') } = deps;
  let rest = [...args];
  const nameFlag = flag(rest, '--name'); rest = nameFlag.rest;
  const roleFlag = flag(rest, '--role'); rest = roleFlag.rest;
  const slotsFlag = flag(rest, '--slots'); rest = slotsFlag.rest;
  const fileVaultFlag = flag(rest, '--filevault'); rest = fileVaultFlag.rest;
  const capabilitiesFlag = flag(rest, '--capabilities'); rest = capabilitiesFlag.rest;
  const keyFlag = flag(rest, '--key'); rest = keyFlag.rest;
  const registerOnly = rest.includes('--register-only');
  rest = rest.filter(arg => arg !== '--register-only');
  const target = parseTarget(rest[0]);
  if (!target) return bad(`${MACHINE_USAGE}`);
  const name = nameFlag.value ?? nameFromHost(target.host);
  if (!MACHINE_NAME_RE.test(name)) return bad(`invalid machine name ${name}\n`);
  const slotsOverride = slotsFlag.value === undefined ? null : Number(slotsFlag.value);
  if (slotsOverride !== null && (!Number.isInteger(slotsOverride) || slotsOverride < 0 || slotsOverride > 256)) return bad('--slots must be an integer 0-256 (0 for a brain-only machine)\n');
  if (fileVaultFlag.value !== undefined && !['warn', 'fail'].includes(fileVaultFlag.value)) return bad('--filevault must be warn or fail\n');
  const capabilities = capabilitiesFlag.value === undefined ? [] : capabilitiesFlag.value.split(',').map(value => value.trim()).filter(Boolean);
  if (capabilities.some(cap => !/^[a-z0-9-]{1,32}$/.test(cap))) return bad('--capabilities must be lowercase names separated by commas\n');
  const fleet = loadMachineLocalConfig({ env, home, override: deps.machineConfig });
  // Laptops listed in the local machine config default to remote+worker: charger + lid open, back off while active.
  const role = roleFlag.value === 'both' || roleFlag.value === 'remote+worker' || (!roleFlag.value && fleet.laptops.includes(name)) ? 'remote+worker' : roleFlag.value === 'brain' ? 'brain' : 'worker';
  // Machines listed in fileVaultWarn keep FileVault on; warn, do not fail, even as full-time workers.
  const fileVaultPolicy = fileVaultFlag.value ?? (fleet.fileVaultWarn.includes(name) && role === 'worker' ? 'warn' : undefined);
  const key = keyFlag.value ?? path.join(home, '.ssh', 'swarm_ed25519');
  try {
    process.stderr.write(`machine add: checking key for ${target.user}@${target.host}...\n`);
    const keyState = await ensureKey(key, { run: interactive });
    if (!(await keyWorks(target, key, { run: runShell }))) await copyKey(target, key, { run: interactive });
    process.stderr.write(`machine add: key works; checking the remote prepped state...\n`);
    const stableRunner = path.join(home, '.project-swarm', 'current', 'tools', 'swarm.mjs');
    const brainRunner = await fs.stat(stableRunner).then(() => stableRunner, () => path.join(installRoot, 'tools', 'swarm.mjs'));
    await ensureWorkerKey({ target, key, name, run, runner: brainRunner }).catch(() => null);
    const before = await probeRemote({ ...target, key }, { run, now }).catch(() => null);
    const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
    const brainBase = role === 'brain' ? { host: target.host, user: target.user } : registry.brain ? registry.machines[registry.brain] : { host: os.hostname(), user: os.userInfo().username };
    const brain = { ...brainBase, hosts: brainHostList(brainBase), epoch: registry.epoch ?? 0 };
    const brainName = role === 'brain' ? name : (registry.brain ?? fleet.brainName);
    let runnerWarning = null;
    let bootstrap = { warnings: [] };
    if (!registerOnly) {
      process.stderr.write(`machine add: writing the one-command rollback on ${target.host}...\n`);
      try { await prepareRollback({ target, key, run }); }
      catch (error) { return bad(`machine add stopped before changing anything: ${sanitize(error.message)}\n`); }
      process.stderr.write(`machine add: syncing the runner to ${target.host} (timeout 10m)...\n`);
      try { await syncRunner({ target, key, installRoot, home, run: runShell }); }
      catch (error) { runnerWarning = `WARN ${error.message}`; }
      bootstrap = await runBootstrap({ target, key, name, role, slots: slotsOverride, capabilities, brainHost: brain?.host, brainUser: brain?.user, run });
      if (runnerWarning) bootstrap.warnings.push(runnerWarning);
    }
    process.stderr.write(`machine add: probing ${target.host}...\n`);
    const probed = await probeRemote({ ...target, key }, { run, now }).catch(() => before ?? {});
    const machine = measuredOnly({
      name,
      role,
      ...probed,
      host: target.host,
      ip: target.host,
      user: target.user,
      os: probed.os ?? before?.os,
      arch: probed.arch,
      chip: probed.chip,
      ramGb: probed.ramGb,
      cores: probed.cores,
      slots: slotsOverride ?? (probed.ramGb >= 16 ? 4 : probed.ramGb >= 8 ? 2 : 1),
      lanes: probed.lanes ?? before?.lanes ?? [],
      health: probed.host ? 'ok' : 'unreachable',
      freeDiskGb: probed.freeDiskGb,
      memoryPressure: probed.memoryPressure,
      batteryPercent: probed.batteryPercent,
      onCharger: probed.onCharger,
      lidOpen: probed.lidOpen,
      disablesleep: probed.disablesleep,
      fileVault: probed.fileVault,
      remoteLogin: probed.remoteLogin,
      screenSharing: probed.screenSharing,
      runner: probed.runner,
      ...(registerOnly ? { setup: 'pending' } : { setup: 'ready' }),
      ...(fileVaultPolicy ? { fileVaultPolicy } : {}),
      ...(capabilities.length ? { capabilities } : {}),
      lastSeen: new Date(now()).toISOString(),
    });
    await addMachine(machine, { file: deps.registryFile ?? machinesFile({ env, home }), env, home, brain: role === 'brain' });
    await updateSshConfigForMachine({ name, host: target.host, user: target.user, key, home }).catch(() => null);
    // Keep every worker's registry copy current so `swarm session list/attach` works away from the brain.
    await pushFile({ target, key, name: 'machines.json', data: await fs.readFile(deps.registryFile ?? machinesFile({ env, home }), 'utf8'), run }).catch(() => null);
    const after = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
    if (!after.brain) {
      const localHost = os.hostname().toLowerCase();
      const localName = fleet.brainHostHint && localHost.includes(String(fleet.brainHostHint).toLowerCase()) ? fleet.brainName : nameFromHost(os.hostname());
      const localProbe = await probeLocal({ run: deps.runShell ?? defaultRun, home, env, now }).catch(() => ({}));
      const localSlots = localProbe.ramGb >= 16 ? 4 : localProbe.ramGb >= 8 ? 2 : 1;
      await addMachine(measuredOnly({ name: localName, role: 'brain', host: os.hostname().replace(/\.local$/, ''), user: os.userInfo().username, slots: localSlots, ...localProbe }), { file: deps.registryFile ?? machinesFile({ env, home }), env, home, brain: true });
    }
    if (role === 'remote+worker') {
      try { await lockSshToKey({ target, key, run }); }
      catch (error) { bootstrap.warnings.push(`WARN ${error.message}`); }
    }
    if (role !== 'brain') {
      try { await writeWorkerBrainPointer({ target, key, brain, name: brainName, run }); }
      catch (error) { bootstrap.warnings.push(`WARN ${error.message}`); }
    }
    if (!registerOnly && role !== 'brain') {
      process.stderr.write(`machine add: installing the worker service on ${target.host}...\n`);
      try {
        if ((probed.os ?? 'macos') === 'linux') await installWorkerServiceLinux({ target, key, machine: name, brain, run: runShell });
        else {
          await installWorkerService({ target, key, machine: name, brain, run: runShell, home: `/Users/${target.user}` });
          await removeBrainWatchService({ target, key, run: runShell, home: `/Users/${target.user}` }).catch(() => null);
        }
      } catch (error) {
        bootstrap.warnings.push(`WARN ${error.message}`);
      }
    }
    const warnings = bootstrap.warnings.length ? `\n${bootstrap.warnings.join('\n')}` : '';
    const lanes = machine.lanes ?? [];
    return out(`machine ${name} ${registerOnly ? 'registered (setup pending: run the same command with the target password to finish)' : 'ready'}: ${target.user}@${target.host} · ${machine.slots} slots · lanes ${lanes.length ? lanes.join(', ') : 'none yet'}${keyState.created ? ' · key created' : ''}${warnings}\n`);
  } catch (error) {
    return bad(`machine add failed: ${sanitize(error.message)}\n`);
  }
}

export async function runMachineLogin(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now } = deps;
  const name = args[0];
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const machine = registry.machines[name];
  if (!machine) return bad(`unknown machine ${name ?? ''}\n`);
  const probed = await probeMachine(name, { registry, home, env, now, run: deps.run }).catch(error => ({ ...machine, error: error.message }));
  const missing = WORKER_LANE_NAMES.filter(lane => !(probed.lanes ?? []).includes(lane));
  const lines = [`machine ${name} (${machine.user}@${machine.host})`];
  if (!missing.length) lines.push('all lane CLIs are installed');
  for (const lane of missing) lines.push(`${lane}: ${laneLoginHint(lane)}`);
  const loginFiles = [];
  for (const lane of WORKER_LANE_NAMES) for (const file of laneLoginFiles(lane, home)) loginFiles.push(`${lane}\t${file}`);
  if (missing.length) lines.push('', 'login (run on that machine):');
  for (const lane of missing) lines.push(`  ${laneLoginHint(lane)}`);
  lines.push('', `screen: swarm screen ${name}`);
  if (deps.openScreen !== false) await openScreen(name, { registry, env, home, run: deps.runShell ?? defaultRun }).catch(() => {});
  return out(`${lines.join('\n')}\n`);
}


export function doctorFixScript(machine) {
  const lines = ['set -u'];
  if (machine.os === 'macos' && machine.role === 'worker' && machine.disablesleep !== true) {
    lines.push('sudo -n pmset -a disablesleep 1 >/dev/null 2>&1 && sudo -n pmset -c sleep 0 >/dev/null 2>&1 && echo FIXED sleep || echo MANUAL sleep');
  }
  if (machine.os === 'macos' && machine.role === 'worker') {
    lines.push('V=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo missing); if [ "$V" = "0" ]; then echo FIXED updates; else sudo -n defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false >/dev/null 2>&1 && echo FIXED updates || echo MANUAL updates; fi');
  }
  if (machine.runner && machine.runner !== 'running') {
    lines.push('launchctl kickstart -k "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 && echo FIXED runner || echo MANUAL runner');
  }
  if (machine.role === 'brain' && Number.isFinite(machine.freeDiskGb) && machine.freeDiskGb < BRAIN_DISK_CLEAN_GB) {
    // Caches and old logs only. Worktrees are left to the owner's worktree rules (never a dirty or unpushed one).
    lines.push('B=$(df -Pk "$HOME" | awk \'NR==2{print $4}\')');
    lines.push('command -v brew >/dev/null 2>&1 && brew cleanup -s >/dev/null 2>&1 || true');
    lines.push('command -v npm >/dev/null 2>&1 && npm cache clean --force >/dev/null 2>&1 || true');
    lines.push('command -v uv >/dev/null 2>&1 && uv cache clean >/dev/null 2>&1 || true');
    lines.push('rm -rf "$HOME/.cache/uv" "$HOME/.cache/codex-runtimes" "$HOME/.cache/puppeteer" "$HOME/.npm/_npx" 2>/dev/null || true');
    lines.push('find "$HOME/actions-runner/_diag" -type f -name "*.log" -mtime +2 -delete 2>/dev/null || true');
    lines.push('A=$(df -Pk "$HOME" | awk \'NR==2{print $4}\'); echo "FIXED disk freed $((A-B)) KB"');
  }
  if (Number.isFinite(machine.freeDiskGb) && machine.freeDiskGb < 20 && machine.role !== 'brain') {
    lines.push('find "$HOME/swarm-worker/worktrees" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null && echo FIXED worktrees || echo MANUAL worktrees');
  }
  return lines.join('\n');
}

export async function applyDoctorFixes(name, machine, { run = defaultRunInput, key, home = os.homedir() } = {}) {
  const script = doctorFixScript(machine);
  if (script.split('\n').length <= 1) return [];
  const target = { user: machine.user, host: machine.host };
  const argv = sshCommandArgv(target, 'bash -s', { key: key ?? path.join(home, '.ssh', 'swarm_ed25519') });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 120000 }).catch(error => ({ code: 1, stdout: '', stderr: error.message }));
  return String(result.stdout ?? '').split('\n').filter(line => /^(FIXED|MANUAL) /.test(line)).map(line => `${line.startsWith('FIXED') ? 'fixed' : 'by hand'}: ${line.slice(6)}`);
}

export async function runMachineDoctor(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now } = deps;
  const nameArg = args[0];
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const names = nameArg ? [nameArg] : failoverOrder(registry);
  const lines = [];
  for (const name of names) {
    if (!registry.machines[name]) { lines.push(`unknown machine ${name}`); continue; }
    const machine = await probeMachine(name, { registry, home, env, now, run: deps.run }).catch(error => ({ ...registry.machines[name], health: 'unreachable', error: error.message }));
    lines.push(`== ${name} ==`);
    lines.push(...doctorLines(machine));
    if (!args.includes('--check')) {
      const fixes = await applyDoctorFixes(name, machine, { run: deps.run ?? defaultRunInput, key: path.join(home, '.ssh', 'swarm_ed25519'), home });
      lines.push(...fixes.map(line => `fix  ${line}`));
    }
    if (name === registry.brain) lines.push(`ok   brain: ${name}`);
  }
  return out(`${lines.join('\n')}\n`);
}

export async function runMachineList(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now } = deps;
  const file = deps.registryFile ?? machinesFile({ env, home });
  const registry = await readRegistry({ file, env, home });
  // Live by default so disk and health can never be shown from an old snapshot. --no-probe is the quick view.
  const probe = !args.includes('--no-probe');
  const text = await listMachines({ registry, home, env, now, probe, persistFile: file, run: deps.run });
  return out(`  name\trole\thost\tos\tram\tslots\tlanes\thealth\tdisk\tstate\n${text}`);
}

export async function runMachineRemove(args, deps = {}) {
  const { env = process.env, home = os.homedir() } = deps;
  const name = args[0];
  if (!name) return bad(`${MACHINE_USAGE}`);
  const result = await removeMachine(name, { file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  if (!result.removed) return bad(`unknown machine ${name}\n`);
  return out(`removed ${name} from the registry; SSH keys on that machine are unchanged\n`);
}

export async function openScreen(name, { registry, env = process.env, home = os.homedir(), run = defaultRun } = {}) {
  const machine = registry.machines[name];
  if (!machine) throw new Error(`unknown machine ${name}`);
  const port = 15900 + Math.floor(Math.random() * 500);
  const brain = registry.machines[registry.brain];
  const key = path.join(home, '.ssh', 'swarm_ed25519');
  const via = brain && brain.name !== name ? { host: brain.host, user: brain.user } : null;
  const dest = machine.host;
  const sshArgs = [
    '-fN', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'ExitOnForwardFailure=yes', '-i', key,
    '-L', `${port}:${dest}:5900`,
    '--', via ? `${via.user}@${via.host}` : `${machine.user}@${machine.host}`,
  ];
  const result = await run('ssh', sshArgs, { timeout: 30000 }).catch(error => ({ code: 1, stderr: error.message }));
  if (result.code !== 0 && !via) {
    const direct = await run('ssh', sshArgs.slice(0, -2).concat(['--', `${machine.user}@${machine.host}`]), { timeout: 30000 }).catch(error => ({ code: 1, stderr: error.message }));
    if (direct.code !== 0) throw new Error(`screen tunnel failed: ${String(direct.stderr ?? '').trim()}`);
  }
  await run('open', [`vnc://localhost:${port}`], { timeout: 15000 });
  return { port, url: `vnc://localhost:${port}` };
}

export async function runScreen(args, deps = {}) {
  if (args.includes('--help') || args.includes('-h')) return out('Usage: swarm screen <name>\n');
  const { env = process.env, home = os.homedir() } = deps;
  const name = args[0];
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  if (!name) return bad(`Usage: swarm screen <name>\n`);
  try {
    const result = await openScreen(name, { registry, env, home, run: deps.runShell ?? defaultRun });
    return out(`screen ${name}: ${result.url}\n`);
  } catch (error) { return bad(`${sanitize(error.message)}\n`); }
}


export const SESSION_USAGE = [
  'Usage:',
  '  swarm session start <machine> <repo> [name] [--model M]   (or: swarm session start <repo> [name] -- uses sessionDefaults from the local machine config)',
  '  swarm session list',
  '  swarm session attach <name>',
].join('\n') + '\n';

const safeSession = value => String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';

function muxKind(platform) { return platform === 'linux' ? 'tmux' : 'tmux'; }

async function sessionRepo({ target, machine, repoArg, key, home, run = defaultRunInput, session }) {
  const source = path.isAbsolute(repoArg) ? repoArg : path.join(home, 'Developer', repoArg);
  const repoName = path.basename(repoArg).replace(/[^A-Za-z0-9._-]/g, '-');
  await run('git', ['-C', source, 'fetch', '--prune', 'origin'], { timeout: 120000 }).catch(() => null);
  const remote = machine.role === 'brain' ? (path.isAbsolute(repoArg) ? repoArg : `$HOME/Developer/${repoName}`) : `$HOME/${repoName}`;
  const check = await run('ssh', sshCommandArgv(target, `test -d "${remote}/.git" && echo yes || echo no`, { key }).slice(1), { timeout: 30000 });
  if (!String(check.stdout ?? '').includes('yes')) {
    await fs.mkdir(path.join(home, '.project-swarm', 'mirrors'), { recursive: true, mode: 0o700 });
    const mirror = await mirrorRepo({ source, name: repoName, home }).catch(error => { throw Object.assign(new Error(`mirror failed: ${error.message}`), { code: 'session-mirror-failed' }); });
    const mkdir = await run('ssh', sshCommandArgv(target, 'mkdir -p "$HOME/.project-swarm/mirrors"', { key }).slice(1), { timeout: 30000 });
    if (mkdir.code !== 0) throw Object.assign(new Error('could not create the mirror folder on the target'), { code: 'session-target-failed' });
    const sync = await run('rsync', ['-a', '--delete', '-e', `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${key}`, `${mirror.dir}/`, `${target.user}@${target.host}:~/.project-swarm/mirrors/${repoName}.git/`], { timeout: 30 * 60 * 1000 });
    if (sync.code !== 0) throw Object.assign(new Error(`mirror copy failed: ${String(sync.stderr ?? '').trim()}`), { code: 'session-mirror-copy-failed' });
    const clone = await run('ssh', sshCommandArgv(target, `set -e; git clone "$HOME/.project-swarm/mirrors/${repoName}.git" "${remote}"; if [ -f "${remote}/package-lock.json" ]; then cd "${remote}" && npm ci --no-audit --no-fund; fi`, { key }).slice(1), { timeout: 45 * 60 * 1000 });
    if (clone.code !== 0) throw Object.assign(new Error(`repo setup failed: ${String(clone.stderr ?? '').trim().split('\n').at(-1)}`), { code: 'session-repo-failed' });
  } else if (machine.role !== 'brain') {
    // Refresh the brain mirror and the worker clone so the session worktree starts from latest master.
    const mirror = await mirrorRepo({ source, name: repoName, home }).catch(() => null);
    if (mirror) await run('rsync', ['-a', '--delete', '-e', `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${key}`, `${mirror.dir}/`, `${target.user}@${target.host}:~/.project-swarm/mirrors/${repoName}.git/`], { timeout: 30 * 60 * 1000 }).catch(() => null);
  }
  // A fresh worktree per session, based on the latest master, never the clone's current branch.
  const sessionBranch = `session/${session}`;
  const worktree = machine.role === 'brain' ? `$HOME/${repoName}-sessions/${session}` : `$HOME/${repoName}-sessions/${session}`;
  const base = `set -e; cd "${remote}"; git fetch --prune origin; BASE=origin/master; git rev-parse --verify "$BASE" >/dev/null 2>&1 || BASE=origin/main; mkdir -p "$(dirname "${worktree}")"; if [ -d "${worktree}/.git" ]; then cd "${worktree}" && git fetch origin && git reset --hard "$BASE"; else git worktree add -B "${sessionBranch}" "${worktree}" "$BASE"; fi; git -C "${remote}" checkout master >/dev/null 2>&1 || git -C "${remote}" checkout main >/dev/null 2>&1 || true; echo "${worktree}"`;
  const result = await run('ssh', sshCommandArgv(target, 'bash -s', { key }).slice(1), { input: `${base}\n`, timeout: 120000 });
  if (result.code !== 0) throw Object.assign(new Error(`session worktree failed: ${String(result.stderr ?? '').trim().split('\n').at(-1)}`), { code: 'session-worktree-failed' });
  return String(result.stdout ?? '').trim().split('\n').at(-1);
}

export async function runSessionCommand(args, deps = {}) {
  const { env = process.env, home = os.homedir(), run = defaultRunInput, runShell = defaultRun } = deps;
  const [verb, ...rest] = args;
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const key = path.join(home, '.ssh', 'swarm_ed25519');
  const brain = await currentBrain({ env, home });
  const local = await probeLocal({ run: runShell, home, env, now: Date.now }).catch(() => ({}));
  const localNames = new Set([os.hostname(), os.hostname().replace(/\.local$/, ''), local.ip].filter(Boolean));
  const onBrain = Boolean(brain && (localNames.has(brain.host) || os.hostname().toLowerCase().includes(String(brain.name ?? '').toLowerCase())));
  const adminKey = path.join(home, '.ssh', 'swarm_admin_ed25519');
  if (verb === 'start') {
    const modelFlag = flag(rest, '--model'); const givenModel = modelFlag.value; const words = modelFlag.rest;
    let machineName = words[0];
    let repoArg = words[1];
    let name = words[2];
    if (machineName && !registry.machines[machineName]) { repoArg = words[0]; name = words[1]; machineName = loadMachineLocalConfig({ env: deps.env ?? process.env, home: deps.home, override: deps.machineConfig }).sessionDefaults?.[path.basename(repoArg ?? '')] ?? registry.brain; }
    if (!machineName || !repoArg) return bad(SESSION_USAGE);
    const machine = registry.machines[machineName];
    if (!machine) return bad(`unknown machine ${machineName}\n`);
    if (machine.role === 'brain') return bad(`refusing to start a new session on the brain (${machineName}); use a worker\n`);
    const session = safeSession(name ?? `${path.basename(repoArg)}-${machineName}`);
    if (!onBrain) {
      const wordsOut = [machineName, repoArg, session, ...(givenModel ? ['--model', givenModel] : [])].map(value => `'${String(value).replace(/'/g, "'\\''")}'`).join(' ');
      const delegated = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', adminKey, '--', `${brain.user}@${brain.host}`, `zsh -lc 'swarm session start ${wordsOut}'`], { timeout: 600000 });
      return { stdout: String(delegated.stdout ?? ''), exitCode: delegated.code ?? 1 };
    }
    const model = givenModel ?? loadMachineLocalConfig({ env: deps.env ?? process.env, home: deps.home, override: deps.machineConfig }).sessionModels?.[path.basename(repoArg)];
    try {
      process.stderr.write(`session start: preparing ${repoArg} on ${machineName}...\n`);
      const target = { user: machine.user, host: machine.host };
      const repo = await sessionRepo({ target, machine, repoArg, key, home, run, session });
      if (model) {
        const cfg = JSON.stringify({ '$schema': 'https://opencode.ai/config.json', model }, null, 2);
        const enc = JSON.stringify(Buffer.from(cfg).toString('base64'));
        const setup = `printf '%s' ${enc} | base64 -d > "${repo}/opencode.json"; EX=$(git -C "${repo}" rev-parse --git-path info/exclude); mkdir -p "$(dirname "$EX")"; grep -qx opencode.json "$EX" 2>/dev/null || echo opencode.json >> "$EX"`;
        await run('ssh', sshCommandArgv(target, setup, { key }).slice(1), { timeout: 30000 }).catch(() => null);
      }
      const stack = await run('ssh', sshCommandArgv(target, 'bash -s', { key }).slice(1), { input: `set -u; cd "${repo}"; if [ -f supabase/config.toml ]; then export PATH="$HOME/.local/bin:$PATH"; SUP="supabase"; command -v supabase-2 >/dev/null 2>&1 && SUP=supabase-2; $SUP start 2>&1 | tail -5 || echo "STACK_START_FAILED"; else echo "NO_SUPABASE_CONFIG"; fi\n`, timeout: 600000 }).catch(() => null);
      if (stack && String(stack.stdout ?? '').includes('STACK_START_FAILED')) process.stderr.write(`session start: warning: local Supabase stack failed for ${repoArg}\n`);
      const cmd = 'opencode';
      const script = `set -e; cd ${repo}; if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${session} 2>/dev/null && { echo "session ${session} already running"; exit 0; }; tmux new-session -d -s ${session} '${cmd.replace(/'/g, "'\\''")}'; elif command -v screen >/dev/null 2>&1; then screen -ls | grep -q "[.]${session}[[:space:]]" && { echo "session ${session} already running"; exit 0; }; screen -dmS ${session} sh -c '${cmd.replace(/'/g, "'\\''")}'; else echo "no tmux or screen on ${machineName}"; exit 4; fi; echo "started ${session} in ${repo}"`;
      const result = await run('ssh', sshCommandArgv(target, 'bash -s', { key }).slice(1), { input: `${script}\n`, timeout: 120000 });
      if (result.code !== 0) return bad(`session start failed: ${sanitize(String(result.stderr || result.stdout).trim())}\n`);
      return out(String(result.stdout ?? ''));
    } catch (error) { return bad(`session start failed: ${sanitize(error.message)}\n`); }
  }
  if (verb === 'list') {
    if (!onBrain) {
      const remote = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', adminKey, '--', `${brain.user}@${brain.host}`, "zsh -lc 'swarm session list --json'"], { timeout: 60000 }).catch(error => ({ code: 1, stderr: error.message }));
      if (remote.code !== 0) return bad(`brain ${brain.user}@${brain.host} unreachable: ${sanitize(String(remote.stderr || remote.stdout).trim())}\n`);
      let delegated = [];
      try { delegated = JSON.parse(String(remote.stdout ?? '[]')); } catch { return bad('brain returned an unreadable session list\n'); }
      if (deps.json) return out(`${JSON.stringify(delegated)}\n`);
      return out(delegated.length ? delegated.map(row => `${row.machine}\t${row.session}\t${row.cwd ?? ''}`).join('\n') + '\n' : 'no sessions\n');
    }
    const rows = [];
    const errors = [];
    for (const name of failoverOrder(registry)) {
      const machine = registry.machines[name];
      if (!machine) continue;
      const target = { user: machine.user, host: machine.host };
      const script = 'if command -v tmux >/dev/null 2>&1; then tmux ls -F "#{session_name}|#{session_path}|#{session_created}" 2>/dev/null; elif command -v screen >/dev/null 2>&1; then screen -ls 2>/dev/null | sed -n "s/^[[:space:]]*[0-9][0-9]*\\.\\([^[:space:]]*\\).*/\\1/p" | while read -r s; do printf "%s||screen\\n" "$s"; done; fi';
      const result = await run('ssh', sshCommandArgv(target, 'bash -s', { key }).slice(1), { input: `${script}\n`, timeout: 20000 }).catch(error => ({ code: 1, stderr: error.message, stdout: '' }));
      if (result.code !== 0) { errors.push(`${name}: ${sanitize(String(result.stderr || 'unreachable').trim())}`); continue; }
      for (const line of String(result.stdout ?? '').split('\n').filter(Boolean)) { const [session, cwd, created] = line.split('|'); if (session) rows.push({ machine: name, session, cwd: cwd || null, created: Number(created) || null }); }
    }
    if (deps.json) return out(`${JSON.stringify(rows)}\n`);
    const lines = rows.map(row => `${row.machine}\t${row.session}\t${row.cwd ?? ''}`);
    if (errors.length) lines.push(...errors.map(error => `unreachable: ${error}`));
    return out(lines.length ? `${lines.join('\n')}\n` : 'no sessions\n');
  }
  if (verb === 'attach') {
    const name = rest[0];
    if (!name) return bad('Usage: swarm session attach <name>\n');
    if (!onBrain) {
      const code = await (deps.runInteractive ?? spawnInherit)('ssh', ['-t', '-o', 'StrictHostKeyChecking=accept-new', '-i', adminKey, '--', `${brain.user}@${brain.host}`, `zsh -lc 'swarm session attach ${safeSession(name)}'`]);
      return { stdout: '', exitCode: code };
    }
    for (const nameKey of failoverOrder(registry)) {
      const machine = registry.machines[nameKey];
      if (!machine) continue;
      const target = { user: machine.user, host: machine.host };
      const has = await run('ssh', sshCommandArgv(target, `if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${safeSession(name)} >/dev/null 2>&1 && echo tmux || true; elif command -v screen >/dev/null 2>&1; then screen -ls 2>/dev/null | grep -q "[.]${safeSession(name)}[[:space:]]" && echo screen || true; fi`, { key }).slice(1), { timeout: 20000 }).catch(() => ({ stdout: '' }));
      const mux = String(has.stdout ?? '').includes('tmux') ? 'tmux' : String(has.stdout ?? '').includes('screen') ? 'screen' : null;
      if (mux) {
        const remote = mux === 'tmux' ? `tmux attach -t ${safeSession(name)}` : `screen -r ${safeSession(name)}`;
        const code = await (deps.runInteractive ?? spawnInherit)('ssh', ['-t', '-o', 'StrictHostKeyChecking=accept-new', '-i', key, '--', `${machine.user}@${machine.host}`, remote]);
        return { stdout: '', exitCode: code };
      }
    }
    return bad(`session ${name} not found on any machine\n`);
  }
  return out(SESSION_USAGE);
}

export async function currentBrain({ env = process.env, home = os.homedir() } = {}) {
  const pointer = await readBrainPointer({ env, home }).catch(() => null);
  const registry = await readRegistry({ file: machinesFile({ env, home }), env, home }).catch(() => null);
  const registered = registry?.brain ? registry.machines[registry.brain] : null;
  if (!pointer && !registered) return null;
  return {
    name: registry?.brain ?? pointer?.machine ?? loadMachineLocalConfig({ env, home }).brainName,
    host: pointer?.host ?? registered?.host,
    user: pointer?.user ?? registered?.user,
    hosts: [...new Set([pointer?.host, ...(Array.isArray(pointer?.hosts) ? pointer.hosts : []), registered?.host].filter(Boolean))],
    epoch: pointer?.epoch ?? registry?.epoch ?? 0,
  };
}

export async function runAttach(args, deps = {}) {
  if (args.includes('--help') || args.includes('-h')) return out('Usage: swarm attach [machine]\n');
  const { env = process.env, home = os.homedir() } = deps;
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const name = args[0] ?? registry.brain;
  const current = name === registry.brain ? await currentBrain({ env, home }) : null;
  const machine = current ? { ...registry.machines[name], host: current.host, user: current.user } : registry.machines[name];
  if (!machine && args[0]) {
    const joined = await runSessionCommand(['attach', args[0]], { env, home, runInteractive: deps.runInteractive });
    return joined;
  }
  if (!machine) return bad(`unknown brain ${name ?? ''}\n`);
  const key = await fs.stat(path.join(home, '.ssh', 'swarm_admin_ed25519')).then(() => path.join(home, '.ssh', 'swarm_admin_ed25519'), () => path.join(home, '.ssh', 'swarm_ed25519'));
  // Make sure the brain's swarm session exists before attaching; a dead one otherwise shows [exited].
  const ensure = await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', key, '--', `${machine.user}@${machine.host}`, `zsh -lc 'command -v tmux >/dev/null 2>&1 || { echo NO_TMUX; exit 4; }; tmux has-session -t swarm 2>/dev/null || tmux new-session -d -s swarm "exec zsh -l"'`], { timeout: 30000 });
  if (ensure.code !== 0) return bad(`could not start the brain's swarm session: ${sanitize(String(ensure.stderr || ensure.stdout).trim())}\n`);
  const argv = [
    'ssh', '-t', '-o', 'StrictHostKeyChecking=accept-new', '-i', key,
    '--', `${machine.user}@${machine.host}`, 'zsh -lc "tmux attach -t swarm"',
  ];
  const code = await (deps.runInteractive ?? spawnInherit)(argv[0], argv.slice(1));
  return { stdout: '', exitCode: code };
}

export async function runRemoteSetup(args, deps = {}) {
  const { env = process.env, home = os.homedir() } = deps;
  const parsed = parseTarget(args[0]);
  if (!parsed) return bad(`Usage: swarm remote setup <user>@<brain-host>\n`);
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const brain = await currentBrain({ env, home });
  const target = { user: brain?.user ?? parsed.user, host: brain?.host ?? parsed.host };
  const adminKey = path.join(home, '.ssh', 'swarm_admin_ed25519');
  const workerKey = path.join(home, '.ssh', 'swarm_ed25519');
  const key = await fs.stat(adminKey).then(() => adminKey, () => workerKey);
  await ensureKey(key, { run: deps.runInteractive ?? spawnInherit });
  if (!(await keyWorks(target, key, { run: deps.runShell ?? defaultRun }))) {
    // Never ssh-copy-id with the worker-rpc key; it is deliberately forced to one command.
    if (key === workerKey) throw Object.assign(new Error('the worker key cannot open a shell on the brain; authorize ~/.ssh/swarm_admin_ed25519 on the brain from the brain itself'), { code: 'remote-setup-admin-key' });
    await copyKey(target, key, { run: deps.runInteractive ?? spawnInherit });
  }
  const brainHost = target.host;
  const brainUser = target.user;
  const alias = loadMachineLocalConfig({ env: deps.env ?? process.env, home, override: deps.machineConfig }).brainName;
  const lines = [
    `Host ${alias}`,
    `  HostName ${brainHost}`,
    `  User ${brainUser}`,
    `  IdentityFile ${key}`,
    `  IdentitiesOnly yes`,
    `  StrictHostKeyChecking accept-new`,
    `  ServerAliveInterval 30`,
    `  ControlMaster auto`,
    `  ControlPath ~/.ssh/sockets/%r@%h-%p`,
    `  ControlPersist 10m`,
  ];
  for (const name of failoverOrder(registry)) {
    const machine = registry.machines[name];
    if (!machine || name === alias) continue;
    lines.push('', `Host ${name}`, `  HostName ${machine.host}`, `  User ${machine.user}`, `  ProxyJump ${alias}`, `  IdentityFile ${key}`, `  IdentitiesOnly yes`, `  StrictHostKeyChecking accept-new`);
  }
  const configFile = path.join(home, '.ssh', 'config');
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(configFile, 'utf8').catch(() => '');
  // Always refresh the brain block so a DHCP change cannot leave a stale brain address.
  const refreshed = existing.replace(new RegExp(`^Host ${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n(?:  .*\n)*`, 'm'), `${lines.slice(0, 9).join('\n')}\n`);
  const body = /^# swarm machine setup$/m.test(refreshed) ? refreshed : `${refreshed}\n# swarm machine setup\n${lines.join('\n')}\n`;
  await fs.writeFile(configFile, body, { mode: 0o600 });
  return out(`wrote ~/.ssh/config (${alias} + workers via ProxyJump ${alias})\nTest: ssh ${alias} 'hostname'\nAttach: swarm attach\nScreen: swarm screen <machine>\n`);
}


export async function pushFile({ target, key, name, data, run = defaultRunInput } = {}) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(name ?? ''))) throw Object.assign(new Error('invalid state file name'), { code: 'file-push-invalid' });
  const encoded = Buffer.from(data).toString('base64');
  const script = `mkdir -p "$HOME/.project-swarm" && printf '%s' ${JSON.stringify(encoded)} | base64 -d > "$HOME/.project-swarm/${name}"`;
  const argv = sshCommandArgv(target, script, { key });
  const result = await run(argv[0], argv.slice(1), { timeout: 30000 });
  if (result.code !== 0) throw Object.assign(new Error('file push failed'), { code: 'file-push-failed' });
  return true;
}

export async function restoreBrainState({ env = process.env, home = os.homedir() } = {}) {
  const stateDir = machineStateDir({ env, home });
  const restored = [];
  const errors = [];
  // Map each snapshot to THIS brain's own root by project name; never copy the old catalog over it.
  const catalogPath = path.join(stateDir, 'catalog', 'projects.json');
  const localProjectsFile = projectsFile(env, home);
  let catalog = [];
  try { const data = JSON.parse(await fs.readFile(catalogPath, 'utf8')); catalog = Array.isArray(data) ? data : data.projects ?? []; } catch {}
  const catalogById = new Map(catalog.map(project => [project.id, project]));
  const localProjects = await listProjects({ file: localProjectsFile, env, home }).catch(() => []);
  const localByName = new Map(localProjects.filter(project => project?.name && project?.root).map(project => [project.name, project]));
  const dir = path.join(stateDir, 'projects');
  const ids = await fs.readdir(dir).catch(() => []);
  for (const id of ids) {
    const oldProject = catalogById.get(id);
    const project = oldProject?.name ? localByName.get(oldProject.name) : null;
    if (!project?.root) {
      const error = `no local project named ${oldProject?.name ?? id} for snapshot ${id}`;
      restored.push({ id, error });
      errors.push({ id, error });
      continue;
    }
    try {
      const result = await restoreProjectState(project.root, { stateDir, projectId: id });
      restored.push({ id, root: project.root, copied: result.copied.length });
    } catch (error) {
      restored.push({ id, root: project.root, error: error.message });
      errors.push({ id, root: project.root, error: error.message });
    }
  }
  return { restored, errors };
}

export async function runBrainMove(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now, run = defaultRun } = deps;
  if (await fs.stat(path.join(projectSwarmHome({ env, home }), 'brain-failover.disabled')).then(() => true, () => false)) {
    return bad('brain failover is disabled (remove ~/.project-swarm/brain-failover.disabled to re-enable)\n');
  }
  const targetName = args[0];
  const force = args.includes('--force');
  if (!targetName) return bad(`Usage: swarm brain move <machine> [--force]\n`);
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const target = registry.machines[targetName];
  if (!target) return bad(`unknown machine ${targetName}\n`);
  const currentBrain = registry.machines[registry.brain];
  const addresses = await localAddresses({ run: defaultRun }).catch(() => ({}));
  const localNames = new Set([os.hostname(), os.hostname().replace(/\.local$/, ''), addresses.ip, addresses.tailscaleHost].filter(Boolean));
  const onBrain = currentBrain && (localNames.has(currentBrain.host) || (currentBrain.ip && localNames.has(currentBrain.ip)) || os.hostname().toLowerCase().includes(String(currentBrain.name ?? '').toLowerCase()));
  if (!onBrain) return bad('refusing brain move: run it on the machine that is currently the brain\n');
  if (target.role === 'remote+worker' && !force) {
    const probed = await probeMachine(targetName, { registry, home, env, now, run: deps.runInput ?? defaultRunInput }).catch(() => null);
    if (!probed || probed.onCharger !== true || probed.lidOpen === false) return bad(`refusing to move the brain to ${targetName}: it is on battery or the lid is closed. Use --force only if you accept the swarm stopping when it sleeps.\n`);
  }
  const lock = await acquireBrainLock({ file: deps.brainLockFile, machine: os.hostname(), now: now() });
  try {
    const stateDir = machineStateDir({ env, home });
    const sourcePauseFile = deps.workerPauseFile ?? workerPauseFile({ env, home });
    const registryFile = deps.registryFile ?? machinesFile({ env, home });
    const pointerPath = deps.brainPointerFile ?? brainPointerFile({ env, home });
    const oldBrain = registry.brain;
    const oldEpoch = registry.epoch ?? 0;
    const oldMachine = registry.machines[oldBrain];
    await pauseWorkerQueue({ file: sourcePauseFile, reason: `brain-move:${targetName}` }).catch(() => null);
    const failMove = async message => {
      await resumeWorkerQueue({ file: sourcePauseFile }).catch(() => null);
      try {
        await withRegistryLock({ file: registryFile }, async () => {
          const current = await readRegistry({ file: registryFile, env, home });
          current.brain = oldBrain;
          current.epoch = oldEpoch;
          for (const machine of Object.values(current.machines)) if (machine.role === 'brain' && machine.name !== oldBrain) machine.role = 'worker';
          if (current.machines[oldBrain]) current.machines[oldBrain].role = 'brain';
          await writeRegistry(current, { file: registryFile, env, home });
        });
        if (oldMachine) await writeBrainPointer({ host: oldMachine.host, user: oldMachine.user, machine: oldBrain, epoch: oldEpoch }, { file: pointerPath, env, home });
      } catch {}
      return bad(message);
    };
    const projects = await listProjects({ file: projectsFile(env), env, home }).catch(() => []);
    for (const project of projects) {
      try { await snapshotProjectState(project.root, { stateDir, projectId: project.id }); }
      catch (error) { return failMove(`state snapshot failed for ${project.name}: ${sanitize(error.message)}\n`); }
    }
    await snapshotCatalog({ stateDir, env, home }).catch(() => null);
    const source = registry.machines[registry.brain];
    if (source && source.host !== target.host && deps.syncState !== false) {
      const key = path.join(home, '.ssh', 'swarm_ed25519');
      const rsync = await (deps.runShell ?? defaultRun)('rsync', ['-a', '-e', `ssh -T -o BatchMode=yes -i ${key}`, `${stateDir}/`, `${target.user}@${target.host}:~/.project-swarm/state/`], { timeout: 10 * 60 * 1000 }).catch(error => ({ code: 1, stderr: error.message }));
      if (rsync.code !== 0) return failMove(`state sync failed: ${sanitize(rsync.stderr ?? '')}\n`);
    }
    const pushKey = path.join(home, '.ssh', 'swarm_ed25519');
    const restored = await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-i', pushKey, '--', `${target.user}@${target.host}`, 'node "$HOME/.project-swarm/current/tools/swarm.mjs" brain restore-state'], { timeout: 120000 }).catch(() => null);
    if (!restored || restored.code !== 0) return failMove(`project state restore failed on ${targetName}\n`);
    await setBrain(targetName, { file: registryFile, env, home });
    const epoch = await withRegistryLock({ file: registryFile }, async () => {
      const updated = await readRegistry({ file: registryFile, env, home });
      updated.epoch = (updated.epoch ?? 0) + 1;
      await writeRegistry(updated, { file: registryFile, env, home });
      return updated.epoch;
    });
    await writeBrainPointer({ host: target.host, user: target.user, machine: targetName, epoch }, { file: pointerPath, env, home });
    await pushFile({ target, key: pushKey, name: 'machines.json', data: await fs.readFile(deps.registryFile ?? machinesFile({ env, home }), 'utf8'), run: deps.runInput ?? defaultRunInput }).catch(() => null);
    await pushFile({ target, key: pushKey, name: 'brain.json', data: await fs.readFile(pointerPath, 'utf8'), run: deps.runInput ?? defaultRunInput }).catch(() => null);
    const key = path.join(home, '.ssh', 'swarm_ed25519');
    for (const [name, machine] of Object.entries(registry.machines)) {
      if (name === targetName) continue;
      const pointer = JSON.stringify({ host: target.host, user: target.user, machine: targetName, epoch });
      await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', key, '--', `${machine.user}@${machine.host}`, `mkdir -p ~/.project-swarm && printf '%s\\n' '${pointer}' > ~/.project-swarm/brain.json`], { timeout: 30000 }).catch(() => null);
    }
    if (deps.startBrain !== false) {
      const start = await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-i', path.join(home, '.ssh', 'swarm_ed25519'), '--', `${target.user}@${target.host}`, 'zsh -lc "tmux new -d -s swarm \'swarm watch --all --keep-up\' 2>/dev/null || true"'], { timeout: 60000 }).catch(error => ({ code: 1, stderr: error.message }));
      if (start.code !== 0) return failMove(`orchestrator did not start on ${targetName}: ${sanitize(start.stderr ?? '')}\n`);
    }
    await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-i', key, '--', `${target.user}@${target.host}`, 'rm -f ~/.project-swarm/state/worker-queue.paused'], { timeout: 30000 }).catch(() => null);
    if (deps.stopSource !== false) {
      try {
        const board = JSON.parse(await fs.readFile(path.join(home, '.project-swarm', 'board.json'), 'utf8'));
        if (board?.pid && /watch/.test(String(board?.argv?.join(' ') ?? ''))) process.kill(board.pid, 'SIGTERM');
      } catch {}
    }
    const warning = target.role === 'remote+worker' && force ? '\nwarning: the swarm stops if this machine sleeps or leaves the network' : '';
    return out(`brain moved to ${targetName} (${target.user}@${target.host}); running tickets keep going; new leases pause until the new brain answers${warning}\n`);
  } finally {
    await releaseBrainLock({ file: deps.brainLockFile, machine: os.hostname() }).catch(() => {});
  }
}

export function failoverDecision({ registry, heartbeats = {}, now = Date.now(), silentMs = 3 * 60 * 1000 } = {}) {
  const brain = registry.brain;
  const seen = heartbeats[brain];
  // A brain we have never observed is not evidence it is dead; stay put.
  if (!Number.isFinite(seen)) return { action: 'none', brain };
  if (now - seen <= silentMs) return { action: 'none', brain };
  const next = nextBrain(registry);
  if (!next || next === brain) return { action: 'none', brain };
  return { action: 'move', from: brain, to: next, reason: `brain ${brain} silent for ${Math.round((now - (seen ?? 0)) / 1000)}s` };
}

export async function runBrainStatus(args, deps = {}) {
  const { env = process.env, home = os.homedir() } = deps;
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const machine = registry.brain ? registry.machines[registry.brain] : null;
  if (!machine) return out('brain: none registered\n');
  const lock = await fs.readFile(deps.brainLockFile ?? path.join(projectSwarmHome({ env, home }), 'brain.lock'), 'utf8').then(text => JSON.parse(text), () => null);
  return out(`brain: ${registry.brain} (${machine.user}@${machine.host})${lock ? ` · lock held by ${lock.machine}` : ' · no lock'}\norder: ${failoverOrder(registry).join(' -> ')}\n`);
}



export async function updateSshConfigForMachine({ name, host, user, key, home = os.homedir() }) {
  if (!MACHINE_NAME_RE.test(String(name ?? ''))) throw Object.assign(new Error('invalid machine name'), { code: 'ssh-config-invalid' });
  const file = path.join(home, '.ssh', 'config');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(file, 'utf8').catch(() => '');
  const lines = existing.split('\n');
  const block = [
    `Host ${name}`,
    `  HostName ${host}`,
    `  User ${user}`,
    `  IdentityFile ${key}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    '  ServerAliveInterval 30',
    '  ControlMaster auto',
    '  ControlPath ~/.ssh/sockets/%r@%h-%p',
    '  ControlPersist 10m',
  ];
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) if (new RegExp(`^Host\\s+${name}$`).test(lines[i])) { start = i; break; }
  let next = existing;
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) if (/^Host\s+/.test(lines[i])) { end = i; break; }
    next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
  } else {
    next = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n# swarm machine\n${block.join('\n')}\n`;
  }
  if (next !== existing) {
    await fs.writeFile(file, next, { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
  }
  return { file, updated: next !== existing };
}

export function brainHostList(brain) {
  return [...new Set([brain?.host, ...(Array.isArray(brain?.hosts) ? brain.hosts : []), brain?.tailscaleHost].filter(Boolean))];
}

export async function refreshBrainAddress({ env = process.env, home = os.homedir(), now = Date.now } = {}) {
  const pointerFile = brainPointerFile({ env, home });
  const pointer = await readBrainPointer({ file: pointerFile, env, home }).catch(() => null);
  if (!pointer) return null;
  const addresses = await localAddresses({ run: defaultRun });
  const current = addresses.ip ?? pointer.host;
  const hosts = [...new Set([current, pointer.host, ...(Array.isArray(pointer.hosts) ? pointer.hosts : []), addresses.tailscaleHost, pointer.tailscaleHost].filter(Boolean))];
  if (current === pointer.host && hosts.length === brainHostList(pointer).length) return pointer;
  const next = { ...pointer, host: current, hosts, ...(addresses.tailscaleHost ? { tailscaleHost: addresses.tailscaleHost } : {}) };
  await writeBrainPointer(next, { file: pointerFile, env, home });
  try {
    const registry = await readRegistry({ file: machinesFile({ env, home }), env, home });
    if (registry.brain && registry.machines[registry.brain]) {
      registry.machines[registry.brain] = { ...registry.machines[registry.brain], host: current, ip: current, ...(addresses.tailscaleHost ? { tailscaleHost: addresses.tailscaleHost } : {}), updatedAt: new Date(now()).toISOString() };
      await writeRegistry(registry, { file: machinesFile({ env, home }), env, home });
    }
  } catch {}
  return next;
}

export async function publishWorkerBranch({ report, env = process.env, home = os.homedir(), run = defaultRun } = {}) {
  const project = typeof report?.project === 'string' ? report.project : null;
  const branch = typeof report?.branch === 'string' ? report.branch : null;
  if (!project || !branch || report?.pushed !== true) return { published: false, reason: 'not-pushed' };
  // Never let a worker choose the destination ref: only its own worker/<machine>/<job> branch.
  if (!/^worker\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(branch) || branch.includes('..')) return { published: false, reason: 'unsafe-branch' };
  if (report?.machine && !branch.startsWith(`worker/${String(report.machine).replace(/[^A-Za-z0-9._-]+/g, '-')}/`)) return { published: false, reason: 'branch-machine-mismatch' };
  const projects = await listProjects({ file: projectsFile(env, home), env, home }).catch(() => []);
  const source = projects.find(item => item.name === project || item.id === project)?.root;
  if (!source) return { published: false, reason: 'project-unknown' };
  const origin = await run('git', ['-C', source, 'remote', 'get-url', 'origin'], { timeout: 30000 });
  const url = String(origin.stdout ?? '').trim();
  if (origin.code !== 0 || !url) return { published: false, reason: 'origin-missing' };
  const mirror = path.join(home, '.project-swarm', 'mirrors', `${project}.git`);
  const token = await fs.readFile(path.join(home, '.project-swarm', 'github-token'), 'utf8').then(text => text.trim(), () => '');
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}) };
  const push = await run('git', ['-C', mirror, 'push', url, `${branch}:refs/heads/${branch}`], { timeout: 180000, env: gitEnv });
  if (push.code !== 0) return { published: false, reason: 'push-failed', detail: String(push.stderr ?? '').trim().split('\n').at(-1) ?? null };
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return { published: true, branch, pr: null };
  const repo = `${match[1]}/${match[2]}`;
  const existing = await run('gh', ['pr', 'list', '-R', repo, '--head', branch, '--json', 'number,url', '-q', '.[0].url'], { timeout: 60000, env: gitEnv });
  const found = String(existing.stdout ?? '').trim();
  if (existing.code === 0 && found) return { published: true, branch, pr: found };
  const title = `Worker ticket: ${report.title ?? report.job ?? branch}`.slice(0, 120);
  const body = `Automated worker branch from ${report.machine ?? 'a worker'}.\n\nJob: ${report.job ?? branch}\n\nNo auto-merge; review and merge through the ship gate.`;
  const created = await run('gh', ['pr', 'create', '-R', repo, '--head', branch, '--base', 'main', '--title', title, '--body', body], { timeout: 120000, env: gitEnv });
  return { published: created.code === 0, branch, pr: String(created.stdout ?? '').trim() || null, detail: created.code === 0 ? null : String(created.stderr ?? '').trim() };
}

export async function runWorkerRpc({ stdin = process.stdin, env = process.env, home = os.homedir(), now = Date.now, file, argv = [] } = {}) {
  const boundAt = argv.indexOf('--machine');
  const boundMachine = boundAt >= 0 && MACHINE_NAME_RE.test(argv[boundAt + 1] ?? '') ? argv[boundAt + 1] : null;
  if (boundMachine) {
    const registered = await readRegistry({ file: machinesFile({ env, home }), env, home }).catch(() => null);
    if (!registered?.machines?.[boundMachine]) return bad(`${JSON.stringify({ error: 'worker-rpc-machine-unknown', message: 'this worker key no longer matches a registered machine' })}\n`, 403);
  }
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8').trim() || '{}'); }
  catch { return bad('worker-rpc-invalid-json\n', 2); }
  const pointer = await readBrainPointer({ env, home }).catch(() => null);
  if (request.op !== 'heartbeat' && request.epoch !== undefined && pointer?.epoch !== undefined && Number(request.epoch) !== Number(pointer.epoch)) return bad(`${JSON.stringify({ error: 'worker-brain-stale', message: 'this worker points at an old brain epoch' })}\n`, 1);
  const queueFile = file ?? workerQueueFile({ env, home });
  try {
    if (request.op === 'heartbeat') {
      if (!boundMachine) return bad(`${JSON.stringify({ error: 'worker-rpc-unbound', message: 'this key is not bound to a machine; re-run swarm machine add' })}\n`, 403);
      if (request.machine !== undefined && request.machine !== boundMachine) return bad(`${JSON.stringify({ error: 'worker-rpc-machine-mismatch', message: 'heartbeat machine does not match this key' })}\n`, 403);
      const registryFile = machinesFile({ env, home });
      const name = boundMachine;
      const ip = typeof request.ip === 'string' && MACHINE_HOST_RE.test(request.ip) ? request.ip : null;
      let updatedMachine = null;
      await withRegistryLock({ file: registryFile }, async () => {
        const registry = await readRegistry({ file: registryFile, env, home });
        if (!registry.machines[name]) return;
        // The key is bound to this machine; a validated IP keeps DNS-free workers reachable after DHCP changes.
        registry.machines[name] = { ...registry.machines[name], ...(ip ? { host: ip, ip } : {}), health: 'ok', lastSeen: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString() };
        await writeRegistry(registry, { file: registryFile, env, home });
        updatedMachine = registry.machines[name];
      });
      if (ip && updatedMachine) await updateSshConfigForMachine({ name, host: ip, user: updatedMachine.user, key: path.join(home, '.ssh', 'swarm_ed25519'), home }).catch(() => null);
      const pointer = await refreshBrainAddress({ env, home, now });
      return out(`${JSON.stringify({ machine: updatedMachine, brain: pointer ? { host: pointer.host, hosts: brainHostList(pointer), epoch: pointer.epoch ?? null, machine: pointer.machine ?? null } : null })}\n`);
    }
    if (request.op === 'next') {
      const item = await nextWorkerItem({ lanes: Array.isArray(request.lanes) ? request.lanes : WORKER_LANE_NAMES, capabilities: Array.isArray(request.capabilities) ? request.capabilities : [], machine: boundMachine ?? request.machine ?? null, file: queueFile, env, home, now });
      return out(`${JSON.stringify(item)}\n`);
    }
    if (request.op === 'claim') {
      if (typeof request.id !== 'string' || typeof request.holder !== 'string') return bad('worker-rpc-invalid-claim\n', 2);
      if (boundMachine && !request.holder.startsWith(`${boundMachine}/`)) return bad('worker-rpc-holder-mismatch\n', 403);
      const item = await claimWorkerItem(request.id, request.holder, { file: queueFile, env, home, now, machine: boundMachine ?? request.machine ?? null, lanes: Array.isArray(request.lanes) ? request.lanes : null, capabilities: Array.isArray(request.capabilities) ? request.capabilities : [] });
      return out(`${JSON.stringify(item)}\n`);
    }
    if (request.op === 'renew') {
      if (typeof request.id !== 'string' || typeof request.holder !== 'string') return bad('worker-rpc-invalid-renew\n', 2);
      if (boundMachine && !request.holder.startsWith(`${boundMachine}/`)) return bad('worker-rpc-holder-mismatch\n', 403);
      const item = await renewWorkerItem(request.id, request.holder, { file: queueFile, env, home, now });
      return out(`${JSON.stringify(item)}\n`);
    }
    if (request.op === 'report') {
      if (typeof request.id !== 'string' || typeof request.holder !== 'string') return bad('worker-rpc-invalid-report\n', 2);
      if (boundMachine && !request.holder.startsWith(`${boundMachine}/`)) return bad('worker-rpc-holder-mismatch\n', 403);
      const report = request.report && typeof request.report === 'object' ? request.report : null;
      const status = report?.status === 'pass' ? 'done' : (report?.retry === true || ['rate-limited', 'logged-out'].includes(report?.status)) ? 'requeue' : 'failed';
      const item = await reportWorkerItem(request.id, request.holder, { status, report, file: queueFile, env, home, now });
      if (status === 'done' && report?.pushed === true) {
        const published = await publishWorkerBranch({ report, env, home }).catch(error => ({ published: false, reason: error.message }));
        if (published?.pr) item.pr = published.pr;
      }
      return out(`${JSON.stringify(item)}\n`);
    }
    return bad('worker-rpc-op-unknown\n', 2);
  } catch (error) {
    return bad(`${JSON.stringify({ error: error.code ?? 'worker-rpc-failed', message: sanitize(error.message) })}\n`, 1);
  }
}

export async function runWorkerCommand(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now } = deps;
  const file = deps.workerQueueFile ?? workerQueueFile({ env, home });
  const [verb, ...rest] = args;
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') return out(WORKER_USAGE);
  if (verb === 'queue') {
    const [sub, ...queueArgs] = rest;
    if (sub === 'add' || sub === 'enqueue') {
      const manifestPath = queueArgs[0];
      if (!manifestPath) return bad(`Usage: swarm worker queue add <manifest> [--project P] [--lane L]\n`);
      const lane = flag(queueArgs, '--lane').value;
      const project = flag(queueArgs, '--project').value;
      try {
        const result = await enqueueManifest({ manifestPath, project, laneOverride: lane, file, env, home, now });
        return out(`queued ${result.total} work item(s): ${result.added.join(', ') || 'none new'}\n`);
      } catch (error) { return bad(`${sanitize(error.message)}\n`); }
    }
    if (sub === 'list') {
      const items = await listWorkerItems({ file, env, home, now });
      const rows = items.map(item => `${item.id}\t${item.status}\t${item.lane ?? '-'}\t${item.project}\t${item.report?.status ?? ''}`);
      return out(rows.length ? `${rows.join('\n')}\n` : 'worker queue is empty\n');
    }
    if (sub === 'sweep') {
      const result = await releaseExpiredWorkerItems({ file, env, home, now });
      return out(result.released.length ? `returned expired leases: ${result.released.join(', ')}\n` : 'no expired leases\n');
    }
    if (sub === 'clear') {
      const removed = await clearFinishedWorkerItems({ file, env, home });
      return out(removed.length ? `cleared: ${removed.join(', ')}\n` : 'nothing to clear\n');
    }
    if (sub === 'resume') {
      await resumeWorkerQueue({ file: workerPauseFile({ env, home }) });
      return out('worker queue resumed\n');
    }
    return bad(`Usage: swarm worker queue add|list|sweep|clear\n`);
  }
  if (verb === 'next') {
    const lanesFlag = flag(rest, '--lanes');
    const machineFlag = flag(rest, '--machine');
    const lanes = (lanesFlag.value ? lanesFlag.value.split(',') : WORKER_LANE_NAMES).map(value => value.trim()).filter(Boolean);
    const item = await nextWorkerItem({ lanes, machine: machineFlag.value ?? null, file, env, home, now });
    if (rest.includes('--json')) return out(`${JSON.stringify(item)}\n`);
    return out(item ? `${item.id}\t${item.lane ?? '-'}\t${item.project}\n` : 'no ready work\n');
  }
  if (verb === 'claim') {
    const id = rest[0];
    const holder = flag(rest, '--holder').value;
    const machine = flag(rest, '--machine').value;
    const lanesFlag = flag(rest, '--lanes');
    const lanes = lanesFlag.value ? lanesFlag.value.split(',').map(value => value.trim()).filter(Boolean) : null;
    if (!id || !holder) return bad(`Usage: swarm worker claim ID --holder H\n`);
    try { const item = await claimWorkerItem(id, holder, { file, env, home, now, machine, lanes }); return out(`${JSON.stringify(item)}\n`); } catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'renew') {
    const id = rest[0];
    const holder = flag(rest, '--holder').value;
    if (!id || !holder) return bad(`Usage: swarm worker renew ID --holder H\n`);
    try { const item = await renewWorkerItem(id, holder, { file, env, home, now }); return out(`${JSON.stringify(item)}\n`); } catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'report') {
    const id = rest[0];
    const holder = flag(rest, '--holder').value;
    const b64 = flag(rest, '--report').value;
    if (!id || !holder) return bad(`Usage: swarm worker report ID --holder H --report B\n`);
    let report = null;
    if (b64) { try { report = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return bad('report is not valid base64 JSON\n'); } }
    try {
      const status = report?.status === 'pass' ? 'done' : (report?.retry === true || ['rate-limited', 'logged-out'].includes(report?.status)) ? 'requeue' : 'failed';
      const item = await reportWorkerItem(id, holder, { status, report, file, env, home, now });
      return out(`${JSON.stringify(item)}\n`);
    } catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'run') {
    const lanesFile = await readWorkerLanes(home);
    const name = deps.machineName ?? lanesFile?.name ?? os.hostname();
    const lanes = lanesFile?.lanes_installed ?? WORKER_LANE_NAMES;
    const paths = workerPaths(home);
    const readBrain = async () => (await readBrainPointer({ env, home }).catch(() => null)) ?? (await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home }).then(registry => registry.brain ? registry.machines[registry.brain] : null));
    const firstBrain = await readBrain();
    if (!firstBrain) return bad('no brain registered; run swarm machine add on the brain or set ~/.project-swarm/brain.json\n');
    const once = rest.includes('--once');
    const runner = deps.runnerPath ?? path.join(projectSwarmHome({ env, home }), 'current', 'tools', 'swarm.mjs');
    // The brain's registry is the authority for laptop rules, slots and capabilities; the local
    // lanes.json is only a fallback for the first offline start.
    let policy = { role: lanesFile?.role, slots: lanesFile?.slots, lanes: lanes, capabilities: Array.isArray(lanesFile?.capabilities) ? lanesFile.capabilities : [] };
    const mergePolicy = auth => {
      if (!auth || typeof auth !== 'object') return;
      if (auth.role) policy.role = auth.role;
      if (Number.isInteger(auth.slots)) policy.slots = auth.slots;
      if (Array.isArray(auth.capabilities)) policy.capabilities = auth.capabilities;
      if (Array.isArray(auth.lanes) && auth.lanes.length) policy.lanes = auth.lanes;
    };
    const iteration = async (slot = 0) => {
      const brain = (await readBrain()) ?? firstBrain;
      const transport = deps.transport ?? createSshTransport({ brain });
      const local = await probeLocal({ run: deps.runShell ?? defaultRun, home, env, now });
      let heartbeat = null;
      if (typeof transport.heartbeat === 'function') {
        heartbeat = await transport.heartbeat({ machine: name, ip: local.ip }).catch(() => null);
        if (heartbeat?.machine) mergePolicy(heartbeat.machine);
        if (heartbeat?.brain?.host) {
          brain.host = heartbeat.brain.host;
          brain.hosts = heartbeat.brain.hosts;
          brain.epoch = heartbeat.brain.epoch;
          await writeBrainPointer({ host: brain.host, user: brain.user, machine: heartbeat.brain.machine ?? brain.machine ?? loadMachineLocalConfig({ env, home }).brainName, hosts: brain.hosts, epoch: brain.epoch }, { env, home }).catch(() => null);
        }
      }
      const brainReachable = Boolean(heartbeat);
      const monitor = async () => {
        const current = await probeLocal({ run: deps.runShell ?? defaultRun, home, env, now });
        const reachable = typeof transport.heartbeat === 'function'
          ? Boolean(await transport.heartbeat({ machine: name, ip: current.ip }).catch(() => null))
          : brainReachable;
        const gate = laptopGate({ role: policy.role, onCharger: current.onCharger, lidOpen: current.lidOpen, brainReachable: reachable });
        if (!gate.ok) return { ok: false, reason: gate.reason };
        const disk = diskGuard(current.freeDiskGb);
        if (!disk.ok) return { ok: false, reason: 'disk-below-guard' };
        return { ok: true };
      };
      return runWorkerOnce({
        lanes: policy.lanes,
        capabilities: policy.capabilities,
        holder: `${name}/${process.pid}-${slot}`,
        paths,
        runner,
        transport,
        maxSlots: 1,
        freeDiskGb: local.freeDiskGb,
        role: policy.role,
        onCharger: local.onCharger,
        lidOpen: local.lidOpen,
        brainReachable,
        userActive: local.userActive === true,
        run: deps.runTicket ?? undefined,
        brain,
        key: path.join(home, '.ssh', 'swarm_ed25519'),
        gitKey: path.join(home, '.ssh', 'swarm_git_ed25519'),
        monitor,
        monitorMs: 30000,
      });
    };
    if (once) {
      const result = await iteration();
      return out(`${JSON.stringify(result)}\n`);
    }
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // One preflight heartbeat makes the brain's role/slot/capability record authoritative before any slot starts.
    const preTransport = deps.transport ?? createSshTransport({ brain: firstBrain });
    const preLocal = await probeLocal({ run: deps.runShell ?? defaultRun, home, env, now }).catch(() => ({}));
    const preHeartbeat = await preTransport.heartbeat({ machine: name, ip: preLocal.ip }).catch(() => null);
    if (preHeartbeat?.machine) mergePolicy(preHeartbeat.machine);
    let ceiling = Math.max(0, Math.min(256, Number.isInteger(policy.slots) ? policy.slots : 1));
    if (ceiling === 0) return out(`worker ${name}: 0 slots set by the brain; not taking work\n`);
    process.stdout.write(`worker ${name}: pulling from ${firstBrain.user}@${firstBrain.host} (${ceiling} slots)\n`);
    const active = new Map();
    let target = ceiling;
    let stopping = false;
    const spawn = slot => {
      if (active.has(slot)) return;
      const task = (async () => {
        for (;;) {
          if (stopping || slot >= target) return;
          const result = await iteration(slot).catch(error => ({ action: 'error', reason: error.message }));
          process.stdout.write(`${new Date().toISOString()} ${result.action}${result.reason ? ` ${result.reason}` : ''}${result.item ? ` ${result.item.id}` : ''}\n`);
          if (result.action === 'stop') { stopping = true; return; }
          if (result.action !== 'ran') await sleep(15000);
        }
      })().finally(() => active.delete(slot));
      active.set(slot, task);
    };
    for (let slot = 0; slot < target; slot += 1) spawn(slot);
    // Measured heat, not a guess: a throttling 2019 i9 backs off; a clean sample adds one slot back.
    const tuner = setInterval(async () => {
      if (stopping) return;
      const local = await probeLocal({ run: deps.runShell ?? defaultRun, home, env, now }).catch(() => ({}));
      const next = tuneSlots({
        current: target, ceiling, throttled: local.throttled,
        cpuSpeedLimit: local.cpuSpeedLimit, cpuSchedulerLimit: local.cpuSchedulerLimit,
        memoryPressure: local.memoryPressure, role: lanesFile?.role,
        onCharger: local.onCharger, userActive: local.userActive === true,
      });
      if (next !== target) {
        process.stdout.write(`${new Date().toISOString()} slots ${target} -> ${next}${next < target ? ' (throttled or under pressure)' : ' (recovered)'}\n`);
        target = next;
        for (let slot = 0; slot < target; slot += 1) spawn(slot);
      }
    }, 60000);
    if (typeof tuner.unref === 'function') tuner.unref();
    try { while (!stopping && active.size) await sleep(1000); }
    finally { clearInterval(tuner); }
    return out('');
  }
  if (verb === 'bench') {
    const manifestPath = rest[0];
    if (!manifestPath) return bad(`Usage: swarm worker bench <manifest> [--workers N] [--json]\n`);
    const workersFlag = flag(rest, '--workers');
    const workFlag = flag(rest, '--work-ms');
    const workers = Math.max(1, Math.min(32, Number(workersFlag.value) || 4));
    const workMs = Math.max(1, Math.min(60000, Number(workFlag.value) || 25));
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const base = path.join(machineStateDir({ env, home }), `bench-${process.pid}.json`);
      const serial = await runBench({ manifestPath, manifest, workers: 1, workMs, file: base, paths: workerPaths(home), now });
      const parallel = await runBench({ manifestPath, manifest, workers, workMs, file: base, paths: workerPaths(home), now });
      if (rest.includes('--json')) return out(`${JSON.stringify({ serial, parallel })}\n`);
      return out(`${benchSummary([serial])}\n${benchSummary([parallel])}\n(mock lane: measures the pull/lease/worktree harness, not model time)\n`);
    } catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'mirror') {
    const [name, source] = rest;
    if (!name || !source) return bad(`Usage: swarm worker mirror <name> <repo-path>\n`);
    try { const result = await mirrorRepo({ source, name, home, run: deps.runShell ?? defaultRun }); return out(`mirror ${name}: ${result.dir}\n`); }
    catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'install') {
    const lanesFile = await readWorkerLanes(home);
    const brain = await readBrainPointer({ env, home }).catch(() => null);
    const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
    const target = { user: os.userInfo().username, host: os.hostname().replace(/\.local$/, '') };
    try {
      await installWorkerService({ target, key: path.join(home, '.ssh', 'swarm_ed25519'), machine: lanesFile?.name ?? os.hostname(), brain, run: deps.runShell ?? defaultRun, home });
      return out('worker LaunchAgent installed\n');
    } catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'status') {
    const lanesFile = await readWorkerLanes(home);
    const items = await listWorkerItems({ file, env, home, now });
    const paused = await workerQueuePaused({ file: workerPauseFile({ env, home }) }).catch(() => false);
    return out(`worker: ${lanesFile?.name ?? os.hostname()} slots ${lanesFile?.slots ?? '?'} lanes ${(lanesFile?.lanes_installed ?? []).join(', ')}\nqueue: ${items.length} item(s), ${items.filter(item => item.status === 'queued').length} queued${paused ? ' (PAUSED: brain move in progress)' : ''}\n`);
  }
  return bad(`${WORKER_USAGE}`);
}

export async function runMachineCommand(root, args, deps = {}) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') return out(MACHINE_USAGE);
  if (command === 'add') return runMachineAdd(rest, deps);
  if (command === 'rollback') {
    const forget = rest.includes('--forget');
    const name = rest.find(arg => !arg.startsWith('--'));
    if (!name) return bad(`${MACHINE_USAGE}`);
    return runMachineRollback(name, { env: deps.env, home: deps.home, run: deps.run, forget });
  }
  if (command === 'login') return runMachineLogin(rest, deps);
  if (command === 'doctor') return runMachineDoctor(rest, deps);
  if (command === 'list') return runMachineList(rest, deps);
  if (command === 'remove') return runMachineRemove(rest, deps);
  if (command === 'bench') return runWorkerCommand(['bench', ...rest], deps);
  if (command === 'remote' && rest[0] === 'setup') return runRemoteSetup(rest.slice(1), deps);
  return bad(MACHINE_USAGE);
}
