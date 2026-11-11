// SPDX-License-Identifier: Apache-2.0
// Fleet-specific machine settings (names, roles, defaults) live outside the repo.
// Lookup order: $SWARM_MACHINES_LOCAL (exclusive when set), ~/.config/project-swarm/machines.local.json
// (outside every checkout; preferred), ~/.project-swarm/machines.local.json, then
// <repo>/config/machines.local.json (gitignored). See config/machines.example.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MACHINE_LOCAL_DEFAULTS = Object.freeze({
  brainName: 'brain',          // registry name and ~/.ssh/config alias of the brain
  brainHostHint: null,         // substring of the brain's hostname, used to name it on first add
  failoverOrder: [],           // preferred brain failover order (machine names)
  laptops: [],                 // machines that default to role remote+worker (charger + lid rules)
  fileVaultWarn: [],           // full-time workers where FileVault is a warning, not a failure
  backupWorker: null,          // worker that receives `swarm fleet backup`
  sessionDefaults: {},         // repo name -> machine for `swarm session start <repo>`
  sessionModels: {},           // repo name -> default model for new sessions (--model overrides)
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function machineLocalConfigPaths({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  if (env.SWARM_MACHINES_LOCAL) return [env.SWARM_MACHINES_LOCAL];
  return [
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'project-swarm', 'machines.local.json'),
    path.join(env.SWARM_HOME || path.join(home, '.project-swarm'), 'machines.local.json'),
    path.join(repoRoot, 'config', 'machines.local.json'),
  ].filter(Boolean);
}

export function loadMachineLocalConfig({ env = process.env, home, override } = {}) {
  if (override) return { ...MACHINE_LOCAL_DEFAULTS, ...override };
  for (const file of machineLocalConfigPaths({ env, home: home ?? (env.HOME || os.homedir()) })) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try { return { ...MACHINE_LOCAL_DEFAULTS, ...JSON.parse(text), source: file }; }
    catch (error) { throw Object.assign(new Error(`invalid machine config ${file}: ${error.message}`), { code: 'machine-local-config' }); }
  }
  return { ...MACHINE_LOCAL_DEFAULTS };
}
