// SPDX-License-Identifier: Apache-2.0
// Manual rental helper for the owner-approved Vast.ai bake-off. Swarm itself never rents anything and nothing in tools/ imports this file;
// it is run by hand:
//   node bench/gpu-bakeoff/vast.mjs rent --offer ID --hours 4 --max-usd 15 [--disk 150] [--mode vm|container]
//   node bench/gpu-bakeoff/vast.mjs search --mode container
//   node bench/gpu-bakeoff/vast.mjs status | destroy [--id ID]
// `rent` writes the instance id to ~/.project-swarm-scratch/vast-instance.json and prints it first thing (so it can be destroyed in the
// Vast console), then starts a detached reaper (under caffeinate -i, so the Mac stays awake) that destroys the instance at the deadline.
// The API key is read from the Keychain (project-swarm / vast.api_key) inside this process and is never printed or logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PINNED_IMAGE } from '../../tools/gpu.mjs';

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

// An offer is rentable for this run only if it is the approved kind of machine and the worst case (4 hours at its price plus about 100 GB of downloads) stays under the cap.
export function checkOffer(offer, { hours, maxUsd }) {
  if (!offer) throw new Error('offer not found (it may have been rented by someone else)');
  const problems = [];
  if (!/RTX PRO 6000/.test(offer.gpu_name ?? '')) problems.push(`gpu is ${offer.gpu_name}, not an RTX PRO 6000`);
  if (offer.num_gpus !== 1) problems.push(`${offer.num_gpus} GPUs, want 1`);
  if (offer.vms_enabled !== true) problems.push('not a VM-capable host (Docker needs a VM)');
  if (offer.rentable === false) problems.push('not rentable now');
  if (offer.verification && offer.verification !== 'verified') problems.push(`host is ${offer.verification}`);
  const worst = (offer.dph_total ?? Infinity) * hours + Number(offer.inet_down_cost ?? 0) * 100;
  if (!(worst <= maxUsd * 0.8)) problems.push(`worst case for ${hours} h incl. about 100 GB of downloads is $${worst.toFixed?.(2)}, over 80% of the $${maxUsd} cap`);
  if (problems.length) throw new Error(`offer ${offer.id} refused: ${problems.join('; ')}`);
  return { worstUsd: worst };
}

export const CONTAINER_GPU_RE = /^RTX PRO 6000 (S|WS)$/;

// Container mode: the approved machine kinds only (Max-Q refused), one GPU, verified and reliable hosts, and 80% of the cap for the hours plus about 100 GB of downloads.
export function checkContainerOffer(offer, { hours, maxUsd }) {
  if (!offer) throw new Error('offer not found (it may have been rented by someone else)');
  const problems = [];
  if (!CONTAINER_GPU_RE.test(offer.gpu_name ?? '')) problems.push(`gpu is ${offer.gpu_name}, not an RTX PRO 6000 S or WS`);
  if (offer.num_gpus !== 1) problems.push(`${offer.num_gpus} GPUs, want 1`);
  if (offer.rentable === false) problems.push('not rentable now');
  if (offer.verification !== 'verified') problems.push(`host is ${offer.verification ?? 'unverified'}, want verified`);
  const reliability = offer.reliability2 ?? offer.reliability;
  if (!(reliability >= 0.99)) problems.push(`reliability ${reliability} is below 0.99`);
  const worst = Number(offer.dph_total) * hours + Number(offer.inet_down_cost ?? 0) * 100;
  if (!(worst <= maxUsd * 0.8)) problems.push(`worst case for ${hours} h incl. about 100 GB of downloads is $${worst.toFixed(2)}, over 80% of the $${maxUsd} cap`);
  if (problems.length) throw new Error(`offer ${offer.id} refused: ${problems.join('; ')}`);
  return { worstUsd: worst };
}

// The offers that pass the container checks for a 4 hour, $15 run, datacenter hosts first, then by price. Returns a new array.
export function rankContainerOffers(offers) {
  const passing = (Array.isArray(offers) ? offers : []).filter(offer => {
    try { checkContainerOffer(offer, { hours: 4, maxUsd: 15 }); return true; } catch { return false; }
  });
  return passing.sort((a, b) => ((b.hosting_type === 1) - (a.hosting_type === 1)) || (a.dph_total - b.dph_total));
}

export function containerCreateBody({ disk = 200, label = 'swarm-bakeoff' } = {}) {
  if (!/@sha256:[0-9a-f]{64}$/.test(PINNED_IMAGE)) throw new Error('PINNED_IMAGE must be pinned by digest (name@sha256:<64 hex>)');
  return { image: PINNED_IMAGE, disk, runtype: 'ssh_direct', label };
}

// External HostPort numbers from the instance ports map (values are arrays of {HostPort}), without the ssh port.
export function mappedPorts(instance, sshPort) {
  const values = Object.values(instance?.ports ?? {});
  const numbers = values.flatMap(item => (Array.isArray(item) ? item : [])).map(item => Number(item?.HostPort)).filter(port => Number.isInteger(port) && port > 0 && port !== Number(sshPort));
  return [...new Set(numbers)];
}

