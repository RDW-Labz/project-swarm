// SPDX-License-Identifier: Apache-2.0
// `swarm gpu bakeoff` (Phase 14e): ranks candidate small coding models on ONE rented GPU using our own tasks (the lane benchmark, and
// the eval set under evals/ once Phase 15 builds it), never vendor SWE-bench numbers. Per model it reports pass rate (N=1 and best-of-N under load),
// tokens per second and ms per token at each agent count, agents per GPU, and cost per passing task.
// Everything that touches the network, ssh or the benchmark is injected, so tests run with fakes.
import fs from 'node:fs';
import path from 'node:path';
import { SHORTLIST } from './gpu.mjs';

export const LEVELS = Object.freeze([32, 64, 96, 128, 192]);
export const MAX_MS_PER_TOKEN = 35;
// Like a real project run: a long shared context first (rules, contract, files: what prefix caching can reuse) and a short request-specific part last.
const SHARED_CONTEXT = Array.from({ length: 120 }, (_, n) => `Project rule ${n + 1}: keep every exported name and signature; write small pure functions; document edge cases in a comment; never read the network.`).join('\n');
let sequence = 0;
const messagesFor = () => [{ role: 'system', content: SHARED_CONTEXT }, { role: 'user', content: `${PROMPT}\n\n(request ${(sequence += 1)})` }];
const PROMPT = 'Write a JavaScript function `mergeIntervals(list)` that merges overlapping [start, end] intervals and returns them sorted. Include three assert-based tests. Reply with code only.';
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 10000) / 10000;

// `level` agents at once, each sending `rounds` requests one after another. Tokens are the server's own completion_tokens count.
export async function measureThroughput({ endpoint, model, level, rounds = 2, maxTokens = 256, fetchImpl = fetch, now = Date.now }) {
  const latencies = [];
  let tokens = 0, errors = 0, requests = 0;
  const started = now();
  await Promise.all(Array.from({ length: level }, async () => {
    for (let round = 0; round < rounds; round += 1) {
      const begin = now();
      requests += 1;
      try {
        const response = await fetchImpl(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: messagesFor(), max_tokens: maxTokens, stream: false }) });
        if (!response.ok) { errors += 1; continue; }
        const body = await response.json();
        const used = body?.usage?.completion_tokens;
        if (!Number.isFinite(used)) { errors += 1; continue; }
        tokens += used;
        latencies.push(now() - begin);
      } catch { errors += 1; }
    }
  }));
  const seconds = Math.max((now() - started) / 1000, 0.001);
  latencies.sort((a, b) => a - b);
  const perAgent = r2(tokens / seconds / level);
  return { level, requests, errors, errorRate: requests ? errors / requests : 0, tokens, seconds: r2(seconds), tokPerSec: r2(tokens / seconds), tokPerSecPerAgent: perAgent, msPerToken: perAgent > 0 ? r1(1000 / perAgent) : null, p95Ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null };
}

// The most agents one GPU serves well: the highest level with errors at or under maxErrorRate and msPerToken at or under maxMsPerToken.
export function agentsPerGpu(levels, { maxErrorRate = 0.05, maxMsPerToken = MAX_MS_PER_TOKEN } = {}) {
  // ms per token comes from the level itself, or from its per-agent speed when only that was recorded
  const ms = item => (typeof item.msPerToken === 'number' ? item.msPerToken : item.tokPerSecPerAgent > 0 ? 1000 / item.tokPerSecPerAgent : null);
  const good = levels.filter(item => item.errorRate <= maxErrorRate && ms(item) !== null && ms(item) <= maxMsPerToken);
  return good.length ? Math.max(...good.map(item => item.level)) : 0;
}

// Starts `agents` background loops that keep sending chat requests until fn settles. Errors are ignored, with a 10 ms pause after each.
export async function runUnderLoad({ endpoint, model, agents, fetchImpl = fetch }, fn) {
  if (!(agents > 0)) return fn();
  let stop = false;
  const pause = () => new Promise(resolve => setTimeout(resolve, 10));
  const loop = async () => {
    while (!stop) {
      try {
        const response = await fetchImpl(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: messagesFor(), max_tokens: 64, stream: false }) });
        if (typeof response?.text === 'function') await response.text();
        if (response && response.ok === false) await pause();
      } catch { await pause(); }
    }
  };
  const loops = Array.from({ length: agents }, () => loop());
  try { return await fn(); } finally { stop = true; await Promise.all(loops); }
}

export function rankResults(results) {
  const cost = item => item.costPerPassUsd ?? Infinity;
  return [...results].sort((a, b) => {
    if (!!a.error !== !!b.error) return a.error ? 1 : -1;
    if (a.error) return 0;
    if (cost(a) !== cost(b)) return cost(a) < cost(b) ? -1 : 1;
    return (b.agentsPerGpu ?? 0) - (a.agentsPerGpu ?? 0);
  });
}

