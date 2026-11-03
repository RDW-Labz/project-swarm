// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  addMachine, acquireBrainLock, brainPointerFile, failoverOrder, machinesFile, MACHINE_NAME_RE, nextBrain,
  readBrainPointer, readRegistry, releaseBrainLock, removeMachine, setBrain, writeBrainPointer, writeRegistry,
} from './machine-registry.mjs';
import { measuredOnly, parseRemoteProbe, probeLocal, probeRemote, defaultRun, defaultRunInput, sshProbeArgv, WORKER_LANE_CLIS } from './machine-probe.mjs';
import { laneLoginHint, laneLoginFiles, WORKER_LANE_NAMES } from './lane-plugins.mjs';
import {
  claimWorkerItem, clearFinishedWorkerItems, enqueueManifest, listWorkerItems, nextWorkerItem,
  pauseWorkerQueue, releaseExpiredWorkerItems, renewWorkerItem, reportWorkerItem, resumeWorkerQueue, workerQueueFile,
} from './worker-queue.mjs';
import {
  cleanWorktrees, createSshTransport, ensureRepo, executeItem, ghostState, mirrorRepo, readWorkerLanes, runWorkerOnce, slotsForMachine, workerPaths,
} from './worker-runner.mjs';
import { projectSwarmHome } from './machine-registry.mjs';
import { snapshotProjectState, machineStateDir } from './state-sync.mjs';
import { runBench, benchSummary } from './worker-bench.mjs';
import { listProjects, projectsFile } from './projects.mjs';

export const MACHINE_USAGE = [
  'Usage:',
  '  swarm machine add <user>@<host> [--name NAME] [--role worker|both|brain] [--slots N] [--key PATH] [--register-only]',
  '  swarm machine login <name>',
  '  swarm machine doctor [name]',
  '  swarm machine list [--probe]',
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
  '  swarm worker queue add <manifest> [--project P] [--lane L] | list | sweep | clear',
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
    await run(argv[0], argv.slice(1), { timeout: 12000 });
    return true;
  } catch { return false; }
}