export const createBody = ({ disk = 150, label = 'swarm-bakeoff' } = {}) => ({ image: VM_IMAGE, disk, runtype: 'ssh_direct', label, vm: true });
export const deadlineAt = (now, hours) => new Date(now + hours * 3600000).toISOString();

export async function findOffer(client, id) {
  const body = await client.call('POST', '/bundles/', { num_gpus: { eq: 1 }, gpu_ram: { gte: 90000 }, rentable: { eq: true }, type: 'ondemand', limit: 500 });
  return (body?.offers ?? []).find(item => item.id === id) ?? null;
}

export async function searchContainerOffers(client) {
  const body = await client.call('POST', '/bundles/', { num_gpus: { eq: 1 }, gpu_ram: { gte: 90000 }, rentable: { eq: true }, type: 'ondemand', limit: 500 });
  return body?.offers ?? [];
}

export async function getInstance(client, id) {
  const body = await client.call('GET', `/instances/${id}/`);
  return body?.instances ?? null;
}

// Destroy and verify: a DELETE counts only if its JSON does not say success === false, and the instance must then be gone (null, a 404, or a status other than running/loading/created) within 12 polls 5 s apart.
export async function destroyInstance(client, id, { retries = 5, wait = sleep } = {}) {
  let last;
  for (let n = 0; n < retries; n += 1) {
    try {
      const body = await client.call('DELETE', `/instances/${id}/`);
      if (body?.success === false) throw new Error(`Vast refused to destroy ${id}: ${JSON.stringify(body).slice(0, 160)}`);
      for (let poll = 0; poll < 12; poll += 1) {
        const instance = await getInstance(client, id).catch(error => { if (/HTTP 404/.test(error.message)) return null; throw error; });
        if (!instance || !['running', 'loading', 'created'].includes(instance.actual_status)) return true;
        if (poll < 11) await wait(5000);
      }
      throw new Error(`instance ${id} did not go away after destroy`);
    } catch (error) { last = error; await wait(2000); }
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

// The reaper: sleeps until the deadline, then destroys the instance, retrying every 30 s for up to 60 minutes and logging each failed round. It writes a heartbeat while the state file names its instance. It exits early only when the state file shows the instance destroyed by hand.
export async function reap(client, { id, at }, { wait = sleep, now = Date.now, log = () => {}, state = readState, writeStateFn = writeState } = {}) {
  const deadline = Date.parse(at);
  if (!Number.isFinite(deadline)) throw new Error('reap needs --at as an ISO time');
  const heartbeat = () => { const current = state(); if (current?.instanceId === id) writeStateFn({ ...current, heartbeatAt: new Date(now()).toISOString() }); };
  while (now() < deadline) {
    const current = state();
    if (current?.instanceId === id && current?.destroyedAt) { log('already destroyed by hand'); return 'gone'; }
    heartbeat();
    await wait(Math.min(30000, Math.max(1000, deadline - now())));
  }
  const giveUp = now() + 60 * 60000;
  for (let round = 1; ; round += 1) {
    try {
      await destroyInstance(client, id, { wait });
      log(`destroyed ${id} at the deadline`);
      return 'destroyed';
    } catch (error) {
      log(`destroy round ${round} failed: ${error.message}`);
      if (now() >= giveUp) throw error;
      heartbeat();
      await wait(30000);
    }
  }
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };

async function main(args) {
  const [command] = args;
  const client = createClient(readKey());
  const log = message => process.stderr.write(`[vast] ${message}\n`);
  if (command === 'search') {
    if (flag(args, 'mode') !== 'container') throw new Error('usage: search --mode container');
    const ranked = rankContainerOffers(await searchContainerOffers(client));
    if (!ranked.length) process.stdout.write('no offers pass the container checks\n');
    for (const offer of ranked) {
      const reliability = offer.reliability2 ?? offer.reliability;
      const hosting = offer.hosting_type === 1 ? 'datacenter' : 'community';
      process.stdout.write(`${offer.id} ${offer.gpu_name} $${Number(offer.dph_total).toFixed(3)}/h reliability ${reliability} ${hosting} host_id ${offer.host_id} ${offer.geolocation ?? 'unknown'}\n`);
    }
    return;
  }
  if (command === 'rent') {
    const usage = 'usage: rent --offer ID --hours H(<=4) --max-usd N(<=15) [--disk GB] [--mode vm|container] [--wait-min 1-25]';
    const mode = flag(args, 'mode') ?? 'vm';
    if (mode !== 'vm' && mode !== 'container') throw new Error(usage);
    const container = mode === 'container';
    const id = Number(flag(args, 'offer')), hours = Number(flag(args, 'hours') ?? 4), maxUsd = Number(flag(args, 'max-usd') ?? 15), disk = Number(flag(args, 'disk') ?? (container ? 200 : 150));
    const waitMin = Number(flag(args, 'wait-min') ?? 10);
    if (!Number.isInteger(id) || !(hours > 0 && hours <= 4) || !(maxUsd > 0 && maxUsd <= 15) || !Number.isInteger(waitMin) || waitMin < 1 || waitMin > 25) throw new Error(usage);
    const prior = readState();
    if (prior?.instanceId && !prior.destroyedAt) throw new Error(`a rental is already recorded (instance ${prior.instanceId}); destroy it first with: node bench/gpu-bakeoff/vast.mjs destroy --id ${prior.instanceId}`);
    const offer = await findOffer(client, id);
    const { worstUsd } = container ? checkContainerOffer(offer, { hours, maxUsd }) : checkOffer(offer, { hours, maxUsd });
    log(`offer ${id}: ${offer.gpu_name} $${offer.dph_total.toFixed(3)}/h, ${hours} h worst case $${worstUsd.toFixed(2)} (cap $${maxUsd})`);
    const label = `swarm-bakeoff-${Date.now()}`;
    const created = await client.call('PUT', `/asks/${id}/`, container ? containerCreateBody({ disk, label }) : createBody({ disk, label }));
    const instanceId = created?.new_contract;
    if (!instanceId) throw new Error(`Vast did not return an instance id: ${JSON.stringify(created).slice(0, 200)}`);
    process.stdout.write(`INSTANCE_ID=${instanceId}  (destroy in the Vast console if anything goes wrong)\n`);
    const stopNow = signal => {
      destroyInstance(client, instanceId).then(
        () => process.stderr.write(`[vast] ${signal}: destroyed instance ${instanceId}\n`),
        error => process.stderr.write(`[vast] ${signal}: could NOT verify destroy of instance ${instanceId} (${error.message}); destroy it in the Vast console\n`)
      ).finally(() => process.exit(130));
    };
    const onInt = () => stopNow('SIGINT');
    const onTerm = () => stopNow('SIGTERM');
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
    try {
      const deadline = deadlineAt(Date.now(), hours);
      const reaper = spawn('caffeinate', ['-i', process.execPath, fileURLToPath(import.meta.url), 'reap', '--id', String(instanceId), '--at', deadline], { detached: true, stdio: ['ignore', fs.openSync(path.join(path.dirname(STATE_FILE), 'vast-reaper.log'), 'a'), fs.openSync(path.join(path.dirname(STATE_FILE), 'vast-reaper.log'), 'a')] });
      reaper.on('error', error => log(`reaper error: ${error.message}`));
      reaper.unref();
      await sleep(2000);
      if (reaper.pid === undefined || reaper.exitCode !== null) throw new Error(`reaper did not stay alive (exit code ${reaper.exitCode}); see vast-reaper.log`);
      log(`reaper started (pid ${reaper.pid}, under caffeinate -i)`);
      const state = { instanceId, offerId: id, label, ...(container ? { mode: 'container' } : {}), createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), deadline, hourlyUsd: offer.dph_total, maxUsd, reaperPid: reaper.pid };
      writeState(state);
      const instance = await waitRunning(client, instanceId, { timeoutMs: waitMin * 60000 });
      writeState({ ...state, ssh: { host: instance.ssh_host, port: instance.ssh_port } });
      process.stdout.write(`SSH_HOST=${instance.ssh_host}\nSSH_PORT=${instance.ssh_port}\n`);
      if (container) {
        if (instance.public_ipaddr) process.stdout.write(`PUBLIC_IP=${instance.public_ipaddr}\n`);
        process.stdout.write(`MAPPED_PORTS=${mappedPorts(instance, instance.ssh_port).join(',')}\n`);
      }
    } catch (error) {
      log(`${error.message}; destroying`);
      try { await destroyInstance(client, instanceId); } catch (destroyError) { log(`destroy of ${instanceId} NOT verified (${destroyError.message}); destroy it in the Vast console`); }
      throw error;
    } finally {
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
    }
    return;
  }
  if (command === 'destroy') {
    const id = Number(flag(args, 'id') ?? readState()?.instanceId);
    if (!Number.isInteger(id)) throw new Error('no instance id (pass --id)');
    await destroyInstance(client, id);
    const recorded = readState();
    if (recorded?.instanceId === id) writeState({ ...recorded, destroyedAt: new Date().toISOString() });
    process.stdout.write(`destroyed ${id}\n`);
    return;
  }
  if (command === 'status') {
    const state = readState();
    if (!state) { process.stdout.write('no rental recorded\n'); return; }
    let actual;
    try {
      const instance = await getInstance(client, state.instanceId);
      actual = instance ? (instance.actual_status ?? 'unknown') : 'gone';
    } catch {
      actual = 'unknown';
    }
    process.stdout.write(`${JSON.stringify({ ...state, actual_status: actual })}\n`);
    return;
  }
  if (command === 'reap') { await reap(client, { id: Number(flag(args, 'id')), at: flag(args, 'at') }, { log }); return; }
  throw new Error('usage: vast.mjs rent|search|status|destroy|reap');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2)).catch(error => { process.stderr.write(`[vast] ${error.message}\n`); process.exitCode = 1; });
