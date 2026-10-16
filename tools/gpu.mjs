// SPDX-License-Identifier: Apache-2.0
// `swarm gpu up|down|status` (Phase 14e): runs one vLLM replica per GPU on a node the OWNER rented, over ssh. Swarm never rents
// anything, never copies a file, key or .env to the node (it only runs fixed commands there), and the servers listen on the node's
// loopback only, so no API key exists: they are reached through an ssh tunnel. The session file (next to the machine config) names
// the replicas, model, price and an expiry; the rented lane (tools/rented.mjs) reads it, load-balances across the replicas, and is
// routable only while the session is live. A dead-man timer on the node removes the servers and powers it off at the expiry.
import fs from 'node:fs';
import path from 'node:path';
import { gpuSessionPath } from './rented.mjs';

export const GPU_DEFAULTS = Object.freeze({ image: 'vllm/vllm-openai:latest', remotePortBase: 8000, localPortBase: 18000, maxModelLen: 32768, perReplica: 32, healthTimeoutMs: 1200000, maxHours: 4 });

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,100}(:[A-Za-z0-9._-]{1,60})?$/;
const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

// The small, fast coding models worth testing (a shortlist, not a promise: ids must be checked on Hugging Face before renting).
// FP8 is tried first on every candidate; `nvfp4` entries are extra runs.
export const SHORTLIST = Object.freeze([
  { label: 'qwen3.6-35b-a3b-fp8', model: 'Qwen/Qwen3.6-35B-A3B-FP8', quant: 'fp8', args: [] },
  { label: 'qwen3-coder-30b-a3b-fp8', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8', quant: 'fp8', args: [] },
  { label: 'devstral-small-2-fp8', model: 'mistralai/Devstral-Small-2-24B-Instruct-2512', quant: 'fp8', args: ['--quantization', 'fp8'] },
  { label: 'nemotron-3.5-lightning-nvfp4', model: 'nvidia/Nemotron-3.5-Lightning-30B-A3B-NVFP4', quant: 'nvfp4', args: [], extra: true },
]);

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const isPosInt = value => Number.isInteger(value) && value > 0;
const isPosNum = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function validateSshTarget(target) {
  if (typeof target !== 'string' || !TARGET_RE.test(target) || target.startsWith('-')) throw fail('gpu-target-invalid', 'target must be [user@]host (letters, digits, dots, dashes)');
  return target;
}

export function validateUpOptions(options) {
  const { target, key, model, hourlyUsd, maxUsd } = options;
  validateSshTarget(target);
  if (typeof key !== 'string' || !key || key.startsWith('-') || /[\u0000-\u001f]/.test(key)) throw fail('gpu-key-invalid', 'key must be the path of an ssh key file (never its contents)');
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw fail('gpu-model-invalid', 'model must look like org/name');
  if (!isPosNum(hourlyUsd) || hourlyUsd > 1000) throw fail('gpu-hourly-invalid', '--hourly-usd must be the node price per hour, above 0');
  if (!isPosNum(maxUsd)) throw fail('gpu-cap-invalid', '--max-usd is required: the hard dollar cap for this session');
  const image = options.image ?? GPU_DEFAULTS.image;
  if (!IMAGE_RE.test(image)) throw fail('gpu-image-invalid', 'image is not a valid container image name');
  for (const [name, value] of [['gpus', options.gpus], ['perReplica', options.perReplica], ['maxModelLen', options.maxModelLen]]) if (value !== undefined && !isPosInt(value)) throw fail('gpu-option-invalid', `${name} must be a positive whole number`);
  if (options.maxHours !== undefined && !isPosNum(options.maxHours)) throw fail('gpu-option-invalid', 'maxHours must be above 0');
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._=:/-]{1,80}$/.test(item))) throw fail('gpu-option-invalid', 'extra server arguments may only hold letters, digits and . _ = : / -');
}

// Hours the session may run: the owner's limit, and never more than the dollar cap pays for.
export function sessionHours({ hourlyUsd, maxUsd, maxHours = GPU_DEFAULTS.maxHours }) {
  return Math.min(maxHours, maxUsd / hourlyUsd);
}

