// SPDX-License-Identifier: Apache-2.0
// `swarm gpu up|down|status` (Phase 14e): runs one vLLM replica per GPU on a node the OWNER rented, over ssh. Swarm sends commands only: no file, key or .env of the owner goes to the node; a random per-rental API key is written for the servers. The servers listen on the node's loopback only. Each rental gets a random API key, kept in the 0600 session file and in an env file on the node that is removed at stop. The servers are reached through an ssh tunnel and need that key. The session file (next to the machine config) names the replicas, model, price and an expiry; the rented lane (tools/rented.mjs) reads it, load-balances across the replicas, and is routable only while the session is live. A dead-man timer on the node removes the servers and powers it off at the expiry.
import fs from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gpuSessionPath } from './rented.mjs';
import { fetchCacheStats, combineCacheStats } from './gpu-cache.mjs';

// vLLM v0.31.0 (pinned by digest)
export const PINNED_IMAGE = 'vllm/vllm-openai@sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3';

export const GPU_DEFAULTS = Object.freeze({ image: PINNED_IMAGE, remotePortBase: 8000, localPortBase: 18000, maxModelLen: 131072, memoryUtilization: 0.93, commonArgs: Object.freeze(['--kv-cache-dtype', 'fp8', '--enable-prefix-caching', '--mamba-cache-mode', 'align', '--max-num-batched-tokens', '16384']), perReplica: 32, healthTimeoutMs: 1200000, maxHours: 4 });

