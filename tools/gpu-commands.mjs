// SPDX-License-Identifier: Apache-2.0
// CLI glue for `swarm gpu models|up|down|status|bakeoff`. Swarm never rents a node: these commands only talk to one the owner already
// rented. `up` and `bakeoff` print what they would do and stop unless --yes is given.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gpuUp, gpuDown, gpuStatus, formatStatus, sessionHours, validateUpOptions, SHORTLIST, GPU_DEFAULTS, SSH_HARDENING, readSessionFile, removeSession, authFetch, PINNED_IMAGE } from './gpu.mjs';
import { fetchCacheStats } from './gpu-cache.mjs';
import { runBakeoff, renderBakeoff, writeBakeoffReport, measureThroughput, countEvalTasks, selectCandidates, LEVELS, runUnderLoad } from './gpu-bakeoff.mjs';

const VALUE_FLAGS = new Set(['target', 'key', 'model', 'models', 'hourly-usd', 'max-usd', 'max-hours', 'gpus', 'per-replica', 'max-model-len', 'image', 'levels', 'repo', 'best-of', 'ssh-port', 'bench-ref', 'mode', 'probe-ports', 'local-port']);
const BOOLEAN_FLAGS = new Set(['yes', 'json', 'extra-quant', 'allow-no-poweroff']);

export function parseGpuFlags(args) {
  const flags = {};
  for (let n = 0; n < args.length; n += 1) {
    const arg = args[n];
    if (!arg.startsWith('--')) throw Object.assign(new Error(`gpu-usage: unexpected argument ${arg}`), { code: 'gpu-usage' });
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else if (VALUE_FLAGS.has(name)) { flags[name] = args[n + 1]; n += 1; if (flags[name] === undefined) throw Object.assign(new Error(`gpu-usage: --${name} needs a value`), { code: 'gpu-usage' }); }
    else throw Object.assign(new Error(`gpu-usage: unknown flag --${name}`), { code: 'gpu-usage' });
  }
  return flags;
}

const num = value => (value === undefined ? undefined : Number(value));
function parseProbePorts(value) {
  if (value === undefined) return undefined;
  return String(value).split(',').map(item => {
    const text = item.trim();
    if (!/^\d+$/.test(text)) throw Object.assign(new Error('gpu-usage: --probe-ports must be comma separated port numbers'), { code: 'gpu-usage' });
    return Number(text);
  });
}
const expand = file => (typeof file === 'string' && file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);

export function upOptions(flags, extra = {}) {
  return { target: flags.target, key: expand(flags.key), model: flags.model, hourlyUsd: num(flags['hourly-usd']), maxUsd: num(flags['max-usd']), maxHours: num(flags['max-hours']), gpus: num(flags.gpus), perReplica: num(flags['per-replica']), maxModelLen: num(flags['max-model-len']), image: flags.image, sshPort: flags['ssh-port'] === undefined ? undefined : Number(flags['ssh-port']), mode: flags.mode, localPort: flags['local-port'] === undefined ? undefined : Number(flags['local-port']), probePorts: parseProbePorts(flags['probe-ports']), allowNoPowerOff: flags['allow-no-poweroff'] === true, bestOf: flags['best-of'] === undefined || flags['best-of'].includes(',') ? undefined : Number(flags['best-of']), ...extra };
}

export function planText(options, { gpus = options.gpus ?? 'all' } = {}) {
  const hours = sessionHours(options);
  return `Plan (nothing is started yet):\n  node: ${options.target}${options.sshPort === undefined ? '' : ` port ${options.sshPort}`} (${options.mode === 'container' ? 'a container instance already running the pinned vLLM image (swarm gpu up starts vllm serve inside it; no docker needed)' : 'a node you already rented; swarm rents nothing'})\n  model: ${options.model}, one server per GPU (${gpus}), reached through an ssh tunnel, no key of yours on the node (a random per-rental key protects the servers)\n  price: $${options.hourlyUsd}/h; hard cap $${options.maxUsd} => the session ends after ${hours.toFixed(2)} h${options.mode === 'container' ? '' : ', and a timer on the node removes the servers and powers it off then'}\n  sent to the node: commands only; nothing of yours (no file, key or .env); a random per-rental key is written for the servers\n  jobs: only sensitive: false, each with exact files, a contract file and acceptance tests; one failure goes to Haiku, then Codex\n  ${options.mode === 'container' ? "billing: the dollar cap and the timer end the servers, but billing continues until the instance is DESTROYED (the rental helper's reaper does that at the deadline); nothing here can power a container off" : "billing: the dollar cap ends the session, but billing continues until YOU terminate the instance; the timer powers the node off only if passwordless sudo works (checked at start)"}\n  access: the servers listen on the node loopback only, need a random per-rental API key, and gpu up fails if any server port is reachable from outside\nAdd --yes to go.`;
}