export async function syncRunner({ target, key, installRoot, home = os.homedir(), run = defaultRun, version } = {}) {
  let runnerVersion = version;
  if (!runnerVersion) {
    try { runnerVersion = JSON.parse(await fs.readFile(path.join(installRoot, 'package.json'), 'utf8')).version; } catch { runnerVersion = 'current'; }
  }
  const remoteHome = `.project-swarm/versions/${runnerVersion}`;
  const argv = ['rsync', '-a', '--delete', '-e', `ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i ${key}`, `${installRoot}/`, `${target.user}@${target.host}:~/${remoteHome}/`];
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

export async function runBootstrap({ target, key, name, role, brainHost, brainUser, run = defaultRunInput } = {}) {
  const mode = role === 'remote+worker' || role === 'both' ? 'both' : 'worker';
  const head = [
    `export SWARM_MACHINE_NAME=${JSON.stringify(name)}`,
    `export SWARM_MACHINE_MODE=${JSON.stringify(mode)}`,
    `export SWARM_BRAIN_HOST=${JSON.stringify(brainHost ?? '')}`,
    `export SWARM_BRAIN_USER=${JSON.stringify(brainUser ?? '')}`,
  ].join('\n');
  const script = `${head}\n${await readBootstrapScript()}`;
  const argv = sshCommandArgv(target, 'bash -s', { key, tty: true });
  const result = await run(argv[0], argv.slice(1), { input: script, timeout: 30 * 60 * 1000 });
  const stdout = String(result.stdout ?? '');
  if (!/MACHINE_SETUP_OK/.test(stdout)) throw Object.assign(new Error(`bootstrap did not finish: ${stdout.slice(-800)}`), { code: 'machine-bootstrap-failed' });
  return { stdout, warnings: stdout.split('\n').filter(line => /WARN/.test(line)) };
}

export function workerServicePlist({ runner, machine, brainHost, brainUser, key, home }) {
  const args = [process.execPath || '/usr/bin/env node', runner, 'worker', 'run'];
  const env = {
    SWARM_WORKER_NAME: machine,
    ...(brainHost ? { SWARM_BRAIN_HOST: brainHost } : {}),
    ...(brainUser ? { SWARM_BRAIN_USER: brainUser } : {}),
    SWARM_SSH_KEY: key,
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
  const runner = '~/.project-swarm/current/tools/swarm.mjs';
  const plist = workerServicePlist({ runner, machine, brainHost: brain?.host, brainUser: brain?.user, key: '~/.ssh/swarm_ed25519', home: home ?? `/Users/${target.user}` });
  const encoded = Buffer.from(plistXml(plist)).toString('base64');
  const script = [
    'set -e',
    'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/swarm-worker/logs"',
    `printf '%s' ${JSON.stringify(encoded)} | base64 -d > "$HOME/Library/LaunchAgents/com.project-swarm.worker.plist"`,
    'launchctl bootout "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 || true',
    'launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.project-swarm.worker.plist"',
    'launchctl kickstart -k "gui/$(id -u)/com.project-swarm.worker"',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 120000 });
  if (result.code !== 0) throw Object.assign(new Error(`worker service install failed: ${String(result.stderr ?? '').trim()}`), { code: 'worker-service-failed' });
  return { installed: true };
}


export function brainWatchPlist({ runner, home }) {
  return {
    Label: 'com.project-swarm.brainwatch',
    ProgramArguments: [process.execPath || '/usr/bin/env node', runner, 'brain', 'watch'],
    EnvironmentVariables: {},
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: path.join(home, 'swarm-worker', 'logs', 'brainwatch.log'),
    StandardErrorPath: path.join(home, 'swarm-worker', 'logs', 'brainwatch.err.log'),
    WorkingDirectory: home,
  };
}

export async function installBrainWatchService({ target, key, run = defaultRun, home }) {
  const plist = brainWatchPlist({ runner: '~/.project-swarm/current/tools/swarm.mjs', home: home ?? `/Users/${target.user}` });
  const encoded = Buffer.from(plistXml(plist)).toString('base64');
  const script = [
    'set -e',
    'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/swarm-worker/logs"',
    `printf '%s' ${JSON.stringify(encoded)} | base64 -d > "$HOME/Library/LaunchAgents/com.project-swarm.brainwatch.plist"`,
    'launchctl bootout "gui/$(id -u)/com.project-swarm.brainwatch" >/dev/null 2>&1 || true',
    'launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.project-swarm.brainwatch.plist"',
    'launchctl kickstart -k "gui/$(id -u)/com.project-swarm.brainwatch"',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 120000 });
  if (result.code !== 0) throw Object.assign(new Error(`brain watchdog install failed: ${String(result.stderr ?? '').trim()}`), { code: 'brainwatch-service-failed' });
  return { installed: true };
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

export async function probeMachine(name, { registry, run = defaultRunInput, home = os.homedir(), env = process.env, now = Date.now } = {}) {
  const machine = registry.machines[name];
  if (!machine) throw Object.assign(new Error(`machine ${name} is not registered`), { code: 'machine-unknown' });
  if (machine.host === os.hostname() || machine.host === `${os.hostname()}.local`) {
    return { ...machine, ...(await probeLocal({ run: defaultRun, home, env, now })) };
  }
  return { ...machine, ...(await probeRemote({ ...machine, key: path.join(home, '.ssh', 'swarm_ed25519') }, { run, now })) };
}

export function doctorLines(machine, { laneChecks = true } = {}) {
  const lines = [];
  const add = (ok, text) => lines.push(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  add(machine.health !== 'unreachable', `ssh ${machine.user}@${machine.host}`);
  if (machine.os === 'macos') {
    add(machine.disablesleep === true || machine.role === 'remote+worker', 'sleep settings');
    add(machine.fileVault !== true, machine.fileVault ? 'FileVault is on (a reboot waits for the password at the machine)' : 'FileVault off');
  }
  if (machine.os === 'macos') {
    add(machine.remoteLogin === true, machine.remoteLogin ? 'Remote Login on' : 'Remote Login off: turn it on by hand');
    add(machine.screenSharing === true, machine.screenSharing ? 'Screen Sharing on' : 'Screen Sharing off: turn it on by hand');
  } else {
    add(machine.health !== 'unreachable', machine.health !== 'unreachable' ? 'ssh server reachable' : 'ssh server unreachable');
  }
  add(machine.runner === 'running', machine.runner === 'running' ? 'worker runner alive' : 'worker runner stopped: swarm worker install');
  if (Number.isFinite(machine.freeDiskGb)) add(machine.freeDiskGb >= 20, `free disk ${machine.freeDiskGb} GB`);
  if (machine.memoryPressure) add(machine.memoryPressure !== 'hard', `memory pressure ${machine.memoryPressure}`);
  if (machine.onCharger !== undefined) add(machine.onCharger || machine.role !== 'remote+worker', `power ${machine.onCharger ? 'charger' : 'battery'}${machine.batteryPercent !== undefined ? ` ${machine.batteryPercent}%` : ''}`);
  if (machine.throttled !== undefined) add(!machine.throttled, machine.throttled ? 'CPU is throttling' : 'CPU not throttling');
  if (laneChecks) {
    const lanes = machine.lanes ?? [];
    add(lanes.length > 0, lanes.length ? `lanes ${lanes.join(', ')}` : 'no lane CLIs found');
  }
  return lines;
}

export async function listMachines({ registry, run = defaultRunInput, home = os.homedir(), env = process.env, now = Date.now, probe = false } = {}) {
  const rows = [];
  for (const name of failoverOrder(registry)) {
    const machine = registry.machines[name];
    if (!machine) continue;
    const data = probe ? await probeMachine(name, { registry, run, home, env, now }).catch(error => ({ ...machine, health: 'unreachable', error: error.message })) : machine;
    const fields = [
      name === registry.brain ? '*' : ' ',
      name,
      data.role,
      data.host,
      data.os ?? '?',
      data.ramGb !== undefined ? `${data.ramGb}GB` : null,
      data.slots !== undefined ? `${data.slots}` : null,
      Array.isArray(data.lanes) && data.lanes.length ? data.lanes.join(',') : null,
      data.health ?? null,
      data.freeDiskGb !== undefined ? `${data.freeDiskGb}GB` : null,
      data.role === 'remote+worker' ? ghostState(data) : null,
    ].filter(value => value !== null && value !== undefined);
    rows.push(fields.join('\t'));
  }
  return rows.length ? `${rows.join('\n')}\n` : 'no machines registered\n';
}


export async function lockSshToKey({ target, key, run = defaultRunInput } = {}) {
  const script = [
    'set -e',
    'sudo -n true >/dev/null 2>&1 || { echo "NEED_SUDO"; exit 3; }',
    'CFG=/etc/ssh/sshd_config',
    'sudo cp "$CFG" "$CFG.swarm-backup" 2>/dev/null || true',
    'sudo sed -i "" -e "s/^#\?PasswordAuthentication .*/PasswordAuthentication no/" -e "s/^#\?KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/" -e "s/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/" "$CFG"',
    'sudo launchctl kickstart -k system/com.openssh.sshd >/dev/null 2>&1 || true',
    'echo SSH_KEY_ONLY',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key, tty: true });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 60000 });
  const stdout = String(result.stdout ?? '');
  if (/SSH_KEY_ONLY/.test(stdout)) return { keyOnly: true };
  if (/NEED_SUDO/.test(stdout)) throw Object.assign(new Error('SSH key-only needs one sudo password on the target; run it by hand'), { code: 'ssh-key-only-sudo' });
  throw Object.assign(new Error(`SSH key-only failed: ${stdout.slice(-300)}`), { code: 'ssh-key-only-failed' });
}