export const SSH_HARDENING = Object.freeze(['-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'StrictHostKeyChecking=yes']);

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,100}@sha256:[0-9a-f]{64}$/;
const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const KEY_RE = /^[0-9a-f]{48}$/;

// The small, fast coding models worth testing (a shortlist, not a promise: ids must be checked on Hugging Face before renting). All NVFP4, text-only, no MTP; flags from docs/plans/swarm-gpu-memory-plan.md section 7. Entries marked optional run only when enough session time is left.
export const SHORTLIST = Object.freeze([
  // flashinfer_b12x MoE backend removed: it crashed with a CUDA illegal memory access on the RTX PRO 6000 under vLLM 0.31.0 during cudagraph profiling; vLLM's default MoE backend starts fine.
  // Qwen3.6: block size 128, so --prefix-match-unit 64 is set on this entry only.
  { label: 'qwen3.6-35b-a3b-nvfp4', model: 'nvidia/Qwen3.6-35B-A3B-NVFP4', quant: 'nvfp4', args: ['--quantization', 'modelopt_fp4', '--mamba-ssm-cache-dtype', 'bfloat16', '--block-size', '128', '--prefix-match-unit', '64', '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder', '--enable-auto-tool-choice', '--language-model-only'], env: { VLLM_HAS_FLASHINFER_CUBIN: '1' } },
  // Lightning: block size 2128 is not divisible by 64, so no --prefix-match-unit on this entry.
  { label: 'nemotron-3.5-lightning-nvfp4', model: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4', quant: 'nvfp4', args: ['--mamba-ssm-cache-dtype', 'float16', '--reasoning-parser', 'nemotron_v3', '--tool-call-parser', 'qwen3_coder', '--enable-auto-tool-choice', '--async-scheduling'], env: {} },
  // Coder-Next: compressed-tensors, no --quantization flag (vLLM detects it and rejects a conflicting one); prefix match unit 64 with block size 128.
  { label: 'qwen3-coder-next-nvfp4', model: 'RedHatAI/Qwen3-Coder-Next-NVFP4', quant: 'nvfp4', args: ['--mamba-ssm-cache-dtype', 'bfloat16', '--block-size', '128', '--prefix-match-unit', '64', '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder', '--enable-auto-tool-choice', '--language-model-only'], env: { VLLM_HAS_FLASHINFER_CUBIN: '1' }, optional: true },
]);

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const isPosInt = value => Number.isInteger(value) && value > 0;
const isPosNum = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// Validates the optional NAME: value env object (at most 8 entries); returns it, or {} when absent.
export function validateEnvOptions(env) {
  if (env === undefined) return {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw fail('gpu-env-invalid', 'env must be an object of NAME: value strings');
  const entries = Object.entries(env);
  if (entries.length > 8) throw fail('gpu-env-invalid', 'env may hold at most 8 entries');
  for (const [name, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(name) || typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(value)) throw fail('gpu-env-invalid', 'env names must match ^[A-Z][A-Z0-9_]{0,60}$ and values must match ^[A-Za-z0-9._-]{1,40}$');
  }
  return env;
}

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
  if (options.localPort !== undefined && !(Number.isInteger(options.localPort) && options.localPort >= 1024 && options.localPort <= 65000)) throw fail('gpu-option-invalid', 'localPort must be a whole number from 1024 to 65000');
  const mode = options.mode ?? 'vm';
  if (mode !== 'vm' && mode !== 'container') throw fail('gpu-option-invalid', "mode must be 'vm' or 'container'");
  if (options.probePorts !== undefined && (!Array.isArray(options.probePorts) || options.probePorts.length > 8 || options.probePorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535))) throw fail('gpu-option-invalid', 'probePorts must be an array of at most 8 whole ports from 1 to 65535');
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._=:/-]{1,80}$/.test(item))) throw fail('gpu-option-invalid', 'extra server arguments may only hold letters, digits and . _ = : / -');
  const reserved = item => ['--host', '--port', '--api-key'].some(flag => item === flag || item.startsWith(`${flag}=`));
  if (args.some(reserved)) throw fail('gpu-option-invalid', 'server args may not set --host, --port or --api-key');
  validateEnvOptions(options.env);
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
export function remoteStartScript({ model, image, gpus, maxModelLen, perReplica, args = [], seconds, remotePortBase, apiKey, env = {} }) {
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw fail('gpu-key-invalid', 'api key must be 48 lower-case hex characters');
  const envFlags = Object.entries(validateEnvOptions(env)).map(([name, value]) => ` -e ${name}=${value}`).join('');
  // The timer is on the node itself, so it still fires if this computer sleeps or loses the link, and even if a later step fails.
  // Powering off is best effort (it needs passwordless sudo); the owner still has to terminate the instance, which is what stops the billing.
  const lines = [`setsid nohup sh -c 'sleep ${Math.ceil(seconds)}; docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1; rm -f "$HOME/.swarm-vllm.env"; { sudo -n shutdown -h now || shutdown -h now; } >/dev/null 2>&1' >/dev/null 2>&1 </dev/null &`, 'set -e', 'docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1 || true', 'rm -f "$HOME/.swarm-vllm.env"', 'umask 077', 'cat > "$HOME/.swarm-vllm.env" <<\'SWARMKEY\'', `VLLM_API_KEY=${apiKey}`, 'SWARMKEY'];
  for (const { index, remote } of replicaPorts(gpus, { remotePortBase })) {
    lines.push(`docker run -d --name swarm-vllm-${index} --gpus device=${index} --ipc=host --env-file "$HOME/.swarm-vllm.env"${envFlags} -p 127.0.0.1:${remote}:8000 -v "$HOME/.cache/huggingface:/root/.cache/huggingface" ${image} --model ${model} --served-model-name ${model} --max-model-len ${maxModelLen} --max-num-seqs ${perReplica} --gpu-memory-utilization ${GPU_DEFAULTS.memoryUtilization} ${GPU_DEFAULTS.commonArgs.join(' ')} ${args.join(' ')} >/dev/null`.replace(/ +$/, ''));
  }
  lines.push('rm -f "$HOME/.swarm-vllm.env"');
  return `${lines.join('\n')}\n`;
}

export const remoteStopScript = () => 'docker rm -f $(docker ps -aq --filter name=swarm-vllm) >/dev/null 2>&1 || true\nrm -f "$HOME/.swarm-vllm.env"\n';

