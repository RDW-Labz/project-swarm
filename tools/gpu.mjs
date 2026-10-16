// SPDX-License-Identifier: Apache-2.0
// `swarm gpu up|down|status` (Phase 14e): runs one vLLM replica per GPU on a node the OWNER rented, over ssh. Swarm sends commands only: no file, key or .env of the owner goes to the node; a random per-rental API key is written for the servers. The servers listen on the node's loopback only. Each rental gets a random API key, kept in the 0600 session file and in an env file on the node that is removed at stop. The servers are reached through an ssh tunnel and need that key. The session file (next to the machine config) names the replicas, model, price and an expiry; the rented lane (tools/rented.mjs) reads it, load-balances across the replicas, and is routable only while the session is live. A dead-man timer on the node removes the servers and powers it off at the expiry.
import fs from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gpuSessionPath } from './rented.mjs';
import { fetchCacheStats, combineCacheStats } from './gpu-cache.mjs';

export const PINNED_IMAGE = 'vllm/vllm-openai@sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967';

export const GPU_DEFAULTS = Object.freeze({ image: PINNED_IMAGE, remotePortBase: 8000, localPortBase: 18000, maxModelLen: 32768, perReplica: 32, healthTimeoutMs: 1200000, maxHours: 4 });

export const SSH_HARDENING = Object.freeze(['-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'StrictHostKeyChecking=yes']);

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,100}@sha256:[0-9a-f]{64}$/;
const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const KEY_RE = /^[0-9a-f]{48}$/;

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
  if (!IMAGE_RE.test(image)) throw fail('gpu-image-invalid', 'pin the image by digest (name@sha256:<64 hex>); tags are refused');
  for (const [name, value] of [['gpus', options.gpus], ['perReplica', options.perReplica], ['maxModelLen', options.maxModelLen]]) if (value !== undefined && !isPosInt(value)) throw fail('gpu-option-invalid', `${name} must be a positive whole number`);
  if (options.bestOf !== undefined && !(Number.isInteger(options.bestOf) && options.bestOf >= 1 && options.bestOf <= 8)) throw fail('gpu-option-invalid', 'bestOf must be a whole number from 1 to 8');
  if (options.maxHours !== undefined && !isPosNum(options.maxHours)) throw fail('gpu-option-invalid', 'maxHours must be above 0');
  if (options.sshPort !== undefined && !(Number.isInteger(options.sshPort) && options.sshPort >= 1 && options.sshPort <= 65535)) throw fail('gpu-option-invalid', 'sshPort must be a whole number from 1 to 65535');
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

// The integer major Docker version from the DOCKER: line of the probe output, or null when missing or not an integer.
export function parseDockerMajor(output) {
  const line = String(output).split('\n').map(item => item.trim()).find(item => item.startsWith('DOCKER:'));
  if (line === undefined) return null;
  const major = line.slice('DOCKER:'.length).trim().split('.')[0];
  return /^\d+$/.test(major) ? Number(major) : null;
}

export function replicaPorts(count, { remotePortBase = GPU_DEFAULTS.remotePortBase, localPortBase = GPU_DEFAULTS.localPortBase } = {}) {
  return Array.from({ length: count }, (_, index) => ({ index, remote: remotePortBase + index, local: localPortBase + index }));
}

// The shell script run on the node (sent on stdin to `bash -s`): the dead-man timer first, then the key file, then one container per GPU.
export function remoteStartScript({ model, image, gpus, maxModelLen, perReplica, args = [], seconds, remotePortBase, apiKey }) {
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw fail('gpu-key-invalid', 'api key must be 48 lower-case hex characters');
  // The timer is on the node itself, so it still fires if this computer sleeps or loses the link, and even if a later step fails.
  // Powering off is best effort (it needs passwordless sudo); the owner still has to terminate the instance, which is what stops the billing.
  const lines = [`setsid nohup sh -c 'sleep ${Math.ceil(seconds)}; docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1; rm -f "$HOME/.swarm-vllm.env"; { sudo -n shutdown -h now || shutdown -h now; } >/dev/null 2>&1' >/dev/null 2>&1 </dev/null &`, 'set -e', 'docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1 || true', 'rm -f "$HOME/.swarm-vllm.env"', 'umask 077', 'cat > "$HOME/.swarm-vllm.env" <<\'SWARMKEY\'', `VLLM_API_KEY=${apiKey}`, 'SWARMKEY'];
  for (const { index, remote } of replicaPorts(gpus, { remotePortBase })) {
    lines.push(`docker run -d --name swarm-vllm-${index} --gpus device=${index} --ipc=host --env-file "$HOME/.swarm-vllm.env" -p 127.0.0.1:${remote}:8000 -v "$HOME/.cache/huggingface:/root/.cache/huggingface" ${image} --model ${model} --served-model-name ${model} --max-model-len ${maxModelLen} --max-num-seqs ${perReplica} --gpu-memory-utilization 0.9 --enable-prefix-caching ${args.join(' ')} >/dev/null`.replace(/ +$/, ''));
  }
  lines.push('rm -f "$HOME/.swarm-vllm.env"');
  return `${lines.join('\n')}\n`;
}

export const remoteStopScript = () => 'docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1 || true\nrm -f "$HOME/.swarm-vllm.env"\n';

// The health check and status calls send the rental's key; the key is never logged.
export function authFetch(fetchImpl, key) {
  return async (url, init = {}) => fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${key}` } });
}

const sleepReal = ms => new Promise(resolve => setTimeout(resolve, ms));

// Default exposure probe: true when a TCP connection to host:port succeeds.
const probeTcp = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const finish = ok => { socket.destroy(); resolve(ok); };
  socket.setTimeout(3000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});

// Splits an ss local address (host:port, [host]:port, [host%iface]:port) into host (interface suffix removed) and port.
function splitLocal(addr) {
  const m = /^(.+):(\d+)$/.exec(addr);
  if (!m) return null;
  let host = m[1];
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/%.*$/, '');
  return { host, port: Number(m[2]) };
}

const isLoopback = host => host.startsWith('127.') || host === '::1' || host.startsWith('::ffff:127.');

// The ssh host name to probe: `ssh -G` resolves it (Host aliases and HostName); the target's host part when absent.
async function resolveHost({ base, target, ssh }) {
  const fallback = target.split('@').pop();
  try {
    const out = String((await ssh([...base, '-G', '--', target], {}))?.stdout ?? '');
    const line = out.split('\n').find(item => item.startsWith('hostname '));
    const value = line ? line.slice('hostname '.length).trim() : '';
    return value || fallback;
  } catch { return fallback; }
}

// The exposure detail (string) when a replica port is reachable from outside, or null. Probes every resolved address first, then the
// node's ss listing. Throws gpu-exposure-unknown when the check cannot be made.
async function findExposure({ base, target, shown, ports, ssh, sshArgs, probePort, lookup }) {
  const host = await resolveHost({ base, target, ssh });
  const detail = port => `port ${port} on ${shown} is reachable from outside; the servers must listen on the node loopback only`;
  let addresses;
  try {
    addresses = lookup ? await lookup(host) : await dns.promises.lookup(host, { all: true });
  } catch { throw fail('gpu-exposure-unknown', `could not resolve ${host} to check the node's exposure`); }
  if (!Array.isArray(addresses) || !addresses.length) throw fail('gpu-exposure-unknown', `no address for ${host} to check the node's exposure`);
  for (const item of addresses) {
    const address = item?.address;
    for (const { remote } of ports) if (await probePort(address, remote)) return detail(remote);
  }
  let out;
  try {
    out = String((await ssh([...sshArgs, 'ss -ltnH'], {}))?.stdout ?? '');
  } catch { throw fail('gpu-exposure-unknown', 'could not read the node listening sockets (ss -ltnH)'); }
  const listening = new Set(ports.map(item => item.remote));
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const mentioned = ports.find(item => line.includes(`:${item.remote}`));
    const parsed = splitLocal(line.trim().split(/\s+/)[3] ?? '');
    if (!parsed) {
      // A line that mentions a server port but has no readable local address: fail closed.
      if (mentioned) return detail(mentioned.remote);
      continue;
    }
    if (listening.has(parsed.port) && !isLoopback(parsed.host)) return detail(parsed.port);
  }
  return null;
}