export async function ensureWorkerKey({ target, key, name, run = defaultRunInput, home = os.homedir() } = {}) {
  const script = [
    'set -e',
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    `if [ ! -f "$HOME/.ssh/swarm_ed25519" ]; then ssh-keygen -t ed25519 -N "" -C "swarm-worker@${name}" -f "$HOME/.ssh/swarm_ed25519" >/dev/null; fi`,
    'cat "$HOME/.ssh/swarm_ed25519.pub"',
  ].join('\n');
  const argv = sshCommandArgv(target, 'bash -s', { key });
  const result = await run(argv[0], argv.slice(1), { input: `${script}\n`, timeout: 60000 });
  const pub = String(result.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+/.test(pub)) throw Object.assign(new Error('worker key generation failed'), { code: 'worker-key-failed' });
  const dir = path.join(home, '.ssh');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const authFile = path.join(dir, 'authorized_keys');
  const existing = await fs.readFile(authFile, 'utf8').catch(() => '');
  if (!existing.includes(pub)) await fs.appendFile(authFile, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pub}\n`, { mode: 0o600 });
  await fs.chmod(authFile, 0o600).catch(() => {});
  return { pub };
}

export async function writeWorkerBrainPointer({ target, key, brain, name, run = defaultRunInput } = {}) {
  const payload = JSON.stringify({ host: brain.host, user: brain.user, machine: name });
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
  const keyFlag = flag(rest, '--key'); rest = keyFlag.rest;
  const registerOnly = rest.includes('--register-only');
  rest = rest.filter(arg => arg !== '--register-only');
  const target = parseTarget(rest[0]);
  if (!target) return bad(`${MACHINE_USAGE}`);
  const name = nameFlag.value ?? nameFromHost(target.host);
  if (!MACHINE_NAME_RE.test(name)) return bad(`invalid machine name ${name}\n`);
  const role = roleFlag.value === 'both' || roleFlag.value === 'remote+worker' || (!roleFlag.value && name === 'ghost') ? 'remote+worker' : roleFlag.value === 'brain' ? 'brain' : 'worker';
  const key = keyFlag.value ?? path.join(home, '.ssh', 'swarm_ed25519');
  try {
    const keyState = await ensureKey(key, { run: interactive });
    if (!(await keyWorks(target, key, { run: runShell }))) await copyKey(target, key, { run: interactive });
    await ensureWorkerKey({ target, key, name, run }).catch(() => null);
    const before = await probeRemote({ ...target, key }, { run, now }).catch(() => null);
    const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
    const brain = role === 'brain' ? { host: target.host, user: target.user } : registry.brain ? registry.machines[registry.brain] : { host: os.hostname(), user: os.userInfo().username };
    const brainName = role === 'brain' ? name : (registry.brain ?? 'mini');
    let runnerWarning = null;
    let bootstrap = { warnings: [] };
    if (!registerOnly) {
      try { await syncRunner({ target, key, installRoot, home, run: runShell }); }
      catch (error) { runnerWarning = `WARN ${error.message}`; }
      bootstrap = await runBootstrap({ target, key, name, role, brainHost: brain?.host, brainUser: brain?.user, run });
      if (runnerWarning) bootstrap.warnings.push(runnerWarning);
    }
    const probed = await probeRemote({ ...target, key }, { run, now }).catch(() => before ?? {});
    const machine = measuredOnly({
      name,
      role,
      host: target.host,
      user: target.user,
      os: probed.os ?? before?.os,
      arch: probed.arch,
      chip: probed.chip,
      ramGb: probed.ramGb,
      cores: probed.cores,
      slots: slotsFlag.value ? Number(slotsFlag.value) : probed.ramGb >= 16 ? 4 : probed.ramGb >= 8 ? 2 : 1,
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
      lastSeen: new Date(now()).toISOString(),
    });
    await addMachine(machine, { file: deps.registryFile ?? machinesFile({ env, home }), env, home, brain: role === 'brain' });
    const after = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
    if (!after.brain) {
      const localHost = os.hostname().toLowerCase();
      const localName = localHost.includes('mini') ? 'mini' : nameFromHost(os.hostname());
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
      try {
        if ((probed.os ?? 'macos') === 'linux') await installWorkerServiceLinux({ target, key, machine: name, brain, run: runShell });
        else {
          await installWorkerService({ target, key, machine: name, brain, run: runShell, home: `/Users/${target.user}` });
          await installBrainWatchService({ target, key, run: runShell, home: `/Users/${target.user}` });
        }
      } catch (error) {
        bootstrap.warnings.push(`WARN ${error.message}`);
      }
    }
    const warnings = bootstrap.warnings.length ? `\n${bootstrap.warnings.join('\n')}` : '';
    return out(`machine ${name} ${registerOnly ? 'registered (setup pending: run the same command with the target password to finish)' : 'ready'}: ${target.user}@${target.host} · ${machine.slots} slots · lanes ${machine.lanes.length ? machine.lanes.join(', ') : 'none yet'}${keyState.created ? ' · key created' : ''}${warnings}\n`);
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
  if (machine.os === 'macos' && machine.role !== 'remote+worker' && machine.disablesleep !== true) {
    lines.push('sudo -n pmset -a disablesleep 1 >/dev/null 2>&1 && sudo -n pmset -c sleep 0 >/dev/null 2>&1 && echo FIXED sleep || echo MANUAL sleep');
  }
  if (machine.os === 'macos' && machine.role !== 'remote+worker') {
    lines.push('V=$(defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates 2>/dev/null || echo missing); if [ "$V" = "0" ]; then echo FIXED updates; else sudo -n defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false >/dev/null 2>&1 && echo FIXED updates || echo MANUAL updates; fi');
  }
  if (machine.runner && machine.runner !== 'running') {
    lines.push('launchctl kickstart -k "gui/$(id -u)/com.project-swarm.worker" >/dev/null 2>&1 && echo FIXED runner || echo MANUAL runner');
  }
  if (Number.isFinite(machine.freeDiskGb) && machine.freeDiskGb < 20) {
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
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const probe = args.includes('--probe');
  const text = await listMachines({ registry, home, env, now, probe, run: deps.run });
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
  const dest = `${machine.host}.local`;
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

export async function runAttach(args, deps = {}) {
  if (args.includes('--help') || args.includes('-h')) return out('Usage: swarm attach [machine]\n');
  const { env = process.env, home = os.homedir() } = deps;
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const name = args[0] ?? registry.brain;
  const machine = registry.machines[name];
  if (!machine) return bad(`unknown brain ${name ?? ''}\n`);
  const key = path.join(home, '.ssh', 'swarm_ed25519');
  const argv = [
    'ssh', '-t', '-o', 'StrictHostKeyChecking=accept-new', '-i', key,
    '--', `${machine.user}@${machine.host}`, 'zsh -lc "tmux new -A -s swarm"',
  ];
  const code = await (deps.runInteractive ?? spawnInherit)(argv[0], argv.slice(1));
  return { stdout: '', exitCode: code };
}

export async function runRemoteSetup(args, deps = {}) {
  const { env = process.env, home = os.homedir() } = deps;
  const target = parseTarget(args[0]);
  if (!target) return bad(`Usage: swarm remote setup <user>@<brain-host>\n`);
  const key = path.join(home, '.ssh', 'swarm_ed25519');
  await ensureKey(key, { run: deps.runInteractive ?? spawnInherit });
  if (!(await keyWorks(target, key, { run: deps.runShell ?? defaultRun }))) await copyKey(target, key, { run: deps.runInteractive ?? spawnInherit });
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const lines = [
    `Host mini`,
    `  HostName ${target.host}`,
    `  User ${target.user}`,
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
    if (!machine || name === 'mini') continue;
    lines.push('', `Host ${name}`, `  HostName ${machine.host}.local`, `  User ${machine.user}`, `  ProxyJump mini`, `  IdentityFile ${key}`, `  IdentitiesOnly yes`, `  StrictHostKeyChecking accept-new`);
  }
  const configFile = path.join(home, '.ssh', 'config');
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const existing = await fs.readFile(configFile, 'utf8').catch(() => '');
  if (!/^# swarm machine setup$/m.test(existing)) await fs.appendFile(configFile, `\n# swarm machine setup\n${lines.join('\n')}\n`, { mode: 0o600 });
  return out(`wrote ~/.ssh/config (mini + workers via ProxyJump mini)\nTest: ssh mini 'hostname'\nAttach: swarm attach\nScreen: swarm screen bean\n`);
}