// Container mode (the node is itself a container running the pinned vLLM image): the key is read once in the foreground, then vllm runs directly.
export function containerStartScript({ model, gpus, maxModelLen, perReplica, args = [], seconds, remotePortBase, apiKey, env = {} }) {
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw fail('gpu-key-invalid', 'api key must be 48 lower-case hex characters');
  const envPrefix = Object.entries(validateEnvOptions(env)).map(([name, value]) => `${name}=${value} `).join('');
  const lines = [`setsid nohup sh -c 'sleep ${Math.ceil(seconds)}; pkill -f "[v]llm serve" >/dev/null 2>&1; rm -f "$HOME/.swarm-vllm.env" "$HOME"/.swarm-vllm-*.log' >/dev/null 2>&1 </dev/null &`, 'set -e', 'pkill -f "[v]llm serve" >/dev/null 2>&1 || true', 'rm -f "$HOME/.swarm-vllm.env"', 'umask 077', 'cat > "$HOME/.swarm-vllm.env" <<\'SWARMKEY\'', `VLLM_API_KEY=${apiKey}`, 'SWARMKEY', `export VLLM_API_KEY="$(sed -n 's/^VLLM_API_KEY=//p' "$HOME/.swarm-vllm.env")"`, `[ -n "$VLLM_API_KEY" ] || { echo "no key" >&2; exit 1; }`];
  for (const { index, remote } of replicaPorts(gpus, { remotePortBase })) {
    lines.push(`CUDA_VISIBLE_DEVICES=${index} ${envPrefix}setsid nohup vllm serve ${model} --served-model-name ${model} --host 127.0.0.1 --port ${remote} --max-model-len ${maxModelLen} --max-num-seqs ${perReplica} --gpu-memory-utilization ${GPU_DEFAULTS.memoryUtilization} ${GPU_DEFAULTS.commonArgs.join(' ')} ${args.join(' ')} > "$HOME/.swarm-vllm-${index}.log" 2>&1 </dev/null &`);
  }
  lines.push('rm -f "$HOME/.swarm-vllm.env"', 'unset VLLM_API_KEY');
  return `${lines.join('\n')}\n`;
}

export const containerStopScript = () => ['pkill -f "[v]llm serve" >/dev/null 2>&1 || true', 'sleep 2', 'if pgrep -f "[v]llm serve" >/dev/null 2>&1; then pkill -9 -f "[v]llm serve" >/dev/null 2>&1; sleep 1; fi', 'rm -f "$HOME/.swarm-vllm.env" "$HOME"/.swarm-vllm-*.log', '! pgrep -f "[v]llm serve" >/dev/null 2>&1'].join('\n') + '\n';

