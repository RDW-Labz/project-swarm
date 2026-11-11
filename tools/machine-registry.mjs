// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MACHINE_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,252}[A-Za-z0-9])?$/;
export const MACHINE_ROLES = Object.freeze(['brain', 'worker', 'remote+worker']);
import { loadMachineLocalConfig } from './machine-local-config.mjs';

export const DEFAULT_FAILOVER_ORDER = Object.freeze([]);
const configuredOrder = () => { try { const order = loadMachineLocalConfig().failoverOrder; return Array.isArray(order) && order.length ? [...order] : [...DEFAULT_FAILOVER_ORDER]; } catch { return [...DEFAULT_FAILOVER_ORDER]; } };
export const REGISTRY_VERSION = 1;

export function projectSwarmHome({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_HOME || path.join(home, '.project-swarm');
}

export function machinesFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_MACHINES_FILE || path.join(projectSwarmHome({ env, home }), 'machines.json');
}

export function brainPointerFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_BRAIN_FILE || path.join(projectSwarmHome({ env, home }), 'brain.json');
}

export function brainLockFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return env.SWARM_BRAIN_LOCK || path.join(projectSwarmHome({ env, home }), 'brain.lock');
}

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

export function emptyRegistry() {
  return { version: REGISTRY_VERSION, brain: null, order: configuredOrder(), epoch: 0, machines: {} };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateMachine(name, machine) {
  if (typeof name !== 'string' || !MACHINE_NAME_RE.test(name)) throw fail('machine-invalid', `invalid machine name ${name}`);
  if (!isPlainObject(machine)) throw fail('machine-invalid', `${name} must be an object`);
  if (!MACHINE_ROLES.includes(machine.role)) throw fail('machine-invalid', `${name}.role must be ${MACHINE_ROLES.join(', ')}`);
  if (typeof machine.host !== 'string' || !MACHINE_HOST_RE.test(machine.host)) throw fail('machine-invalid', `${name}.host must be a host name or IP`);
  for (const field of ['ip', 'tailscaleHost']) if (machine[field] !== undefined && (typeof machine[field] !== 'string' || !MACHINE_HOST_RE.test(machine[field]))) throw fail('machine-invalid', `${name}.${field} must be a host name or IP`);
  if (typeof machine.user !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(machine.user)) throw fail('machine-invalid', `${name}.user is invalid`);
  if (machine.lanes !== undefined && (!Array.isArray(machine.lanes) || machine.lanes.some(lane => typeof lane !== 'string' || !lane))) throw fail('machine-invalid', `${name}.lanes must be a list of lane names`);
  if (machine.capabilities !== undefined && (!Array.isArray(machine.capabilities) || machine.capabilities.some(cap => typeof cap !== 'string' || !/^[a-z0-9-]{1,32}$/.test(cap)))) throw fail('machine-invalid', `${name}.capabilities must be a list of lowercase capability names`);
  if (machine.slots !== undefined && (!Number.isInteger(machine.slots) || machine.slots < 0 || machine.slots > 256)) throw fail('machine-invalid', `${name}.slots must be 0-256 (0 is a brain-only machine)`);
  return machine;
}

export function validateRegistry(data) {
  if (!isPlainObject(data) || data.version !== REGISTRY_VERSION) throw fail('machines-corrupt', 'machines.json is not version 1');
  if (!isPlainObject(data.machines)) throw fail('machines-corrupt', 'machines.json has no machines object');
  if (data.brain !== null && typeof data.brain !== 'string') throw fail('machines-corrupt', 'machines.json brain must be null or a name');
  if (data.epoch !== undefined && (!Number.isInteger(data.epoch) || data.epoch < 0)) throw fail('machines-corrupt', 'machines.json epoch must be a non-negative integer');
  if (!Array.isArray(data.order) || data.order.some(name => typeof name !== 'string')) throw fail('machines-corrupt', 'machines.json order must be a list of names');
  for (const [name, machine] of Object.entries(data.machines)) validateMachine(name, machine);
  if (data.brain !== null && !data.machines[data.brain]) throw fail('machines-corrupt', `brain ${data.brain} is not registered`);
  return data;
}

async function readJson(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw fail('machines-corrupt', `${file} is not valid JSON`);
    throw error;
  }
}