export async function runBrainMove(args, deps = {}) {
  const { env = process.env, home = os.homedir(), now = Date.now, run = defaultRun } = deps;
  const targetName = args[0];
  const force = args.includes('--force');
  if (!targetName) return bad(`Usage: swarm brain move <machine> [--force]\n`);
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  const target = registry.machines[targetName];
  if (!target) return bad(`unknown machine ${targetName}\n`);
  if (target.role === 'remote+worker' && !force) {
    const probed = await probeMachine(targetName, { registry, home, env, now, run: deps.runInput ?? defaultRunInput }).catch(() => null);
    if (!probed || probed.onCharger !== true || probed.lidOpen === false) return bad(`refusing to move the brain to ${targetName}: it is on battery or the lid is closed. Use --force only if you accept the swarm stopping when it sleeps.\n`);
  }
  const lock = await acquireBrainLock({ file: deps.brainLockFile, machine: os.hostname(), now: now() });
  try {
    const stateDir = machineStateDir({ env, home });
    await pauseWorkerQueue({ file: path.join(stateDir, 'worker-queue.paused'), reason: `brain-move:${targetName}` }).catch(() => null);
    const projects = await listProjects({ file: projectsFile(env), env, home }).catch(() => []);
    for (const project of projects) await snapshotProjectState(project.root, { stateDir, projectId: project.id }).catch(() => null);
    const source = registry.machines[registry.brain];
    if (source && source.host !== target.host && deps.syncState !== false) {
      const key = path.join(home, '.ssh', 'swarm_ed25519');
      const rsync = await (deps.runShell ?? defaultRun)('rsync', ['-a', '-e', `ssh -T -o BatchMode=yes -i ${key}`, `${stateDir}/`, `${target.user}@${target.host}:~/.project-swarm/state/`], { timeout: 10 * 60 * 1000 }).catch(error => ({ code: 1, stderr: error.message }));
      if (rsync.code !== 0) return bad(`state sync failed: ${sanitize(rsync.stderr ?? '')}\n`);
    }
    await setBrain(targetName, { file: deps.registryFile ?? machinesFile({ env, home }), env, home });
    await writeBrainPointer({ host: target.host, user: target.user, machine: targetName }, { file: deps.brainPointerFile ?? brainPointerFile({ env, home }), env, home });
    const key = path.join(home, '.ssh', 'swarm_ed25519');
    for (const [name, machine] of Object.entries(registry.machines)) {
      if (name === targetName) continue;
      const pointer = JSON.stringify({ host: target.host, user: target.user, machine: targetName });
      await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', key, '--', `${machine.user}@${machine.host}`, `mkdir -p ~/.project-swarm && printf '%s\\n' '${pointer}' > ~/.project-swarm/brain.json`], { timeout: 30000 }).catch(() => null);
    }
    if (deps.startBrain !== false) {
      const start = await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-i', path.join(home, '.ssh', 'swarm_ed25519'), '--', `${target.user}@${target.host}`, 'zsh -lc "tmux new -d -s swarm \'swarm watch --all --keep-up\' 2>/dev/null || true"'], { timeout: 60000 }).catch(error => ({ code: 1, stderr: error.message }));
      if (start.code !== 0) return bad(`brain moved in the registry but the orchestrator did not start on ${targetName}: ${sanitize(start.stderr ?? '')}\n`);
    }
    await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-i', key, '--', `${target.user}@${target.host}`, 'rm -f ~/.project-swarm/state/worker-queue.paused'], { timeout: 30000 }).catch(() => null);
    await resumeWorkerQueue({ file: path.join(stateDir, 'worker-queue.paused') }).catch(() => null);
    const warning = target.role === 'remote+worker' && force ? '\nwarning: the swarm stops if this machine sleeps or leaves the network' : '';
    return out(`brain moved to ${targetName} (${target.user}@${target.host}); running tickets keep going; new leases pause until the new brain answers${warning}\n`);
  } finally {
    await releaseBrainLock({ file: deps.brainLockFile, machine: os.hostname() }).catch(() => {});
  }
}