async function hardTaskSafely(hardTask, context) {
  try { return await hardTask(context); } catch (error) { return { passed: 0, total: 16, passedAll: false, seconds: null, attempts: 0, tokens: 0, status: 'error', error: String(error?.message ?? error).slice(0, 200) }; }
}

// candidates: [{ label, model, quant, args, env, optional }]; deps:
//   start(candidate, { remainingUsd }) -> { endpoint, stop() }   one replica on one GPU, healthy when it returns
//   throughput({ endpoint, model, level }) -> measureThroughput result
//   cacheStats({ endpoint }) -> { hitRate } | null   vLLM prefix-cache hit rate after the run
//   benchmark({ endpoint, model, candidate, bestOf }) -> { passed, total }   our own tasks (lane benchmark + evals)
//   hardTask({ endpoint, model, candidate, bestOf }) optional -> { passed, total, passedAll, seconds, attempts, tokens, status, error }   the hard task, run under the same load
//   withLoad(context, fn) optional: runs fn under background load (runUnderLoad)
export async function runBakeoff({ candidates, hourlyUsd, capUsd, levels = LEVELS, bestOf = [1, 3], minRemainingHours = 1 }, deps) {
  const { start, benchmark, throughput, cacheStats = async () => null, withLoad = (context, fn) => fn(), now = Date.now, log = () => {} } = deps;
  const results = [];
  let spent = 0;
  for (const candidate of candidates) {
    const base = { label: candidate.label, model: candidate.model, quant: candidate.quant };
    if (spent >= capUsd) { results.push({ ...base, error: `skipped: the session cap of $${capUsd} was reached` }); continue; }
    if (candidate.optional === true && (capUsd - spent) / hourlyUsd < minRemainingHours) { results.push({ ...base, error: `skipped: optional candidate, under ${minRemainingHours} h of the cap left` }); continue; }
    const began = now();
    let replica = null;
    try {
      replica = await start(candidate, { remainingUsd: capUsd - spent });
      const endpoint = replica.endpoint;
      const model = candidate.model;
      log(`${candidate.label}: server up, sweeping agent counts`);
      const measured = [];
      for (const level of levels) {
        log(`${candidate.label}: ${level} agents`);
        const result = await throughput({ endpoint, model, level });
        const cache = await cacheStats({ endpoint });
        measured.push({ ...result, cacheHitRate: cache?.hitRate ?? null });
      }
      const chosenAgents = agentsPerGpu(measured) || Math.min(...levels);
      // Best-of-N at the chosen agent count, under background load. N=1 is the ranking pass rate.
      const counts = [...new Set([1, ...bestOf])].sort((a, b) => a - b);
      const byBestOf = [];
      for (const n of counts) {
        const { run, hard } = await withLoad({ endpoint, model, agents: chosenAgents }, async () => {
          const benchRun = await benchmark({ endpoint, model, candidate, bestOf: n });
          const hardRun = deps.hardTask ? await hardTaskSafely(deps.hardTask, { endpoint, model, candidate, bestOf: n }) : undefined;
          return { run: benchRun, hard: hardRun };
        });
        byBestOf.push({ n, passed: run.passed, total: run.total, passRate: run.total ? run.passed / run.total : 0, ...(hard ? { hard } : {}) });
      }
      const bench = byBestOf[0];
      const hours = (now() - began) / 3600000;
      const costUsd = r4(hours * hourlyUsd);
      results.push({ ...base, passed: bench.passed, total: bench.total, passRate: bench.passRate, byBestOf, levels: measured, agentsPerGpu: agentsPerGpu(measured), chosenAgents, cacheHitRate: measured.length ? measured[measured.length - 1].cacheHitRate : null, minutes: r2(hours * 60), costUsd, costPerPassUsd: bench.passed > 0 ? r4(costUsd / bench.passed) : null });
      spent += costUsd;
    } catch (error) {
      spent += ((now() - began) / 3600000) * hourlyUsd;
      results.push({ ...base, error: String(error?.message ?? error).slice(0, 200) });
    } finally {
      try { await replica?.stop(); } catch (error) {
        console.error('[tools/gpu-bakeoff.mjs] stop gpu replica:', error?.message ?? error);
      }
    }
  }
  return { ranked: rankResults(results), spentUsd: r2(spent) };
}