// Host part of a /proc/net/tcp(6) local address: IPv4 or IPv6 words are little-endian; returns text, or null when not recognised.
export function hostFromProcAddr(hex) {
  if (typeof hex !== 'string' || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  if (hex.length === 8) return [6, 4, 2, 0].map(at => parseInt(hex.slice(at, at + 2), 16)).join('.');
  if (hex.length !== 32) return null;
  const bytes = [];
  for (let word = 0; word < 4; word++) for (let b = 3; b >= 0; b--) bytes.push(parseInt(hex.slice(word * 8 + b * 2, word * 8 + b * 2 + 2), 16));
  if (bytes.every(item => item === 0)) return '::';
  if (bytes.slice(0, 10).every(item => item === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return `::ffff:${bytes.slice(12).join('.')}`;
  if (bytes.slice(0, 15).every(item => item === 0) && bytes[15] === 1) return '::1';
  return `ipv6:${hex}`;
}

// LISTEN sockets ({ host, port }) from the text of /proc/net/tcp and /proc/net/tcp6.
export function listeningFromProc(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === 'sl' || cols.length < 4 || cols[3] !== '0A') continue;
    const m = /^([0-9A-Fa-f]+):([0-9A-Fa-f]+)$/.exec(cols[1]);
    if (!m) continue;
    const host = hostFromProcAddr(m[1]);
    if (host !== null) out.push({ host, port: parseInt(m[2], 16) });
  }
  return out;
}

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
// node's listing (ss -ltnH, or /proc/net/tcp in container mode, which also probes options.probePorts). Throws gpu-exposure-unknown when the check cannot be made.
async function findExposure({ base, target, shown, ports, ssh, sshArgs, probePort, lookup, container = false, probePorts = [] }) {
  const host = await resolveHost({ base, target, ssh });
  const detail = port => `port ${port} on ${shown} is reachable from outside; the servers must listen on the node loopback only`;
  let addresses;
  try {
    addresses = lookup ? await lookup(host) : await dns.promises.lookup(host, { all: true });
  } catch { throw fail('gpu-exposure-unknown', `could not resolve ${host} to check the node's exposure`); }
  if (!Array.isArray(addresses) || !addresses.length) throw fail('gpu-exposure-unknown', `no address for ${host} to check the node's exposure`);
  const probeList = [...ports.map(item => item.remote), ...(container ? probePorts : [])];
  for (const item of addresses) {
    const address = item?.address;
    for (const port of probeList) if (await probePort(address, port)) return detail(port);
  }
  const listening = new Set(ports.map(item => item.remote));
  if (container) {
    let text;
    try { text = String((await ssh([...sshArgs, 'cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null; true'], {}))?.stdout ?? ''); } catch { throw fail('gpu-exposure-unknown', 'could not read the node listening sockets (/proc/net/tcp)'); }
    const sockets = listeningFromProc(text);
    if (!sockets.length) throw fail('gpu-exposure-unknown', 'could not read the node listening sockets (/proc/net/tcp)');
    const hit = sockets.find(item => listening.has(item.port) && !isLoopback(item.host));
    return hit ? detail(hit.port) : null;
  }
  let out;
  try {
    out = String((await ssh([...sshArgs, 'ss -ltnH'], {}))?.stdout ?? '');
  } catch { throw fail('gpu-exposure-unknown', 'could not read the node listening sockets (ss -ltnH)'); }
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

// Polls /v1/models until every endpoint lists the model. After each failed round, alive() (optional) may report that the server died:
// it returns false, or { alive: false, detail }, and the wait stops at once with gpu-server-died.
async function waitHealthy(endpoints, model, { fetchImpl, sleep, now, timeoutMs, pollMs = 5000, alive }) {
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
    if (alive) {
      const state = await alive();
      const isAlive = typeof state === 'boolean' ? state : state?.alive !== false;
      if (!isAlive) {
        const detail = typeof state === 'object' && state?.detail ? ` (last log lines: ${state.detail})` : '';
        throw fail('gpu-server-died', `the vLLM server exited during startup${detail}`);
      }
    }
    if (now() >= deadline) throw fail('gpu-unhealthy', `no answer from ${[...pending].join(', ')} within ${Math.round(timeoutMs / 60000)} minutes (the model may still be downloading; run swarm gpu status)`);
    await sleep(pollMs);
  }
}

// ssh(argv, { input }) -> { stdout }; openTunnel({ target, key, ports }) -> { pid, stop() }. Both injected so tests need no network.
export async function gpuUp(options, deps) {
  validateUpOptions(options);
  const { ssh, openTunnel, stopTunnel, fetchImpl = fetch, sleep = sleepReal, now = Date.now, env = process.env, log = () => {}, probePort = probeTcp, randomKey, lookup } = deps;
  if (readSessionFile(env)) throw fail('gpu-session-exists', 'a GPU session is already recorded; run swarm gpu status, or swarm gpu down first');
  const apiKey = randomKey ? randomKey() : randomBytes(24).toString('hex');
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw fail('gpu-key-invalid', 'the generated API key must be 48 lower-case hex characters');
  const sshOptions = options.sshPort !== undefined ? ['-p', String(options.sshPort), ...(options.sshOptions ?? [])] : [...(options.sshOptions ?? [])];
  const sshBase = [...sshOptions, ...SSH_HARDENING, '-o', 'ClearAllForwardings=yes', '-i', options.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20'];
  const sshArgs = [...sshBase, '--', options.target];
  const shown = options.target.split('@').pop();
  const container = options.mode === 'container';
  const probeCommand = container
    ? 'nvidia-smi -L; echo VLLM:$(command -v vllm || true); echo ROOT:$(id -u)'
    : 'nvidia-smi -L; echo SUDO:$( { [ "$(id -u)" = 0 ] || sudo -n true; } >/dev/null 2>&1 && echo ok || echo no); echo DOCKER:$(docker version --format "{{.Server.Version}}" 2>/dev/null)';
  const output = String((await ssh([...sshArgs, probeCommand], {})).stdout);
  const count = parseGpuCount(output);
  if (!container) {
    const dockerMajor = parseDockerMajor(output);
    if (dockerMajor === null || dockerMajor < 28) {
      const reported = String(output).split('\n').map(item => item.trim()).find(item => item.startsWith('DOCKER:'))?.slice('DOCKER:'.length).trim() || 'unknown';
      throw fail('gpu-docker-old', `the node has Docker ${reported}; version 28 or newer is required (older Docker lets other hosts on the same network reach ports published on 127.0.0.1)`);
    }
  }
  if (count < 1) throw fail('gpu-none', 'no GPU found on the node (nvidia-smi -L listed none)');
  if (container) {
    const vllmLine = String(output).split('\n').map(item => item.trim()).find(item => item.startsWith('VLLM:'));
    if (!(vllmLine ?? '').slice('VLLM:'.length).trim()) throw fail('gpu-no-vllm', 'the node has no vllm command; container mode needs an instance that runs the vLLM image');
  }
  const powerOff = container ? false : !output.includes('SUDO:no');
  if (!container && !powerOff) {
    if (options.allowNoPowerOff !== true) throw fail('gpu-sudo', 'passwordless sudo is not available on the node, so the timer cannot power it off; fix that or pass --allow-no-poweroff (then billing continues until you terminate the instance)');
    log('warning: passwordless sudo is not available; the timer will remove the servers but cannot power the node off, so billing continues until you terminate the instance');
  }
  const gpus = Math.min(options.gpus ?? count, count, 16);
  const hours = sessionHours({ hourlyUsd: options.hourlyUsd, maxUsd: options.maxUsd, maxHours: options.maxHours });
  const perReplica = options.perReplica ?? GPU_DEFAULTS.perReplica;
  const script = container
    ? containerStartScript({ model: options.model, gpus, maxModelLen: options.maxModelLen ?? GPU_DEFAULTS.maxModelLen, perReplica, args: options.args ?? [], env: options.env ?? {}, seconds: hours * 3600, remotePortBase: GPU_DEFAULTS.remotePortBase, apiKey })
    : remoteStartScript({ model: options.model, image: options.image ?? GPU_DEFAULTS.image, gpus, maxModelLen: options.maxModelLen ?? GPU_DEFAULTS.maxModelLen, perReplica, args: options.args ?? [], env: options.env ?? {}, seconds: hours * 3600, remotePortBase: GPU_DEFAULTS.remotePortBase, apiKey });
  const ports = replicaPorts(gpus, { localPortBase: options.localPort ?? GPU_DEFAULTS.localPortBase });
  const endpoints = ports.map(port => `http://127.0.0.1:${port.local}`);
  const startedAt = now();
  const session = { version: 1, bestOf: options.bestOf ?? 1, target: options.target, key: options.key, apiKey, model: options.model, quant: options.quant ?? null, replicas: gpus, endpoints, perReplica, hourlyUsd: options.hourlyUsd, capUsd: options.maxUsd, maxHours: hours, startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + hours * 3600000).toISOString(), tunnelPid: null, sshOptions, routable: options.routable !== false, powerOff, mode: container ? 'container' : 'vm', state: 'starting' };
  createSession(env, session);

  const exposureCheck = async () => {
    const detail = await findExposure({ base: sshBase, target: options.target, shown, ports, ssh, sshArgs, probePort, lookup, container, probePorts: options.probePorts ?? [] });
    if (detail !== null) throw Object.assign(fail('gpu-exposed', detail), { exposure: true });
  };

  // Container mode checks the vLLM processes; VM mode checks the first replica container. One ssh call per poll round; an ssh failure counts as alive (unknown).
  const aliveCheck = async () => {
    const command = container
      ? 'pgrep -f "[v]llm serve" >/dev/null 2>&1 && echo ALIVE || { echo DEAD; tail -n 15 "$HOME/.swarm-vllm-0.log" 2>/dev/null; }'
      : 'docker ps -q --filter name=swarm-vllm-0 | grep -q . && echo ALIVE || { echo DEAD; docker logs --tail 15 swarm-vllm-0 2>&1; }';
    let out;
    try { out = String((await ssh([...sshArgs, command], {}))?.stdout ?? ''); } catch { return { alive: true, detail: '' }; }
    // Only an explicit DEAD marker counts as dead; an empty or odd answer means unknown, which counts as alive.
    if (!out.trimStart().startsWith('DEAD')) return { alive: true, detail: '' };
    const detail = out.split('\n').slice(1).map(line => line.trimEnd().slice(0, 200)).filter(line => line.length > 0).slice(0, 15).join(' | ');
    return { alive: false, detail };
  };

  // Any failure after the session file exists: stop the servers over ssh (ignoring errors, but noting success), stop the tunnel when one is recorded,
  // remove the session file, then rethrow with a message that says whether the stop worked and a key-less session copy on error.session.
  const afterStartFailure = async error => {
    let stopped = false;
    try { await ssh([...sshArgs, 'bash -s'], { input: container ? containerStopScript() : remoteStopScript() }); stopped = true; } catch { /* ignored: the timer still removes them */ }
    if (Number.isInteger(session.tunnelPid) && session.tunnelPid > 1 && stopTunnel) { try { await stopTunnel(session.tunnelPid, session); } catch { /* already gone */ } }
    removeSession(env);
    const verb = container ? 'destroy' : 'terminate';
    if (error?.exposure) {
      error.message = `${error.message}; ${stopped ? 'the servers were stopped' : `the servers could NOT be stopped from here; the timer on the node will remove them at ${session.expiresAt}; ${verb} the instance`}`;
    } else {
      error.message = `${error.message} ${stopped ? '(the servers were stopped)' : '(could not stop the servers from here; the timer on the node still fires)'}`;
    }
    if (container) error.message = `${error.message} Destroy the instance now (node bench/gpu-bakeoff/vast.mjs destroy).`;
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
    await waitHealthy(endpoints, options.model, { fetchImpl: authFetch(fetchImpl, apiKey), sleep, now, timeoutMs: options.healthTimeoutMs ?? GPU_DEFAULTS.healthTimeoutMs, pollMs: options.pollMs, alive: aliveCheck });
    for (const endpoint of endpoints) {
      let refused = false;
      try { const response = await fetchImpl(`${endpoint}/v1/models`); refused = response.status === 401 || response.status === 403; } catch { refused = false; }
      if (!refused) throw fail('gpu-no-auth', `the server at ${endpoint} answers without the API key`);
    }
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
  const container = session.mode === 'container';
  const notes = [];
  let sshOk = true;
  try {
    await ssh([...sessionSshOptions(session), ...SSH_HARDENING, '-o', 'ClearAllForwardings=yes', '-i', session.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=20', '--', session.target, 'bash -s'], { input: container ? containerStopScript() : remoteStopScript() });
  } catch (error) { sshOk = false; notes.push(`could not reach the node to stop the servers (${String(error.message).slice(0, 120)}); its dead-man timer still removes them at ${session.expiresAt}`); }
  try { if (Number.isInteger(session.tunnelPid) && session.tunnelPid > 1) await stopTunnel(session.tunnelPid, session); } catch { /* already gone */ }
  removeSession(env);
  const hours = Math.max(0, (now() - Date.parse(session.startedAt)) / 3600000);
  const reminder = container
    ? 'This does NOT stop the rental: destroy the instance (provider console or the rental helper) now.'
    : 'This does NOT stop the rental: terminate the instance in the provider console now.';
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
  const verb = session.mode === 'container' ? 'destroy' : 'terminate';
  return { cacheHitRate: cache.hitRate, bestOf: session.bestOf ?? 1, mode: session.mode ?? 'vm', active: !expired, expired, model: session.model, replicas, hours, spentUsd: Math.round(hours * session.hourlyUsd * 100) / 100, capUsd: session.capUsd, minutesLeft: Math.max(0, Math.round((expires - now()) / 60000)), hourlyUsd: session.hourlyUsd, expiresAt: session.expiresAt, billingNote: expired ? `the node may still be billing: ${verb} the instance` : null };
}

export function formatStatus(status) {
  if (!status.active && !status.expired) return 'No GPU session. Nothing is rented by swarm; start one with swarm gpu up on a node you rented.';
  const up = status.replicas.filter(item => item.healthy).length;
  const verb = status.mode === 'container' ? 'destroy' : 'terminate';
  return [`GPU session: ${status.model}`, `Replicas: ${up} of ${status.replicas.length} answering${status.bestOf > 1 ? `; best-of-${status.bestOf} on` : ''}${status.cacheHitRate === null || status.cacheHitRate === undefined ? '' : `; prefix cache hit ${Math.round(status.cacheHitRate * 100)}%`}`, `Time: ${status.hours.toFixed(2)} h used, ${status.expired ? `EXPIRED, ${verb} the instance, billing may continue` : `${status.minutesLeft} min left`}`, `Cost: about $${status.spentUsd.toFixed(2)} of the $${status.capUsd.toFixed(2)} cap ($${status.hourlyUsd}/h)`].join('\n');
}