function sshReal(argv, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', argv, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(new Error(String(stderr || error.message).trim().slice(0, 300)), { code: 'gpu-ssh' })) : resolve({ stdout })));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// Resolves true when something already accepts connections on 127.0.0.1:port (the port is busy).
function portBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = busy => { socket.destroy(); resolve(busy); };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function openTunnelReal({ target, key, ports, sshOptions = [] }) {
  for (const port of ports) {
    if (await portBusy(port.local)) throw Object.assign(new Error(`gpu-port-busy: 127.0.0.1:${port.local} is already in use; close what uses it (a leftover tunnel? swarm gpu down) and retry`), { code: 'gpu-port-busy' });
  }
  const forwards = ports.flatMap(port => ['-L', `127.0.0.1:${port.local}:127.0.0.1:${port.remote}`]);
  const child = spawn('ssh', [...sshOptions, ...SSH_HARDENING, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-i', key, ...forwards, '--', target], { detached: true, stdio: 'ignore' });
  child.unref();
  await new Promise(resolve => setTimeout(resolve, 1500));
  if (child.exitCode !== null) throw Object.assign(new Error('gpu-tunnel-failed: the ssh tunnel exited at once (check the key, the host key and that the ports are free)'), { code: 'gpu-tunnel-failed' });
  return { pid: child.pid, stop: () => { try { process.kill(child.pid); } catch { /* gone */ } } };
}

// Kills the tunnel only if the pid is a real ssh process for this session's target (guards against pid reuse).
async function stopTunnelReal(pid, session) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const target = session?.target;
  if (typeof target !== 'string' || !target) return;
  try {
    const command = await new Promise((resolve, reject) => execFile('ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
    if (command.includes('ssh') && command.includes(target)) process.kill(pid);
  } catch { /* gone */ }
}

const INTERRUPT_MESSAGE = 'interrupted: servers stopped; destroy the instance if you rented one (node bench/gpu-bakeoff/vast.mjs destroy)';

// Runs work() with SIGINT/SIGTERM handlers that stop the servers (gpuDown, errors ignored), print a notice to stderr and exit 130.
// The handlers are removed when work() finishes or throws.
async function guarded(deps, real, work) {
  const target = deps.signalTarget ?? process;
  const exit = deps.exit ?? process.exit;
  const signals = ['SIGINT', 'SIGTERM'];
  const onSignal = () => {
    Promise.resolve().then(() => gpuDown(real)).catch(() => {}).then(() => {
      process.stderr.write(`${INTERRUPT_MESSAGE}\n`);
      exit(130);
    });
  };
  for (const signal of signals) target.once(signal, onSignal);
  try {
    return await work();
  } finally {
    for (const signal of signals) target.off(signal, onSignal);
  }
}

export async function runGpuCommand(args, deps = {}) {
  const out = deps.out ?? (text => process.stdout.write(`${text}\n`));
  const env = deps.env ?? process.env;
  const [verb, ...rest] = args;
  const flags = parseGpuFlags(rest);
  const real = { ssh: deps.ssh ?? sshReal, openTunnel: deps.openTunnel ?? openTunnelReal, stopTunnel: deps.stopTunnel ?? stopTunnelReal, fetchImpl: deps.fetchImpl ?? fetch, probePort: deps.probePort ?? undefined, randomKey: deps.randomKey ?? undefined, env, log: message => process.stderr.write(`${message}\n`), ...(deps.gpu ?? {}) };
  if (verb === 'models') {
    out(SHORTLIST.map(item => `${item.label}\t${item.model}\t${item.quant}${item.extra ? '\t(extra run)' : ''}`).join('\n'));
    out('Hugging Face ids are a shortlist: check each one exists before renting. FP8 runs first; NVFP4 only with --extra-quant.' + ' Server image: ' + PINNED_IMAGE + ' (pinned by digest; --image takes only another digest).');
    return { status: 'ok' };
  }
  if (verb === 'status') {
    const status = await gpuStatus(real);
    out(flags.json ? JSON.stringify({ ...status, apiKey: undefined }) : formatStatus(status));
    return status;
  }
  if (verb === 'down') {
    const result = await gpuDown(real);
    out(flags.json ? JSON.stringify({ ...result, apiKey: undefined }) : `${result.message}${result.stopped ? ` Used ${result.hours.toFixed(2)} h, about $${result.costUsd.toFixed(2)}.` : ''}${(result.notes ?? []).map(note => `\n${note}`).join('')}`);
    return result;
  }
  if (verb === 'up') {
    const options = upOptions(flags);
    validateUpOptions(options);
    if (!flags.yes) { out(planText(options)); return { status: 'planned' }; }
    const session = await guarded(deps, real, () => gpuUp(options, real));
    out(flags.json ? JSON.stringify({ ...session, apiKey: undefined }) : `GPU session up: ${session.replicas} replica(s) of ${session.model}. Expires ${session.expiresAt}. Run jobs with agent "rented" (or auto), then swarm gpu down and terminate the instance.`);
    return session;
  }
  if (verb === 'bakeoff') return bakeoff(flags, { out, real, deps });
  throw Object.assign(new Error('gpu-usage: swarm gpu models | up | down | status | bakeoff'), { code: 'gpu-usage' });
}

async function bakeoff(flags, { out, real, deps }) {
  if (readSessionFile(real.env)) throw Object.assign(new Error('gpu-session-exists: a GPU session is live; run swarm gpu down before a bake-off (the bake-off uses its own session and must not replace yours)'), { code: 'gpu-session-exists' });
  const candidates = selectCandidates(flags.models);
  const base = upOptions({ ...flags, model: candidates[0]?.model ?? 'x/y' }, { gpus: 1 });
  validateUpOptions(base);
  if (!flags.yes) { out(`${planText(base, { gpus: '1' })}\nThe bake-off tests ${candidates.map(item => item.label).join(', ')}one after another on one GPU, at ${LEVELS.join(', ')} concurrent agents. The bake-off also runs the hard task (planWaves: spec and stub only, 16 hidden tests, 10 minutes per attempt) at each best-of count. one vLLM engine per GPU; all models NVFP4, text-only; best-of-N is measured under load at the largest agent count that stays under 35 ms/token. It stops starting models once the cap is spent.`); return { status: 'planned' }; }
  const root = path.resolve(flags.repo ?? deps.bakeRoot ?? '.');
  const levels = flags.levels ? flags.levels.split(',').map(Number) : LEVELS;
  if (levels.some(level => !Number.isInteger(level) || level < 1 || level > 2000)) throw Object.assign(new Error('gpu-usage: --levels must be whole numbers from 1 to 2000'), { code: 'gpu-usage' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bakeoff-'));
  const bench = deps.bench ?? await import('../bench/lane-benchmark/lib.mjs');
  const hard = deps.hardTask ?? (await import('../bench/gpu-bakeoff/hard-task.mjs'));
  const hardTask = typeof hard === 'function' ? hard : ({ model, bestOf }) => hard.runHardTask({ model, bestOf, runner, maxUsd: base.maxUsd });
  const runner = deps.runner ?? fileURLToPath(new URL('./swarm.mjs', import.meta.url));
  const info = deps.baseInfo ?? bench.buildBaseRepo(root, flags['bench-ref'] ?? 'v1.65.0', path.join(tmp, 'repo'));
  const repo = path.join(tmp, 'repo');
  let apiKey;
  const results = await guarded(deps, real, () => runBakeoff({ candidates, hourlyUsd: base.hourlyUsd, capUsd: base.maxUsd, levels, includeExtra: flags["extra-quant"] === true, bestOf: (flags['best-of'] ?? '1,3').split(',').map(Number) }, {
    log: real.log,
    start: async (candidate, { remainingUsd }) => {
      let session;
      try {
        session = await gpuUp({ ...base, model: candidate.model, quant: candidate.quant, args: candidate.args, env: candidate.env, routable: false, perReplica: Math.max(...levels, 1), maxUsd: Math.max(remainingUsd, 0.01) }, real);
      } catch (error) {
        try { await gpuDown(real); } catch { /* ignore: the original error matters */ }
        throw error;
      }
      apiKey = session.apiKey;
      return { endpoint: session.endpoints[0], stop: () => gpuDown(real) };
    },
    withLoad: (context, fn) => runUnderLoad({ ...context, fetchImpl: authFetch(real.fetchImpl, apiKey) }, fn),
    cacheStats: async ({ endpoint }) => fetchCacheStats(endpoint, authFetch(real.fetchImpl, apiKey)),
    benchmark: async ({ model, bestOf, candidate }) => {
      const run = bench.runLane({ lane: 'rented', repo, runner, model, bestOf, maxUsd: base.maxUsd, baseInfo: info, log: real.log });
      try { const dir = path.join(root, 'docs', 'state', 'gpu-bakeoff-details'); fs.mkdirSync(dir, { recursive: true }); const label = String(candidate?.label ?? model).replace(/[^A-Za-z0-9._-]/g, '_'); const details = run.results.map(item => ({ taskId: item.taskId, type: item.type, pass: item.pass, status: item.status, error: item.error, detail: String(item.detail ?? '').slice(0, 300), durationMs: item.durationMs, tokens: item.tokens })); fs.writeFileSync(path.join(dir, `${label}-bestof${bestOf}.json`), JSON.stringify(details, null, 1)); } catch { /* writing details must never fail the benchmark */ }
      return { passed: run.results.filter(item => item.pass).length, total: run.results.length };
    },
    hardTask,
    throughput: ({ endpoint, model, level }) => measureThroughput({ endpoint, model, level, fetchImpl: authFetch(real.fetchImpl, apiKey) }),
  }));
  const text = renderBakeoff(results, { hourlyUsd: base.hourlyUsd, evalTasks: countEvalTasks(root), levels });
  const file = writeBakeoffReport(root, text);
  out(`${text}\nWritten to ${file}. Terminate the instance in the provider console now.`);
  return results;
}

export { readSessionFile, removeSession, GPU_DEFAULTS };
