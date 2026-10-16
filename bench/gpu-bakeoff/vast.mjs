// SPDX-License-Identifier: Apache-2.0
// Manual rental helper for the owner-approved Vast.ai bake-off. Swarm itself never rents anything and nothing in tools/ imports this file;
// it is run by hand:
//   node bench/gpu-bakeoff/vast.mjs rent --offer ID --hours 4 --max-usd 15 [--disk 150]
//   node bench/gpu-bakeoff/vast.mjs status | destroy [--id ID]
// `rent` writes the instance id to ~/.project-swarm-scratch/vast-instance.json and prints it first thing (so it can be destroyed in the
// Vast console), then starts a detached reaper (under caffeinate -i, so the Mac stays awake) that destroys the instance at the deadline.
// The API key is read from the Keychain (project-swarm / vast.api_key) inside this process and is never printed or logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const API = 'https://console.vast.ai/api/v0';
export const VM_IMAGE = 'docker.io/vastai/kvm:ubuntu_terminal';
export const STATE_FILE = path.join(os.homedir(), '.project-swarm-scratch', 'vast-instance.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function readKey(exec = execFileSync) {
  const key = String(exec('security', ['find-generic-password', '-s', 'project-swarm', '-a', 'vast.api_key', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  if (!key) throw new Error('no Vast key in the Keychain (project-swarm / vast.api_key)');
  return key;
}

export function createClient(key, fetchImpl = fetch) {
  const call = async (method, url, body) => {
    const response = await fetchImpl(`${API}${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (!response.ok) throw new Error(`Vast ${method} ${url} failed: HTTP ${response.status} ${String(json?.msg ?? json?.error ?? text).slice(0, 160)}`);
    return json;
  };
  return { call };
}

// An offer is rentable for this run only if it is the approved kind of machine and 4 hours at its price stays under the cap.
export function checkOffer(offer, { hours, maxUsd }) {
  if (!offer) throw new Error('offer not found (it may have been rented by someone else)');
  const problems = [];
  if (!/RTX PRO 6000/.test(offer.gpu_name ?? '')) problems.push(`gpu is ${offer.gpu_name}, not an RTX PRO 6000`);
  if (offer.num_gpus !== 1) problems.push(`${offer.num_gpus} GPUs, want 1`);
  if (offer.vms_enabled !== true) problems.push('not a VM-capable host (Docker needs a VM)');
  if (offer.rentable === false) problems.push('not rentable now');
  if (offer.verification && offer.verification !== 'verified') problems.push(`host is ${offer.verification}`);
  const worst = (offer.dph_total ?? Infinity) * hours;
  if (!(worst <= maxUsd * 0.8)) problems.push(`$${(offer.dph_total ?? NaN).toFixed?.(3)}/h for ${hours} h is $${worst.toFixed?.(2)}, over 80% of the $${maxUsd} cap (the rest is for disk and traffic)`);
  if (problems.length) throw new Error(`offer ${offer.id} refused: ${problems.join('; ')}`);
  return { worstUsd: worst };
}

export const createBody = ({ disk = 150, label = 'swarm-bakeoff' } = {}) => ({ image: VM_IMAGE, disk, runtype: 'ssh_direct', label, vm: true });
export const deadlineAt = (now, hours) => new Date(now + hours * 3600000).toISOString();

export async function findOffer(client, id) {
  const body = await client.call('POST', '/bundles/', { num_gpus: { eq: 1 }, gpu_ram: { gte: 90000 }, rentable: { eq: true }, type: 'ondemand', limit: 500 });
  return (body?.offers ?? []).find(item => item.id === id) ?? null;
}

export async function getInstance(client, id) {
  const body = await client.call('GET', `/instances/${id}/`);
  return body?.instances ?? null;
}

export async function destroyInstance(client, id, { retries = 5, wait = sleep } = {}) {
  let last;
  for (let n = 0; n < retries; n += 1) {
    try { await client.call('DELETE', `/instances/${id}/`); return true; } catch (error) { last = error; await wait(2000); }
  }
  throw last;
}

export async function waitRunning(client, id, { timeoutMs = 600000, wait = sleep, now = Date.now } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    const instance = await getInstance(client, id).catch(() => null);
    if (instance?.actual_status === 'running' && instance.ssh_host && instance.ssh_port) return instance;
    if (now() >= until) throw new Error(`instance ${id} did not reach running with an ssh address within ${Math.round(timeoutMs / 60000)} minutes (last status ${instance?.actual_status ?? 'unknown'})`);
    await wait(10000);
  }
}

export function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 });
}
export function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// The reaper: sleeps until the deadline and then destroys the instance. It never exits early because of an API answer (a wrong guess
// there would leave the rental running); it stops only when the state file says the instance was destroyed by hand.
export async function reap(client, { id, at }, { wait = sleep, now = Date.now, log = () => {}, state = readState } = {}) {
  const deadline = Date.parse(at);
  if (!Number.isFinite(deadline)) throw new Error('reap needs --at as an ISO time');
  while (now() < deadline) {
    if (state()?.destroyedAt) { log('already destroyed by hand'); return 'gone'; }
    await wait(Math.min(30000, Math.max(1000, deadline - now())));
  }
  await destroyInstance(client, id, { wait });
  log(`destroyed ${id} at the deadline`);
  return 'destroyed';
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };

async function main(args) {
  const [command] = args;
  const client = createClient(readKey());
  const log = message => process.stderr.write(`[vast] ${message}\n`);
  if (command === 'rent') {
    const id = Number(flag(args, 'offer')), hours = Number(flag(args, 'hours') ?? 4), maxUsd = Number(flag(args, 'max-usd') ?? 15), disk = Number(flag(args, 'disk') ?? 150);
    if (!Number.isInteger(id) || !(hours > 0 && hours <= 4) || !(maxUsd > 0 && maxUsd <= 15)) throw new Error('usage: rent --offer ID --hours H(<=4) --max-usd N(<=15) [--disk GB]');
    const offer = await findOffer(client, id);
    const { worstUsd } = checkOffer(offer, { hours, maxUsd });
    log(`offer ${id}: ${offer.gpu_name} $${offer.dph_total.toFixed(3)}/h, ${hours} h = $${worstUsd.toFixed(2)} (cap $${maxUsd})`);
    const created = await client.call('PUT', `/asks/${id}/`, createBody({ disk }));
    const instanceId = created?.new_contract;
    if (!instanceId) throw new Error(`Vast did not return an instance id: ${JSON.stringify(created).slice(0, 200)}`);
    const deadline = deadlineAt(Date.now(), hours);
    writeState({ instanceId, offerId: id, createdAt: new Date().toISOString(), deadline, hourlyUsd: offer.dph_total, maxUsd });
    process.stdout.write(`INSTANCE_ID=${instanceId}  (destroy in the Vast console if anything goes wrong; deadline ${deadline})\n`);
    const reaper = spawn('caffeinate', ['-i', process.execPath, fileURLToPath(import.meta.url), 'reap', '--id', String(instanceId), '--at', deadline], { detached: true, stdio: ['ignore', fs.openSync(path.join(path.dirname(STATE_FILE), 'vast-reaper.log'), 'a'), fs.openSync(path.join(path.dirname(STATE_FILE), 'vast-reaper.log'), 'a')] });
    reaper.unref();
    log(`reaper started (pid ${reaper.pid}, under caffeinate -i)`);
    try {
      const instance = await waitRunning(client, instanceId);
      writeState({ ...readState(), ssh: { host: instance.ssh_host, port: instance.ssh_port }, reaperPid: reaper.pid });
      process.stdout.write(`SSH_HOST=${instance.ssh_host}\nSSH_PORT=${instance.ssh_port}\n`);
    } catch (error) {
      log(`${error.message}; destroying`);
      await destroyInstance(client, instanceId);
      throw error;
    }
    return;
  }
  if (command === 'destroy') {
    const id = Number(flag(args, 'id') ?? readState()?.instanceId);
    if (!Number.isInteger(id)) throw new Error('no instance id (pass --id)');
    await destroyInstance(client, id);
    const recorded = readState();
    if (recorded) writeState({ ...recorded, destroyedAt: new Date().toISOString() });
    process.stdout.write(`destroyed ${id}\n`);
    return;
  }
  if (command === 'status') {
    const state = readState();
    if (!state) { process.stdout.write('no rental recorded\n'); return; }
    const instance = await getInstance(client, state.instanceId).catch(() => null);
    process.stdout.write(`${JSON.stringify({ ...state, actual_status: instance?.actual_status ?? 'gone' })}\n`);
    return;
  }
  if (command === 'reap') { await reap(client, { id: Number(flag(args, 'id')), at: flag(args, 'at') }, { log }); return; }
  throw new Error('usage: vast.mjs rent|status|destroy|reap');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2)).catch(error => { process.stderr.write(`[vast] ${error.message}\n`); process.exitCode = 1; });
