// SPDX-License-Identifier: Apache-2.0
// CLI glue for `swarm gpu models|up|down|status|bakeoff`. Swarm never rents a node: these commands only talk to one the owner already
// rented. `up` and `bakeoff` print what they would do and stop unless --yes is given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gpuUp, gpuDown, gpuStatus, formatStatus, sessionHours, validateUpOptions, SHORTLIST, GPU_DEFAULTS, readSessionFile, removeSession } from './gpu.mjs';
import { runBakeoff, renderBakeoff, writeBakeoffReport, measureThroughput, countEvalTasks, selectCandidates, LEVELS } from './gpu-bakeoff.mjs';

const VALUE_FLAGS = new Set(['target', 'key', 'model', 'models', 'hourly-usd', 'max-usd', 'max-hours', 'gpus', 'per-replica', 'max-model-len', 'image', 'levels', 'repo']);
const BOOLEAN_FLAGS = new Set(['yes', 'json', 'extra-quant']);

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
const expand = file => (typeof file === 'string' && file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);

export function upOptions(flags, extra = {}) {
  return { target: flags.target, key: expand(flags.key), model: flags.model, hourlyUsd: num(flags['hourly-usd']), maxUsd: num(flags['max-usd']), maxHours: num(flags['max-hours']), gpus: num(flags.gpus), perReplica: num(flags['per-replica']), maxModelLen: num(flags['max-model-len']), image: flags.image, ...extra };
}

export function planText(options, { gpus = options.gpus ?? 'all' } = {}) {
  const hours = sessionHours(options);
  return `Plan (nothing is started yet):\n  node: ${options.target} (a node you already rented; swarm rents nothing)\n  model: ${options.model}, one server per GPU (${gpus}), reached through an ssh tunnel, no key on the node\n  price: $${options.hourlyUsd}/h; hard cap $${options.maxUsd} => the session ends after ${hours.toFixed(2)} h, and a timer on the node removes the servers and powers it off then\n  sent to the node: commands only; no files, keys or .env\n  jobs: only sensitive: false, each with exact files, a contract file and acceptance tests; one failure goes to Haiku, then Codex\nAdd --yes to go.`;
}