export function parseGpuCount(output) {
  return String(output).split('\n').filter(line => /^GPU \d+:/.test(line.trim())).length;
}

export function replicaPorts(count, { remotePortBase = GPU_DEFAULTS.remotePortBase, localPortBase = GPU_DEFAULTS.localPortBase } = {}) {
  return Array.from({ length: count }, (_, index) => ({ index, remote: remotePortBase + index, local: localPortBase + index }));
}

// The shell script run on the node (sent on stdin to `bash -s`): one container per GPU, then the dead-man timer.
export function remoteStartScript({ model, image, gpus, maxModelLen, perReplica, args = [], seconds, remotePortBase }) {
  const lines = ['set -e', 'docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1 || true'];
  for (const { index, remote } of replicaPorts(gpus, { remotePortBase })) {
    lines.push(`docker run -d --name swarm-vllm-${index} --gpus device=${index} --ipc=host -p 127.0.0.1:${remote}:8000 -v "$HOME/.cache/huggingface:/root/.cache/huggingface" ${image} --model ${model} --served-model-name ${model} --max-model-len ${maxModelLen} --max-num-seqs ${perReplica} --gpu-memory-utilization 0.9 ${args.join(' ')} >/dev/null`.replace(/ +$/, ''));
  }
  // The timer is on the node itself, so it still fires if this computer sleeps or loses the link. Powering off is best effort (it
  // needs passwordless sudo); the owner still has to terminate the instance, which is what stops the billing.
  lines.push(`setsid nohup sh -c 'sleep ${Math.ceil(seconds)}; docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1; sudo -n shutdown -h now >/dev/null 2>&1' >/dev/null 2>&1 </dev/null &`);
  return `${lines.join('\n')}\n`;
}

export const remoteStopScript = () => 'docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1 || true\n';

const sleepReal = ms => new Promise(resolve => setTimeout(resolve, ms));