const hardLines = item => {
  const entries = (item.byBestOf ?? []).filter(entry => entry.hard);
  if (!entries.length) return [];
  return ['', `### Hard task (planWaves), ${item.label}`, '', '| Best-of | Tests passed | Time | Attempts | Tokens | Status |', '| --- | --- | --- | --- | --- | --- |', ...entries.map(entry => { const hard = entry.hard; const time = hard.seconds === null || hard.seconds === undefined ? 'n/a' : `${hard.seconds} s`; const status = hard.error ? `${hard.status}: ${hard.error}` : hard.status; return `| N=${entry.n} | ${hard.passed}/${hard.total} | ${time} | ${hard.attempts} | ${hard.tokens} | ${status} |`; })];
};
const usd = value => (value === null || value === undefined ? 'n/a' : `$${value.toFixed(value < 1 ? 4 : 2)}`);
const pct = value => (value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`);
const row = cells => `| ${cells.join(' | ')} |`;

export function renderBakeoff({ ranked, spentUsd }, { hourlyUsd, gpu = 'one GPU', date = new Date().toISOString().slice(0, 10), evalTasks = 0, levels = LEVELS } = {}) {
  const summary = ranked.map((item, index) => {
    const rank = index + 1;
    if (item.error) return row([rank, item.label, `failed: ${item.error}`, '', '', '', '', '', '', '']);
    const parts = (item.byBestOf ?? []).filter(entry => entry.n > 1).map(entry => (entry.n === 3 ? `${entry.passed}/${entry.total}` : `N=${entry.n}: ${entry.passed}/${entry.total}`));
    return row([rank, item.label, item.quant, usd(item.costPerPassUsd), `${item.passed}/${item.total} (${pct(item.passRate)})`, parts.join(', ') || 'n/a', item.agentsPerGpu, item.chosenAgents ?? 'n/a', pct(item.cacheHitRate), `${item.minutes} min, ${usd(item.costUsd)}`]);
  });
  const details = ranked.filter(item => !item.error).map(item => [
    `## ${item.label}`,
    '',
    '| Agents | ms/token | output tok/s | tok/s per agent | errors | prefix cache hit |',
    '| --- | --- | --- | --- | --- | --- |',
    ...item.levels.map(entry => `| ${entry.level} | ${entry.msPerToken ?? 'n/a'} | ${entry.tokPerSec} | ${entry.tokPerSecPerAgent} | ${entry.errors} | ${pct(entry.cacheHitRate)} |`),
    ...hardLines(item),
  ].join('\n'));
  const header = row(['Rank', 'Model', 'Quant', 'Cost per passing task', 'Pass rate N=1', 'Pass rate N=3', 'Max agents (under 35 ms/token)', 'Chosen agents', 'Prefix cache hit', 'Time, cost']);
  const separator = row(Array(10).fill('---'));
  return `# GPU bake-off\n\nRun ${date} on ${gpu} at $${hourlyUsd}/h. Models are ranked on OUR tasks (the lane benchmark${evalTasks ? ` plus ${evalTasks} eval-set tasks` : '; the lessons eval set does not exist yet (Phase 15), so it is not included'}), not vendor SWE-bench numbers. FP8 first.\n\n${header}\n${separator}\n${summary.join('\n')}\n\nThe hard task (planWaves) gives the model only the spec and a stub, grades it with 16 hidden tests, and allows 10 minutes per attempt; Claude solved it in about 30 s with 16/16.\n\n${details.join('\n\n')}\n\nAgents per GPU is the highest tested agent count with under 5% errors and at most ${MAX_MS_PER_TOKEN} ms per token for each agent (tested counts: ${levels.join(', ')}). Best-of-N asks the server for N answers per task and keeps the smallest passing one; it is measured with background load at the chosen agent count. Ranking is cost per passing task, then agents per GPU. Prefix cache hit is vLLM's own counter after the run. Cost per passing task is the model's whole slot on the node at the hourly price, divided by tasks passed. Total spent on the node during the bake-off: ${usd(spentUsd)}.\n`;
}

export function writeBakeoffReport(root, text) {
  const file = path.join(root, 'docs', 'state', 'gpu-bakeoff.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

export function countEvalTasks(root) {
  try { return fs.readdirSync(path.join(root, 'evals'), { withFileTypes: true }).filter(entry => entry.isDirectory()).length; } catch { return 0; }
}

export function selectCandidates(spec) {
  if (!spec) return SHORTLIST.map(item => ({ ...item, args: [...(item.args ?? [])], env: { ...(item.env ?? {}) } }));
  return String(spec).split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const known = SHORTLIST.find(entry => entry.label === item || entry.model === item);
    return known ? { ...known, args: [...(known.args ?? [])], env: { ...(known.env ?? {}) } } : { label: item.split('/').pop().toLowerCase(), model: item, quant: /nvfp4/i.test(item) ? 'nvfp4' : 'fp8', args: [], env: {} };
  });
}