async function writeAtomic(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

export async function withRegistryLock({ file = machinesFile(), timeoutMs = 10000 } = {}, fn) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 60000) { await fs.rm(lock, { recursive: true, force: true }).catch(() => {}); continue; }
      if (Date.now() - started > timeoutMs) throw fail('machines-locked', 'timed out waiting for the machine registry lock');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  try { return await fn(); }
  finally { await fs.rm(lock, { recursive: true, force: true }).catch(() => {}); }
}

export async function readRegistry({ file = machinesFile(), env, home } = {}) {
  const data = await readJson(file);
  if (!data) return emptyRegistry();
  return validateRegistry(data);
}

export async function writeRegistry(data, { file = machinesFile(), env, home } = {}) {
  validateRegistry(data);
  await writeAtomic(file, data);
  return data;
}

export async function addMachine(machine, { file = machinesFile(), env, home, brain = false } = {}) {
  return withRegistryLock({ file }, async () => {
  if (!isPlainObject(machine) || typeof machine.name !== 'string') throw fail('machine-invalid', 'machine.name is required');
  validateMachine(machine.name, machine);
  const registry = await readRegistry({ file, env, home });
  const existing = registry.machines[machine.name] ?? {};
  registry.machines[machine.name] = { ...existing, ...machine, addedAt: existing.addedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (brain) {
    registry.brain = machine.name;
    registry.machines[machine.name].role = 'brain';
  }
  if (!registry.order.includes(machine.name)) registry.order.push(machine.name);
  await writeRegistry(registry, { file, env, home });
  return registry.machines[machine.name];
  });
}

export async function removeMachine(name, { file = machinesFile(), env, home } = {}) {
  return withRegistryLock({ file }, async () => {
  if (!MACHINE_NAME_RE.test(name)) throw fail('machine-invalid', `invalid machine name ${name}`);
  const registry = await readRegistry({ file, env, home });
  if (!registry.machines[name]) return { removed: false, registry };
  delete registry.machines[name];
  registry.order = registry.order.filter(entry => entry !== name);
  if (registry.brain === name) {
    registry.brain = registry.order.find(entry => registry.machines[entry]) ?? null;
    if (registry.brain) registry.machines[registry.brain].role = 'brain';
  }
  await writeRegistry(registry, { file, env, home });
  return { removed: true, registry };
  });
}

export async function setBrain(name, { file = machinesFile(), env, home } = {}) {
  return withRegistryLock({ file }, async () => {
  if (!MACHINE_NAME_RE.test(name)) throw fail('machine-invalid', `invalid brain name ${name}`);
  const registry = await readRegistry({ file, env, home });
  if (!registry.machines[name]) throw fail('machine-unknown', `machine ${name} is not registered`);
  for (const machine of Object.values(registry.machines)) if (machine.role === 'brain') machine.role = machine.name === name ? 'brain' : (machine.role === 'brain' ? 'worker' : machine.role);
  registry.brain = name;
  registry.machines[name].role = 'brain';
  await writeRegistry(registry, { file, env, home });
  return registry;
  });
}

export function failoverOrder(registry) {
  const order = Array.isArray(registry?.order) ? registry.order : [];
  const names = Object.keys(registry?.machines ?? {});
  const merged = [...order.filter(name => names.includes(name)), ...names.filter(name => !order.includes(name))];
  return merged.length ? merged : configuredOrder();
}

export function nextBrain(registry) {
  const order = failoverOrder(registry);
  const current = registry?.brain ? order.indexOf(registry.brain) : -1;
  for (let i = 1; i <= order.length; i += 1) {
    const name = order[(current + i) % order.length];
    if (registry.machines?.[name]) return name;
  }
  return null;
}

export async function readBrainPointer({ file = brainPointerFile(), env, home } = {}) {
  const data = await readJson(file);
  if (!data) return null;
  if (!isPlainObject(data) || typeof data.host !== 'string' || typeof data.user !== 'string') throw fail('brain-pointer-invalid', 'brain.json is not valid');
  return data;
}

export async function writeBrainPointer(pointer, { file = brainPointerFile(), env, home } = {}) {
  await writeAtomic(file, pointer);
  return pointer;
}

export async function acquireBrainLock({ file = brainLockFile(), machine = os.hostname(), now = Date.now(), staleMs = 5 * 60 * 1000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ machine, pid: process.pid, acquiredAt: new Date(now).toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      return { acquired: true, file };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let held = null;
      try { held = JSON.parse(await fs.readFile(file, 'utf8')); } catch { held = null; }
      const at = Date.parse(held?.acquiredAt ?? '');
      if (Number.isFinite(at) && now - at > staleMs) {
        await fs.rm(file, { force: true });
        continue;
      }
      throw fail('brain-locked', `the brain lock is held by ${held?.machine ?? 'another process'} (${held?.pid ?? 'unknown pid'})`);
    }
  }
  throw fail('brain-locked', 'could not acquire the brain lock');
}

