// SPDX-License-Identifier: Apache-2.0
// Throughput stress: N stub API jobs through runManifest with a fake fetch.
// node bench/throughput/stress.mjs [--jobs 2000] [--concurrency 512] [--latency 5]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runManifest } from '../../tools/swarm.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : Number(process.argv[i + 1]); };
const jobsCount = arg('jobs', 2000), concurrency = arg('concurrency', 512), latency = arg('latency', 5);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-stress-')));
execFileSync('git', ['init', '-q', root]);
await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
execFileSync('git', ['-C', root, 'add', '.']);
execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-qm', 'i']);
const started = Date.now();
const jobs = Array.from({ length: jobsCount }, (_, n) => ({ id: `job-${n}`, agent: 'ollama', model: 'm', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 60000 }));
let inFlight = 0, peakInFlight = 0, firstFetchAt = null;
const fetchImpl = async (url, options) => {
  if (firstFetchAt === null) firstFetchAt = Date.now() - started; inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
  const n = /out\/(\d+)\.txt/.exec(options.body)[1];
  await new Promise(resolve => setTimeout(resolve, latency));
  inFlight--;
  return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'ok', files: [{ path: `out/${n}.txt`, content: `o${n}\n` }] }) } }), { headers: { 'content-type': 'application/json' } });
};
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
let stateWrites = 0;
const state = await runManifest(root, { version: 1, concurrency, lanes: { ollama: { concurrency } }, jobs }, {
  env: { SWARM_CONFIG: process.env.SWARM_CONFIG, SWARM_SPEND_DIR: path.join(root, '.swarm/spend') }, fetchImpl, id: 'stress', onState: () => { stateWrites++; },
});
clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
const stateBytes = (await fs.stat(path.join(root, '.swarm/runs/stress/state.json'))).size;
const done = state.jobs.filter(job => job.status === 'complete').length;
console.log(JSON.stringify({ jobs: jobsCount, complete: done, status: state.status, seconds: (Date.now() - started) / 1000, startupSeconds: firstFetchAt / 1000, peakInFlight, lane: state.lanes?.lanes?.ollama, globalPeak: state.lanes?.peakGlobal, globalConcurrency: state.lanes?.globalConcurrency, peakRssMiB: Math.round(peakRss / 1048576), stateBytes, onStateCalls: stateWrites }));
await fs.rm(root, { recursive: true, force: true });
