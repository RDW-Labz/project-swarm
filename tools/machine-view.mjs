// SPDX-License-Identifier: Apache-2.0
import { failoverOrder, publicMachine, readRegistry } from './machine-registry.mjs';
import { ghostState } from './worker-runner.mjs';

const MEASURED = new Set(['os', 'arch', 'chip', 'ramGb', 'cores', 'slots', 'lanes', 'health', 'freeDiskGb', 'memoryPressure', 'batteryPercent', 'onCharger', 'lidOpen', 'chargeLimit', 'fileVault', 'remoteLogin', 'screenSharing', 'runner', 'updatedAt', 'lastSeen']);

export function machineRow(name, machine, { brain = null, running = 0 } = {}) {
  const row = { name, brain: name === brain };
  for (const key of MEASURED) if (machine[key] !== undefined && machine[key] !== null && machine[key] !== '') row[key] = machine[key];
  if (machine.role === 'remote+worker') row.state = ghostState({ role: machine.role, onCharger: machine.onCharger, lidOpen: machine.lidOpen, brainReachable: machine.health !== 'unreachable', running, userActive: false });
  return row;
}

export function buildMachineView({ registry, runningByMachine = {}, now = Date.now } = {}) {
  if (!registry) return null;
  const machines = failoverOrder(registry)
    .filter(name => registry.machines[name])
    .map(name => { const machine = registry.machines[name]; return machineRow(name, machine, { brain: registry.brain, running: runningByMachine[name] ?? runningByMachine[machine.host] ?? 0 }); });
  return { at: new Date(now()).toISOString(), brain: registry.brain, order: failoverOrder(registry), machines };
}

export async function readMachineView({ file, env, home, runningByMachine = {}, now = Date.now } = {}) {
  try {
    const registry = await readRegistry({ file, env, home });
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
    if (bits.length) parts.push(`${row.name} ${bits.join(' · ')}`);
  }
  return parts.length ? parts.join(' · ') : '';
}

export { publicMachine };