export async function releaseBrainLock({ file = brainLockFile(), machine = os.hostname() } = {}) {
  let held = null;
  try { held = JSON.parse(await fs.readFile(file, 'utf8')); } catch { return false; }
  if (held?.machine !== machine) return false;
  await fs.rm(file, { force: true });
  return true;
}

// Measured values are only useful while they are recent. Anything older is hidden rather than shown as current.
export const MEASURED_FRESH_MS = 15 * 60 * 1000;
export const STALE_MEASURED_FIELDS = Object.freeze([
  'os', 'arch', 'chip', 'ramGb', 'cores', 'lanes', 'health', 'freeDiskGb', 'memoryPressure',
  'batteryPercent', 'onCharger', 'lidOpen', 'chargeLimit', 'fileVault', 'fileVaultPolicy', 'remoteLogin', 'screenSharing',
  'runner', 'sleepMinutes', 'disablesleep', 'cpuSpeedLimit', 'cpuSchedulerLimit', 'throttled',
  'userIdleSeconds', 'userActive', 'measuredAt', 'lastSeen',
]);

export function measurementAt(machine) {
  // Only an actual probe stamps measuredAt. Heartbeats may touch updatedAt/lastSeen without measuring disk or heat.
  const at = Date.parse(machine?.measuredAt ?? '');
  return Number.isFinite(at) ? at : NaN;
}

export function withoutStaleMeasurements(machine, { now = Date.now(), freshMs = MEASURED_FRESH_MS } = {}) {
  if (!machine || typeof machine !== 'object') return machine;
  const at = measurementAt(machine);
  if (Number.isFinite(at) && now - at <= freshMs) return { ...machine, stale: false };
  const out = { ...machine, stale: true };
  for (const key of STALE_MEASURED_FIELDS) delete out[key];
  return out;
}

export function publicMachine(machine) {
  const measured = {};
  for (const key of ['role', 'host', 'user', 'os', 'arch', 'chip', 'ramGb', 'cores', 'slots', 'lanes', 'health', 'freeDiskGb', 'memoryPressure', 'batteryPercent', 'onCharger', 'lidOpen', 'chargeLimit', 'fileVault', 'fileVaultPolicy', 'remoteLogin', 'screenSharing', 'runner', 'updatedAt', 'lastSeen']) {
    if (machine[key] !== undefined && machine[key] !== null) measured[key] = machine[key];
  }
  return measured;
}
