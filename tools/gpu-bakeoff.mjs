// SPDX-License-Identifier: Apache-2.0
// `swarm gpu bakeoff` (Phase 14e): ranks candidate small coding models on ONE rented GPU using our own tasks (the lane benchmark, and
// the eval set under evals/ once Phase 15 builds it), never vendor SWE-bench numbers. Per model it reports pass rate, tokens per second
// at 1, 50 and 200 concurrent agents, agents per GPU, and cost per passing task. FP8 first; NVFP4 candidates only as extra runs.
// Everything that touches the network, ssh or the benchmark is injected, so tests run with fakes.
import fs from 'node:fs';
import path from 'node:path';
import { SHORTLIST } from './gpu.mjs';

export const LEVELS = Object.freeze([1, 50, 200]);
const PROMPT = 'Write a JavaScript function `mergeIntervals(list)` that merges overlapping [start, end] intervals and returns them sorted. Include three assert-based tests. Reply with code only.';
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
        const response = await fetchImpl(`${endpoint}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: maxTokens, stream: false }) });
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
  return { level, requests, errors, errorRate: requests ? errors / requests : 0, tokens, seconds: r2(seconds), tokPerSec: r2(tokens / seconds), tokPerSecPerAgent: r2(tokens / seconds / level), p95Ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null };
}

// The most agents one GPU serves well: the highest level with under 5% errors and at least 10 tokens/s for each agent.
export function agentsPerGpu(levels, { maxErrorRate = 0.05, minPerAgent = 10 } = {}) {
  const good = levels.filter(item => item.errorRate <= maxErrorRate && item.tokPerSecPerAgent >= minPerAgent);
  return good.length ? Math.max(...good.map(item => item.level)) : 0;
}

export function rankResults(results) {
  const key = item => (item.error ? [-1, Infinity] : [item.passRate, item.costPerPassUsd ?? Infinity]);
  return [...results].sort((a, b) => { const [pa, ca] = key(a), [pb, cb] = key(b); return pb - pa || ca - cb; });
}

// candidates: [{ label, model, quant, args, extra }]; deps:
//   start(candidate) -> { endpoint, stop() }   one replica on one GPU, healthy when it returns
//   benchmark({ endpoint, model, candidate, bestOf }) -> { passed, total, tasks? }   (run once per best-of count)
//   cacheStats({ endpoint }) -> { hitRate } | null   vLLM prefix-cache hit rate after the run
//   our own tasks (lane benchmark + evals)
//   throughput({ endpoint, model, level }) -> measureThroughput result
export async function runBakeoff({ candidates, hourlyUsd, capUsd, levels = LEVELS, includeExtra = false, bestOf = [1, 3] }, deps) {
  const { start, benchmark, throughput, cacheStats = async () => null, now = Date.now, log = () => {} } = deps;
  const ordered = [...candidates.filter(item => item.quant !== 'nvfp4' && !item.extra), ...(includeExtra ? candidates.filter(item => item.quant === 'nvfp4' || item.extra) : [])];
  const results = [];
  let spent = 0;
  for (const candidate of ordered) {
    if (spent >= capUsd) { results.push({ label: candidate.label, model: candidate.model, quant: candidate.quant, error: `skipped: the session cap of $${capUsd} was reached` }); continue; }
    const began = now();
    let replica = null;
    try {
      replica = await start(candidate, { remainingUsd: capUsd - spent });
      log(`${candidate.label}: server up, running our tasks`);
      // Best-of-N: the same tasks at N=1 and at N=3 (default) show what picking the best of N copies is worth. Ranking uses N=1.
      const counts = [...new Set([1, ...bestOf])].sort((a, b) => a - b);
      const byBestOf = [];
      for (const n of counts) { const run = await benchmark({ endpoint: replica.endpoint, model: candidate.model, candidate, bestOf: n }); byBestOf.push({ n, passed: run.passed, total: run.total, passRate: run.total ? run.passed / run.total : 0 }); }
      const bench = byBestOf[0];
      const measured = [];
      for (const level of levels) { log(`${candidate.label}: ${level} agents`); measured.push(await throughput({ endpoint: replica.endpoint, model: candidate.model, level })); }
      const cache = await cacheStats({ endpoint: replica.endpoint });
      const hours = (now() - began) / 3600000;
      const costUsd = r4(hours * hourlyUsd);
      results.push({ byBestOf, cacheHitRate: cache?.hitRate ?? null, label: candidate.label, model: candidate.model, quant: candidate.quant, passed: bench.passed, total: bench.total, passRate: bench.total ? bench.passed / bench.total : 0, levels: measured, agentsPerGpu: agentsPerGpu(measured), minutes: r2(hours * 60), costUsd, costPerPassUsd: bench.passed > 0 ? r4(costUsd / bench.passed) : null });
      spent += costUsd;
    } catch (error) {
      spent += ((now() - began) / 3600000) * hourlyUsd;
      results.push({ label: candidate.label, model: candidate.model, quant: candidate.quant, error: String(error.message ?? error).slice(0, 200) });
    } finally {
      try { await replica?.stop(); } catch { /* the node's dead-man timer still removes it */ }
    }
  }
  return { ranked: rankResults(results), spentUsd: r2(spent) };
}

const usd = value => (value === null || value === undefined ? 'n/a' : `$${value.toFixed(value < 1 ? 4 : 2)}`);

export function renderBakeoff({ ranked, spentUsd }, { hourlyUsd, gpu = 'one GPU', date = new Date().toISOString().slice(0, 10), evalTasks = 0, levels = LEVELS } = {}) {
  const rows = ranked.map((item, n) => (item.error
    ? `| ${n + 1} | ${item.label} | ${item.quant ?? ''} | failed: ${item.error} | | | | | | | |`
    : `| ${n + 1} | ${item.label} | ${item.quant} | ${item.passed}/${item.total} (${Math.round(item.passRate * 100)}%) | ${(item.byBestOf ?? []).filter(entry => entry.n > 1).map(entry => `N=${entry.n}: ${entry.passed}/${entry.total}`).join(', ') || 'n/a'} | ${item.cacheHitRate === null || item.cacheHitRate === undefined ? 'n/a' : `${Math.round(item.cacheHitRate * 100)}%`} | ${item.levels.map(entry => entry.tokPerSec).join(' / ')} | ${item.levels.map(entry => entry.tokPerSecPerAgent).join(' / ')} | ${item.agentsPerGpu} | ${usd(item.costPerPassUsd)} | ${item.minutes} min, ${usd(item.costUsd)} |`));
  return `# GPU bake-off

Run ${date} on ${gpu} at $${hourlyUsd}/h. Models are ranked on OUR tasks (the lane benchmark${evalTasks ? ` plus ${evalTasks} eval-set tasks` : '; the lessons eval set does not exist yet (Phase 15), so it is not included'}), not vendor SWE-bench numbers. FP8 first; NVFP4 only as an extra run.

| Rank | Model | Quant | Pass rate (N=1) | Best-of-N pass rate | Prefix cache hit | Total tok/s at ${levels.join(' / ')} agents | tok/s per agent | Agents per GPU | Cost per passing task | Time, cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

Best-of-N asks the server for N answers per task, runs the task's visible tests on each, and keeps the smallest passing one (hidden tests then score it). Prefix cache hit is vLLM's own counter after the run (the project's shared files are sent first so agents reuse them). Agents per GPU is the highest tested level with under 5% errors and at least 10 tokens/s for each agent. Cost per passing task is the model's whole slot on the node (load, our tasks, throughput) at the hourly price, divided by tasks passed. Total spent on the node during the bake-off: ${usd(spentUsd)}.
`;
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
  if (!spec) return SHORTLIST.filter(item => !item.extra).map(item => ({ ...item }));
  return String(spec).split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const known = SHORTLIST.find(entry => entry.label === item || entry.model === item);
    return known ? { ...known } : { label: item.split('/').pop().toLowerCase(), model: item, quant: /nvfp4/i.test(item) ? 'nvfp4' : 'fp8', args: [] };
  });
}