export function writeSession(env, session) {
  const file = gpuSessionPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(session, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Exclusive creation: a second up fails here with the existing-session error.
function createSession(env, session) {
  const file = gpuSessionPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, `${JSON.stringify(session, null, 1)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('gpu-session-exists', 'a GPU session is already recorded; run swarm gpu status, or swarm gpu down first');
    throw error;
  }
}
export function removeSession(env) { try { fs.rmSync(gpuSessionPath(env)); } catch { /* none */ } }
export function readSessionFile(env) {
  try { return JSON.parse(fs.readFileSync(gpuSessionPath(env), 'utf8')); } catch { return null; }
}

// A copy of the session without the API key (what errors carry).
const keyless = session => { const copy = { ...session }; delete copy.apiKey; return copy; };

async function waitHealthy(endpoints, model, { fetchImpl, sleep, now, timeoutMs, pollMs = 5000 }) {
  const deadline = now() + timeoutMs;
  const pending = new Set(endpoints);
  while (pending.size) {
    for (const endpoint of [...pending]) {
      try {
        const response = await fetchImpl(`${endpoint}/v1/models`);
        if (response.ok) {
          const body = await response.json();
          if (Array.isArray(body?.data) && body.data.some(item => item?.id === model)) pending.delete(endpoint);
        }
      } catch { /* still starting, or not JSON yet */ }
    }
    if (!pending.size) return;
    if (now() >= deadline) throw fail('gpu-unhealthy', `no answer from ${[...pending].join(', ')} within ${Math.round(timeoutMs / 60000)} minutes (the model may still be downloading; run swarm gpu status)`);
    await sleep(pollMs);
  }
}

// ssh(argv, { input }) -> { stdout }; openTunnel({ target, key, ports }) -> { pid, stop() }. Both injected so tests need no network.
export async function gpuUp(options, deps) {
  validateUpOptions(options);
  const { ssh, openTunnel, fetchImpl = fetch, sleep = sleepReal, now = Date.now, env = process.env, log = () => {}, probePort = probeTcp, randomKey, lookup } = deps;
  if (readSessionFile(env)) throw fail('gpu-session-exists', 'a GPU session is already recorded; run swarm gpu status, or swarm gpu down first');
  const apiKey = randomKey ? randomKey() : randomBytes(24).toString('hex');
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw fail('gpu-key-invalid', 'the generated API key must be 48 lower-case hex characters');
  const sshOptions = options.sshPort !== undefined ? ['-p', String(options.sshPort), ...(options.sshOptions ?? [])] : [...(options.sshOptions ?? [])];
  const sshBase = [...sshOptions, ...SSH_HARDENING, '-o', 'ClearAllForwardings=yes', '-i', options.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20'];
  const sshArgs = [...sshBase, '--', options.target];
  const shown = options.target.split('@').pop();
  const output = String((await ssh([...sshArgs, 'nvidia-smi -L; echo SUDO:$( { [ "$(id -u)" = 0 ] || sudo -n true; } >/dev/null 2>&1 && echo ok || echo no); echo DOCKER:$(docker version --format "{{.Server.Version}}" 2>/dev/null)'], {})).stdout);
  const count = parseGpuCount(output);
  const dockerMajor = parseDockerMajor(output);
  if (dockerMajor === null || dockerMajor < 28) {
    const reported = String(output).split('\n').map(item => item.trim()).find(item => item.startsWith('DOCKER:'))?.slice('DOCKER:'.length).trim() || 'unknown';
    throw fail('gpu-docker-old', `the node has Docker ${reported}; version 28 or newer is required (older Docker lets other hosts on the same network reach ports published on 127.0.0.1)`);
  }
  if (count < 1) throw fail('gpu-none', 'no GPU found on the node (nvidia-smi -L listed none)');
  const powerOff = !output.includes('SUDO:no');
  if (!powerOff) {
    if (options.allowNoPowerOff !== true) throw fail('gpu-sudo', 'passwordless sudo is not available on the node, so the timer cannot power it off; fix that or pass --allow-no-poweroff (then billing continues until you terminate the instance)');
    log('warning: passwordless sudo is not available; the timer will remove the servers but cannot power the node off, so billing continues until you terminate the instance');
  }
  const gpus = Math.min(options.gpus ?? count, count, 16);
  const hours = sessionHours({ hourlyUsd: options.hourlyUsd, maxUsd: options.maxUsd, maxHours: options.maxHours });
  const perReplica = options.perReplica ?? GPU_DEFAULTS.perReplica;
  const script = remoteStartScript({ model: options.model, image: options.image ?? GPU_DEFAULTS.image, gpus, maxModelLen: options.maxModelLen ?? GPU_DEFAULTS.maxModelLen, perReplica, args: options.args ?? [], seconds: hours * 3600, remotePortBase: GPU_DEFAULTS.remotePortBase, apiKey });
  const ports = replicaPorts(gpus);
  const endpoints = ports.map(port => `http://127.0.0.1:${port.local}`);
  const startedAt = now();
  const session = { version: 1, bestOf: options.bestOf ?? 1, target: options.target, key: options.key, apiKey, model: options.model, quant: options.quant ?? null, replicas: gpus, endpoints, perReplica, hourlyUsd: options.hourlyUsd, capUsd: options.maxUsd, maxHours: hours, startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + hours * 3600000).toISOString(), tunnelPid: null, sshOptions, routable: options.routable !== false, powerOff, state: 'starting' };
  createSession(env, session);

  const exposureCheck = async () => {
    const detail = await findExposure({ base: sshBase, target: options.target, shown, ports, ssh, sshArgs, probePort, lookup });
    if (detail !== null) throw Object.assign(fail('gpu-exposed', detail), { exposure: true });
  };

  // Any failure after the session file exists: stop the servers over ssh (ignoring errors, but noting success), remove the session file,
  // then rethrow with a message that says whether the stop worked and a key-less session copy on error.session.
  const afterStartFailure = async error => {
    let stopped = false;
    try { await ssh([...sshArgs, 'bash -s'], { input: remoteStopScript() }); stopped = true; } catch { /* ignored: the timer still removes them */ }
    removeSession(env);
    if (error?.exposure) {
      error.message = `${error.message}; ${stopped ? 'the servers were stopped' : `the servers could NOT be stopped from here; the timer on the node will remove them at ${session.expiresAt}; terminate the instance`}`;
    } else {
      error.message = `${error.message} ${stopped ? '(the servers were stopped)' : '(could not stop the servers from here; the timer on the node still fires)'}`;
    }
    error.session = keyless(session);
    return error;
  };

  try {
    await ssh([...sshArgs, 'bash -s'], { input: script });
    log(`started ${gpus} replica(s) of ${options.model}; dead-man timer set for ${hours.toFixed(2)} h`);
    await exposureCheck();
    const tunnel = await openTunnel({ target: options.target, key: options.key, ports, sshOptions });
    session.tunnelPid = tunnel?.pid ?? null;
    writeSession(env, session);
    await waitHealthy(endpoints, options.model, { fetchImpl: authFetch(fetchImpl, apiKey), sleep, now, timeoutMs: options.healthTimeoutMs ?? GPU_DEFAULTS.healthTimeoutMs, pollMs: options.pollMs });
    await exposureCheck();
  } catch (error) {
    throw await afterStartFailure(error);
  }
  session.state = 'up';
  writeSession(env, session);
  return session;
}

const sessionSshOptions = session => (Array.isArray(session?.sshOptions) && session.sshOptions.every(item => typeof item === 'string') ? session.sshOptions : []);

export async function gpuDown(deps) {
  const { ssh, stopTunnel, env = process.env, now = Date.now } = deps;
  const session = readSessionFile(env);
  if (!session) return { stopped: false, message: 'no GPU session recorded' };
  const notes = [];
  let sshOk = true;
  try {
    await ssh([...sessionSshOptions(session), ...SSH_HARDENING, '-o', 'ClearAllForwardings=yes', '-i', session.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20', '--', session.target, 'bash -s'], { input: remoteStopScript() });
  } catch (error) { sshOk = false; notes.push(`could not reach the node to stop the servers (${String(error.message).slice(0, 120)}); its dead-man timer still removes them at ${session.expiresAt}`); }
  try { if (Number.isInteger(session.tunnelPid) && session.tunnelPid > 1) await stopTunnel(session.tunnelPid, session); } catch { /* already gone */ }
  removeSession(env);
  const hours = Math.max(0, (now() - Date.parse(session.startedAt)) / 3600000);
  const reminder = 'This does NOT stop the rental: terminate the instance in the provider console now.';
  const message = sshOk ? `Servers stopped and the session removed. ${reminder}` : `Could not stop the servers over ssh (the timer on the node still removes them at ${session.expiresAt}). The session was removed. ${reminder}`;
  return { stopped: true, hours, costUsd: Math.round(hours * session.hourlyUsd * 100) / 100, notes, message };
}

export async function gpuStatus(deps) {
  const { env = process.env, fetchImpl: baseFetch = fetch, now = Date.now } = deps;
  const session = readSessionFile(env);
  if (!session) return { active: false };
  const fetchImpl = session.apiKey ? authFetch(baseFetch, session.apiKey) : baseFetch;
  const expires = Date.parse(session.expiresAt);
  const expired = expires <= now();
  const hours = Math.max(0, (now() - Date.parse(session.startedAt)) / 3600000);
  const replicas = [];
  for (const endpoint of session.endpoints) {
    let healthy = false;
    try { healthy = (await fetchImpl(`${endpoint}/v1/models`)).ok; } catch { /* down */ }
    replicas.push({ endpoint, healthy, cache: healthy ? await fetchCacheStats(endpoint, fetchImpl) : null });
  }
  const cache = combineCacheStats(replicas.map(item => item.cache).filter(Boolean));
  return { cacheHitRate: cache.hitRate, bestOf: session.bestOf ?? 1, active: !expired, expired, model: session.model, replicas, hours, spentUsd: Math.round(hours * session.hourlyUsd * 100) / 100, capUsd: session.capUsd, minutesLeft: Math.max(0, Math.round((expires - now()) / 60000)), hourlyUsd: session.hourlyUsd, expiresAt: session.expiresAt, billingNote: expired ? 'the node may still be billing: terminate the instance' : null };
}

export function formatStatus(status) {
  if (!status.active && !status.expired) return 'No GPU session. Nothing is rented by swarm; start one with swarm gpu up on a node you rented.';
  const up = status.replicas.filter(item => item.healthy).length;
  return [`GPU session: ${status.model}`, `Replicas: ${up} of ${status.replicas.length} answering${status.bestOf > 1 ? `; best-of-${status.bestOf} on` : ''}${status.cacheHitRate === null || status.cacheHitRate === undefined ? '' : `; prefix cache hit ${Math.round(status.cacheHitRate * 100)}%`}`, `Time: ${status.hours.toFixed(2)} h used, ${status.expired ? 'EXPIRED, terminate the instance, billing may continue' : `${status.minutesLeft} min left`}`, `Cost: about $${status.spentUsd.toFixed(2)} of the $${status.capUsd.toFixed(2)} cap ($${status.hourlyUsd}/h)`].join('\n');
}