export function failoverDecision({ registry, heartbeats = {}, now = Date.now(), silentMs = 3 * 60 * 1000 } = {}) {
  const brain = registry.brain;
  const seen = heartbeats[brain];
  if (seen && now - seen <= silentMs) return { action: 'none', brain };
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
    if (!id || !holder) return bad(`Usage: swarm worker claim ID --holder H\n`);
    try { const item = await claimWorkerItem(id, holder, { file, env, home, now }); return out(`${JSON.stringify(item)}\n`); } catch (error) { return bad(`${sanitize(error.message)}\n`); }
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
      const status = report?.status === 'pass' ? 'done' : ['rate-limited', 'logged-out'].includes(report?.status) ? 'requeue' : 'failed';
      const item = await reportWorkerItem(id, holder, { status, report, file, env, home, now });
      return out(`${JSON.stringify(item)}\n`);
    } catch (error) { return bad(`${sanitize(error.message)}\n`); }
  }
  if (verb === 'run') {
    const lanesFile = await readWorkerLanes(home);
    const name = deps.machineName ?? lanesFile?.name ?? os.hostname();
    const lanes = lanesFile?.lanes_installed ?? WORKER_LANE_NAMES;
    const paths = workerPaths(home);
    const brain = (await readBrainPointer({ env, home }).catch(() => null)) ?? (await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home }).then(registry => registry.brain ? registry.machines[registry.brain] : null));
    if (!brain) return bad('no brain registered; run swarm machine add on the brain or set ~/.project-swarm/brain.json\n');
    const transport = deps.transport ?? createSshTransport({ brain });
    const once = rest.includes('--once');
    const runner = deps.runnerPath ?? path.join(projectSwarmHome({ env, home }), 'current', 'tools', 'swarm.mjs');
    const iteration = async () => {
      const local = await probeLocal({ run: deps.runShell ?? defaultRun, home, env, now });
      const brainReachable = await (deps.runShell ?? defaultRun)('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-i', path.join(home, '.ssh', 'swarm_ed25519'), '--', `${brain.user}@${brain.host}`, 'true'], { timeout: 10000 }).then(() => true, () => false);
      return runWorkerOnce({
        lanes,
        holder: `${name}/${process.pid}`,
        paths,
        runner,
        transport,
        maxSlots: lanesFile?.slots ?? 1,
        freeDiskGb: local.freeDiskGb,
        role: lanesFile?.role,
        onCharger: local.onCharger,
        lidOpen: local.lidOpen,
        brainReachable,
        userActive: local.userActive === true,
        run: deps.runTicket ?? undefined,
        brain,
        key: path.join(home, '.ssh', 'swarm_ed25519'),
      });
    };
    if (once) {
      const result = await iteration();
      return out(`${JSON.stringify(result)}\n`);
    }
    process.stdout.write(`worker ${name}: pulling from ${brain.user}@${brain.host}\n`);
    for (;;) {
      const result = await iteration();
      process.stdout.write(`${new Date().toISOString()} ${result.action}${result.reason ? ` ${result.reason}` : ''}${result.item ? ` ${result.item.id}` : ''}\n`);
      if (result.action === 'stop') break;
      if (result.action === 'ran') continue;
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
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
    return out(`worker: ${lanesFile?.name ?? os.hostname()} slots ${lanesFile?.slots ?? '?'} lanes ${(lanesFile?.lanes_installed ?? []).join(', ')}\nqueue: ${items.length} item(s), ${items.filter(item => item.status === 'queued').length} queued\n`);
  }
  return bad(`${WORKER_USAGE}`);
}

export async function runMachineCommand(root, args, deps = {}) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') return out(MACHINE_USAGE);
  if (command === 'add') return runMachineAdd(rest, deps);
  if (command === 'login') return runMachineLogin(rest, deps);
  if (command === 'doctor') return runMachineDoctor(rest, deps);
  if (command === 'list') return runMachineList(rest, deps);
  if (command === 'remove') return runMachineRemove(rest, deps);
  if (command === 'bench') return runWorkerCommand(['bench', ...rest], deps);
  if (command === 'remote' && rest[0] === 'setup') return runRemoteSetup(rest.slice(1), deps);
  return bad(MACHINE_USAGE);
}