export function writeSession(env, session) {
  const file = gpuSessionPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(session, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function removeSession(env) { try { fs.rmSync(gpuSessionPath(env)); } catch { /* none */ } }
export function readSessionFile(env) {
  try { return JSON.parse(fs.readFileSync(gpuSessionPath(env), 'utf8')); } catch { return null; }
}

async function waitHealthy(endpoints, { fetchImpl, sleep, now, timeoutMs, pollMs = 5000 }) {
  const deadline = now() + timeoutMs;
  const pending = new Set(endpoints);
  while (pending.size) {
    for (const endpoint of [...pending]) {
      try { const response = await fetchImpl(`${endpoint}/v1/models`); if (response.ok) pending.delete(endpoint); } catch { /* still starting */ }
    }
    if (!pending.size) return;
    if (now() >= deadline) throw fail('gpu-unhealthy', `no answer from ${[...pending].join(', ')} within ${Math.round(timeoutMs / 60000)} minutes (the model may still be downloading; run swarm gpu status)`);
    await sleep(pollMs);
  }
}

// ssh(argv, { input }) -> { stdout }; openTunnel({ target, key, ports }) -> { pid, stop() }. Both injected so tests need no network.
export async function gpuUp(options, deps) {
  validateUpOptions(options);
  const { ssh, openTunnel, fetchImpl = fetch, sleep = sleepReal, now = Date.now, env = process.env, log = () => {} } = deps;
  if (readSessionFile(env) && !options.replace) throw fail('gpu-session-exists', 'a GPU session is already recorded; run swarm gpu status, or swarm gpu down first');
  const sshArgs = [...(options.sshOptions ?? []), '-i', options.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20', '--', options.target];
  const count = parseGpuCount((await ssh([...sshArgs, 'nvidia-smi -L'], {})).stdout);
  if (count < 1) throw fail('gpu-none', 'no GPU found on the node (nvidia-smi -L listed none)');
  const gpus = Math.min(options.gpus ?? count, count);
  const hours = sessionHours({ hourlyUsd: options.hourlyUsd, maxUsd: options.maxUsd, maxHours: options.maxHours });
  const perReplica = options.perReplica ?? GPU_DEFAULTS.perReplica;
  const script = remoteStartScript({ model: options.model, image: options.image ?? GPU_DEFAULTS.image, gpus, maxModelLen: options.maxModelLen ?? GPU_DEFAULTS.maxModelLen, perReplica, args: options.args ?? [], seconds: hours * 3600, remotePortBase: GPU_DEFAULTS.remotePortBase });
  await ssh([...sshArgs, 'bash -s'], { input: script });
  log(`started ${gpus} replica(s) of ${options.model}; dead-man timer set for ${hours.toFixed(2)} h`);
  const ports = replicaPorts(gpus);
  const tunnel = await openTunnel({ target: options.target, key: options.key, ports, sshOptions: options.sshOptions });
  const endpoints = ports.map(port => `http://127.0.0.1:${port.local}`);
  const startedAt = now();
  const session = { version: 1, target: options.target, key: options.key, model: options.model, quant: options.quant ?? null, replicas: gpus, endpoints, perReplica, hourlyUsd: options.hourlyUsd, capUsd: options.maxUsd, maxHours: hours, startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + hours * 3600000).toISOString(), tunnelPid: tunnel?.pid ?? null };
  writeSession(env, session);
  try { await waitHealthy(endpoints, { fetchImpl, sleep, now, timeoutMs: options.healthTimeoutMs ?? GPU_DEFAULTS.healthTimeoutMs, pollMs: options.pollMs }); }
  catch (error) { error.session = session; throw error; }
  return session;
}

export async function gpuDown(deps) {
  const { ssh, stopTunnel, env = process.env, now = Date.now } = deps;
  const session = readSessionFile(env);
  if (!session) return { stopped: false, message: 'no GPU session recorded' };
  const notes = [];
  try {
    await ssh(['-i', session.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20', '--', session.target, 'bash -s'], { input: remoteStopScript() });
  } catch (error) { notes.push(`could not reach the node to stop the servers (${String(error.message).slice(0, 120)}); its dead-man timer still removes them at ${session.expiresAt}`); }
  try { if (session.tunnelPid) await stopTunnel(session.tunnelPid); } catch { /* already gone */ }
  removeSession(env);
  const hours = Math.max(0, (now() - Date.parse(session.startedAt)) / 3600000);
  return { stopped: true, hours, costUsd: Math.round(hours * session.hourlyUsd * 100) / 100, notes, message: 'Servers stopped and the session removed. This does NOT stop the rental: terminate the instance in the provider console now.' };
}

export async function gpuStatus(deps) {
  const { env = process.env, fetchImpl = fetch, now = Date.now } = deps;
  const session = readSessionFile(env);
  if (!session) return { active: false };
  const expires = Date.parse(session.expiresAt);
  const hours = Math.max(0, (now() - Date.parse(session.startedAt)) / 3600000);
  const replicas = [];
  for (const endpoint of session.endpoints) {
    let healthy = false;
    try { healthy = (await fetchImpl(`${endpoint}/v1/models`)).ok; } catch { /* down */ }
    replicas.push({ endpoint, healthy });
  }
  return { active: expires > now(), expired: expires <= now(), model: session.model, replicas, hours, spentUsd: Math.round(Math.min(hours, session.maxHours) * session.hourlyUsd * 100) / 100, capUsd: session.capUsd, minutesLeft: Math.max(0, Math.round((expires - now()) / 60000)), hourlyUsd: session.hourlyUsd, expiresAt: session.expiresAt };
}

export function formatStatus(status) {
  if (!status.active && !status.expired) return 'No GPU session. Nothing is rented by swarm; start one with swarm gpu up on a node you rented.';
  const up = status.replicas.filter(item => item.healthy).length;
  return [`GPU session: ${status.model}`, `Replicas: ${up} of ${status.replicas.length} answering`, `Time: ${status.hours.toFixed(2)} h used, ${status.expired ? 'EXPIRED (the node powers off by itself; terminate the instance)' : `${status.minutesLeft} min left`}`, `Cost: about $${status.spentUsd.toFixed(2)} of the $${status.capUsd.toFixed(2)} cap ($${status.hourlyUsd}/h)`].join('\n');
}
