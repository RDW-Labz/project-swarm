// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { failoverOrder, machinesFile, readRegistry, projectSwarmHome } from './machine-registry.mjs';
import { loadMachineLocalConfig } from './machine-local-config.mjs';
import { defaultRun, probeLocal } from './machine-probe.mjs';
import { currentBrain, doctorLines, probeMachine } from './machine-commands.mjs';

const out = text => ({ stdout: text, exitCode: 0 });

export const FLEET_USAGE = [
  'Usage:',
  '  swarm fleet check [--json]        doctor every machine; alert only on failures',
  '  swarm fleet backup               rsync brain state/registry/queue to the backup worker (7 days)',
  '  swarm fleet restore DATE --yes   restore one backup from the backup worker',
].join('\n') + '\n';

async function backupTarget(registry, env, home, override) {
  const preferred = loadMachineLocalConfig({ env, home, override }).backupWorker;
  const name = preferred && registry.machines[preferred] ? preferred : failoverOrder(registry).find(entry => entry !== registry.brain && registry.machines[entry]?.role === 'worker');
  const machine = registry.machines[name];
  if (!machine) throw new Error('no backup worker registered');
  return { name, machine, key: path.join(home, '.ssh', 'swarm_ed25519') };
}

export async function runFleetCommand(args, deps = {}) {
  const { env = process.env, home = os.homedir(), run = defaultRun, now = Date.now } = deps;
  const [verb, ...rest] = args;
  const registry = await readRegistry({ file: deps.registryFile ?? machinesFile({ env, home }), env, home });
  if (verb === 'check') {
    const brain = await currentBrain({ env, home });
    const local = await probeLocal({ run, home, env, now }).catch(() => ({}));
    const localNames = new Set([os.hostname(), os.hostname().replace(/\.local$/, ''), local.ip].filter(Boolean));
    const onBrain = brain && (localNames.has(brain.host) || os.hostname().toLowerCase().includes(String(brain.name ?? '').toLowerCase()));
    if (!onBrain) {
      const adminKey = path.join(home, '.ssh', 'swarm_admin_ed25519');
      const remote = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', adminKey, '--', `${brain.user}@${brain.host}`, "zsh -lc 'swarm fleet check'"], { timeout: 10 * 60 * 1000 });
      return { stdout: String(remote.stdout ?? ''), exitCode: remote.code ?? 1 };
    }
    const results = [];
    for (const name of failoverOrder(registry)) {
      const machine = registry.machines[name];
      if (!machine) continue;
      const probed = await probeMachine(name, { registry, home, env, now }).catch(error => ({ ...machine, health: 'unreachable', error: error.message }));
      const lines = doctorLines(probed);
      const failures = lines.filter(line => line.startsWith('FAIL'));
      results.push({ name, health: probed.health ?? 'unknown', failures, lines });
    }
    if (rest.includes('--json')) return out(`${JSON.stringify(results)}\n`);
    const text = results.map(row => `== ${row.name} ==\n${row.lines.join('\n')}`).join('\n');
    const bad = results.filter(row => row.failures.length);
    if (bad.length) await run('osascript', ['-e', `display notification "fleet check failed: ${bad.map(row => row.name).join(', ')}" with title "Project Swarm"`], { timeout: 15000 }).catch(() => null);
    return { stdout: `${text}\n${bad.length ? `FAIL ${bad.length} machine(s): ${bad.map(row => row.name).join(', ')}\n` : 'fleet check: all machines ok\n'}`, exitCode: bad.length ? 1 : 0 };
  }
  if (verb === 'backup') {
    const { name, machine, key } = await backupTarget(registry, env, home, deps.machineConfig);
    const stamp = new Date(now()).toISOString().slice(0, 10);
    const root = projectSwarmHome({ env, home });
    const dest = `${machine.user}@${machine.host}:~/.project-swarm-backups/brain/${stamp}/`;
    const mkdir = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-i', key, '--', `${machine.user}@${machine.host}`, 'mkdir -p "$HOME/.project-swarm-backups/brain"'], { timeout: 30000 });
    if (mkdir.code !== 0) return { stdout: `backup failed: ${mkdir.stderr ?? ''}\n`, exitCode: 1 };
    const paths = ['state', 'machines.json', 'projects.json', 'spend'];
    for (const item of paths) {
      const source = path.join(root, item);
      if (!(await fs.stat(source).then(() => true, () => false))) continue;
      const copy = await run('rsync', ['-a', '-e', `ssh -T -o BatchMode=yes -i ${key}`, `${source}`, dest], { timeout: 30 * 60 * 1000 });
      if (copy.code !== 0) return { stdout: `backup failed on ${item}: ${copy.stderr ?? ''}\n`, exitCode: 1 };
    }
    const prune = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-i', key, '--', `${machine.user}@${machine.host}`, 'cd "$HOME/.project-swarm-backups/brain" && ls -1d 20??-??-?? | sort | head -n -7 | xargs -r rm -rf'], { timeout: 30000 });
    return { stdout: `backup ${stamp} -> ${name}${prune.code ? ` (prune warning: ${prune.stderr ?? ''})` : ''}\n`, exitCode: 0 };
  }
  if (verb === 'restore') {
    const date = rest.find(value => /^\\d{4}-\\d{2}-\\d{2}$/.test(value));
    if (!date) return { stdout: FLEET_USAGE, exitCode: 1 };
    if (!rest.includes('--yes')) return { stdout: `restore ${date} is dry-run only; add --yes to write\n`, exitCode: 0 };
    const { name, machine, key } = await backupTarget(registry, env, home, deps.machineConfig);
    const root = projectSwarmHome({ env, home });
    for (const item of ['state', 'machines.json', 'projects.json', 'spend']) {
      const source = `${machine.user}@${machine.host}:~/.project-swarm-backups/brain/${date}/${item}`;
      const copy = await run('rsync', ['-a', '--delete', '-e', `ssh -T -o BatchMode=yes -i ${key}`, source, `${root}/`], { timeout: 30 * 60 * 1000 });
      if (copy.code !== 0) return { stdout: `restore failed on ${item}: ${copy.stderr ?? ''}\n`, exitCode: 1 };
    }
    return { stdout: `restored ${date} from ${name}\n`, exitCode: 0 };
  }
  return { stdout: FLEET_USAGE, exitCode: 1 };
}