function sshReal(argv, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', argv, { timeout: 600000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(new Error(String(stderr || error.message).trim().slice(0, 300)), { code: 'gpu-ssh' })) : resolve({ stdout })));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function openTunnelReal({ target, key, ports, sshOptions = [] }) {
  const forwards = ports.flatMap(port => ['-L', `127.0.0.1:${port.local}:127.0.0.1:${port.remote}`]);
  const child = spawn('ssh', [...sshOptions, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-i', key, ...forwards, '--', target], { detached: true, stdio: 'ignore' });
  child.unref();
  return Promise.resolve({ pid: child.pid, stop: () => { try { process.kill(child.pid); } catch { /* gone */ } } });
}

const stopTunnelReal = pid => { try { process.kill(pid); } catch { /* gone */ } };

export async function runGpuCommand(args, deps = {}) {
  const out = deps.out ?? (text => process.stdout.write(`${text}\n`));
  const env = deps.env ?? process.env;
  const [verb, ...rest] = args;
  const flags = parseGpuFlags(rest);
  const real = { ssh: deps.ssh ?? sshReal, openTunnel: deps.openTunnel ?? openTunnelReal, stopTunnel: deps.stopTunnel ?? stopTunnelReal, fetchImpl: deps.fetchImpl ?? fetch, env, log: message => process.stderr.write(`${message}\n`), ...(deps.gpu ?? {}) };
  if (verb === 'models') {
    out(SHORTLIST.map(item => `${item.label}\t${item.model}\t${item.quant}${item.extra ? '\t(extra run)' : ''}`).join('\n'));
    out('Hugging Face ids are a shortlist: check each one exists before renting. FP8 runs first; NVFP4 only with --extra-quant.');
    return { status: 'ok' };
  }
  if (verb === 'status') {
    const status = await gpuStatus(real);
    out(flags.json ? JSON.stringify(status) : formatStatus(status));
    return status;
  }
  if (verb === 'down') {
    const result = await gpuDown(real);
    out(flags.json ? JSON.stringify(result) : `${result.message}${result.stopped ? ` Used ${result.hours.toFixed(2)} h, about $${result.costUsd.toFixed(2)}.` : ''}${(result.notes ?? []).map(note => `\n${note}`).join('')}`);
    return result;
  }
  if (verb === 'up') {
    const options = upOptions(flags);
    validateUpOptions(options);
    if (!flags.yes) { out(planText(options)); return { status: 'planned' }; }
    const session = await gpuUp(options, real);
    out(flags.json ? JSON.stringify(session) : `GPU session up: ${session.replicas} replica(s) of ${session.model}. Expires ${session.expiresAt}. Run jobs with agent "rented" (or auto), then swarm gpu down and terminate the instance.`);
    return session;
  }
  if (verb === 'bakeoff') return bakeoff(flags, { out, real, deps });
  throw Object.assign(new Error('gpu-usage: swarm gpu models | up | down | status | bakeoff'), { code: 'gpu-usage' });
}

async function bakeoff(flags, { out, real, deps }) {
  const candidates = selectCandidates(flags.models);
  const base = upOptions({ ...flags, model: candidates[0]?.model ?? 'x/y' }, { gpus: 1 });
  validateUpOptions(base);
  if (!flags.yes) { out(`${planText(base, { gpus: '1' })}\nThe bake-off tests ${candidates.map(item => item.label).join(', ')}${flags["extra-quant"] ? ' (and the NVFP4 extras)' : ''} one after another on one GPU, at ${LEVELS.join(', ')} concurrent agents. It stops starting models once the cap is spent.`); return { status: 'planned' }; }
  const root = path.resolve(flags.repo ?? deps.bakeRoot ?? '.');
  const levels = flags.levels ? flags.levels.split(',').map(Number) : LEVELS;
  if (levels.some(level => !Number.isInteger(level) || level < 1 || level > 2000)) throw Object.assign(new Error('gpu-usage: --levels must be whole numbers from 1 to 2000'), { code: 'gpu-usage' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bakeoff-'));
  const bench = deps.bench ?? await import('../bench/lane-benchmark/lib.mjs');
  const runner = deps.runner ?? fileURLToPath(new URL('./swarm.mjs', import.meta.url));
  const info = deps.baseInfo ?? bench.buildBaseRepo(root, 'HEAD', path.join(tmp, 'repo'));
  const repo = path.join(tmp, 'repo');
  const results = await runBakeoff({ candidates, hourlyUsd: base.hourlyUsd, capUsd: base.maxUsd, levels, includeExtra: flags["extra-quant"] === true }, {
    log: real.log,
    start: async (candidate, { remainingUsd }) => {
      const session = await gpuUp({ ...base, model: candidate.model, quant: candidate.quant, args: candidate.args, replace: true, maxUsd: Math.max(remainingUsd, 0.01) }, real);
      return { endpoint: session.endpoints[0], stop: () => gpuDown(real) };
    },
    benchmark: async ({ model }) => {
      const run = bench.runLane({ lane: 'rented', repo, runner, model, maxUsd: base.maxUsd, baseInfo: info, log: real.log });
      return { passed: run.results.filter(item => item.pass).length, total: run.results.length };
    },
    throughput: ({ endpoint, model, level }) => measureThroughput({ endpoint, model, level, fetchImpl: real.fetchImpl }),
  });
  const text = renderBakeoff(results, { hourlyUsd: base.hourlyUsd, evalTasks: countEvalTasks(root), levels });
  const file = writeBakeoffReport(root, text);
  out(`${text}\nWritten to ${file}. Terminate the instance in the provider console now.`);
  return results;
}

export { readSessionFile, removeSession, GPU_DEFAULTS };
