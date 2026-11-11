// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import { failoverOrder, publicMachine, readRegistry, withoutStaleMeasurements } from './machine-registry.mjs';
import { laptopState } from './worker-runner.mjs';
import { defaultRun, localAddresses, probeLocal } from './machine-probe.mjs';

const MEASURED = new Set(['os', 'arch', 'chip', 'ramGb', 'cores', 'slots', 'lanes', 'health', 'freeDiskGb', 'memoryPressure', 'batteryPercent', 'onCharger', 'lidOpen', 'chargeLimit', 'fileVault', 'remoteLogin', 'screenSharing', 'runner', 'updatedAt', 'lastSeen']);

export function machineRow(name, machine, { brain = null, running = 0, now = Date.now } = {}) {
  const fresh = withoutStaleMeasurements(machine, { now });
  const row = { name, brain: name === brain };
  for (const key of MEASURED) if (fresh[key] !== undefined && fresh[key] !== null && fresh[key] !== '') row[key] = fresh[key];
  if (fresh.stale) row.stale = true;
  if (fresh.role === 'remote+worker' && !fresh.stale) row.state = laptopState({ role: fresh.role, onCharger: fresh.onCharger, lidOpen: fresh.lidOpen, brainReachable: fresh.health !== 'unreachable', running, userActive: false });
  return row;
}

export function buildMachineView({ registry, runningByMachine = {}, now = Date.now } = {}) {
  if (!registry) return null;
  const machines = failoverOrder(registry)
    .filter(name => registry.machines[name])
    .map(name => { const machine = registry.machines[name]; return machineRow(name, machine, { brain: registry.brain, running: runningByMachine[name] ?? runningByMachine[machine.host] ?? 0, now: now() }); });
  return { at: new Date(now()).toISOString(), brain: registry.brain, order: failoverOrder(registry), machines };
}

export async function readMachineView({ file, env, home, runningByMachine = {}, now = Date.now } = {}) {
  try {
    const registry = await readRegistry({ file, env, home });
    // The brain is this machine: probe it locally every time, never through SSH and never from an old row.
    if (registry.brain && registry.machines[registry.brain]) {
      const brain = registry.machines[registry.brain];
      const addresses = await localAddresses({ run: defaultRun }).catch(() => ({}));
      const localNames = new Set([os.hostname(), os.hostname().replace(/\.local$/, ''), addresses.ip, addresses.tailscaleHost].filter(Boolean));
      const hostnameMatches = os.hostname().toLowerCase().includes(String(brain.name ?? '').toLowerCase());
      if (hostnameMatches || localNames.has(brain.host) || (brain.ip && localNames.has(brain.ip))) {
        const local = await probeLocal({ run: defaultRun, home, env, now }).catch(() => null);
        if (local) registry.machines[registry.brain] = { ...brain, ...local, health: 'ok', host: local.ip ?? brain.host, ip: local.ip ?? brain.ip, measuredAt: local.measuredAt ?? new Date(now()).toISOString() };
      }
    }
    return buildMachineView({ registry, runningByMachine, now });
  } catch {
    return null;
  }
}

export function registryHintText(view) {
  if (!view || !Array.isArray(view.machines) || !view.machines.length) return '';
  const parts = [];
  for (const row of view.machines) {
    const bits = [];
    if (row.brain) bits.push('brain');
    if (row.role && row.role !== 'brain') bits.push(row.role);
    if (row.slots !== undefined) bits.push(`${row.slots} slots`);
    if (row.freeDiskGb !== undefined) bits.push(`${row.freeDiskGb} GB free`);
    if (row.health && row.health !== 'ok') bits.push(row.health);
    if (row.state) bits.push(row.state);
    if (row.stale) bits.push('stale');
    if (bits.length) parts.push(`${row.name} ${bits.join(' · ')}`);
  }
  return parts.length ? parts.join(' · ') : '';
}

export { publicMachine };
