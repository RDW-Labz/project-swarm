// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES, buildBaseRepo, runLane } from '../lane-benchmark/lib.mjs';
import { runHardTask } from './hard-task.mjs';

const TASK_COUNT = 11;
const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;
const log = message => process.stderr.write(`[compare] ${message}\n`);

export function costPerMillionTokens({ hourlyUsd, tokensPerSecond }) {
  return round(hourlyUsd / (tokensPerSecond * 3600) * 1e6, 4);
}

function tokenCount(tokens) {
  if (typeof tokens === 'number' && Number.isFinite(tokens)) return tokens;
  if (tokens && typeof tokens === 'object') {
    if (Number.isFinite(tokens.total_tokens)) return tokens.total_tokens;
    const parts = [tokens.input_tokens, tokens.output_tokens].filter(Number.isFinite);
    return parts.reduce((a, b) => a + b, 0);
  }
  return 0;
}

export function summarizeLane({ lane, results, hard }) {
  const tasks = results.length + (hard ? 1 : 0);
  const passed = results.filter(r => r.pass).length + (hard?.passedAll ? 1 : 0);
  const costs = [...results.map(r => r.costUsd), hard?.costUsd].filter(Number.isFinite);
  const costUsd = costs.length ? round(costs.reduce((a, b) => a + b, 0), 4) : null;
  const tokens = results.reduce((sum, r) => sum + tokenCount(r.tokens), 0) + (hard ? tokenCount(hard.tokens) : 0);
  const seconds = results.reduce((sum, r) => sum + (Number.isFinite(r.durationMs) ? r.durationMs / 1000 : 0), 0)
    + (Number.isFinite(hard?.seconds) ? hard.seconds : 0);
  return {
    lane,
    tasks,
    passed,
    passRate: tasks ? round(passed / tasks, 4) : 0,
    costUsd,
    tokens,
    costPerPassingUsd: costUsd === null || passed === 0 ? null : round(costUsd / passed, 4),
    seconds: round(seconds, 1),
  };
}

export function qwenAtFullLoad({ detailsFile, hardTokens = 0, hardPassed = false, passedLane, hourlyUsd, tokensPerSecond }) {
  const rows = JSON.parse(fs.readFileSync(detailsFile, 'utf8'));
  const laneTokens = rows.reduce((sum, r) => sum + tokenCount(r.tokens), 0);
  const tokens = laneTokens + hardTokens;
  const passed = (passedLane ?? rows.filter(r => r.pass).length) + (hardPassed ? 1 : 0);
  const usdPerMillionTokens = costPerMillionTokens({ hourlyUsd, tokensPerSecond });
  const costUsd = round(tokens / 1e6 * usdPerMillionTokens, 4);
  return { tokens, passed, usdPerMillionTokens, costUsd, costPerPassingUsd: passed ? round(costUsd / passed, 4) : null };
}

const money = value => (value === null || value === undefined ? 'subscription (not reported)' : `$${value.toFixed(4)}`);
const perPassing = value => (value === null || value === undefined ? '—' : `$${value.toFixed(4)}`);

function row(name, passed, tasks, rate, cost, perPass, tokens, time) {
  return `| ${name} | ${passed}/${tasks} | ${(rate * 100).toFixed(1)}% | ${money(cost)} | ${perPassing(perPass)} | ${tokens.toLocaleString('en-US')} | ${time} |`;
}

export function renderComparison({ lanes, qwen, date = new Date().toISOString().slice(0, 10) }) {
  const rows = lanes.map(l => row(l.lane, l.passed, l.tasks, l.passRate, l.costUsd, l.costPerPassingUsd, l.tokens, `${l.seconds} s`));
  rows.push(row('Qwen3.6 NVFP4 (rented GPU, full load)', qwen.passed, TASK_COUNT, qwen.passed / TASK_COUNT, qwen.costUsd, qwen.costPerPassingUsd, qwen.tokens, '—'));
  const paragraph = `The Qwen3.6 NVFP4 row is computed, not reported by a lane: all tokens of the ${TASK_COUNT} tasks are priced at the price of a token on a GPU kept fully busy, that is the hourly price divided by the measured output tokens per second at 128 agents, which gives $${qwen.usdPerMillionTokens} per million tokens. The lane rows (Haiku and Codex) are what the lanes reported.`;
  return [
    `# Lane comparison (${date})`,
    '',
    '| Lane | Passed | Pass rate | Cost | Cost per passing task | Tokens | Time |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    paragraph,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { lanes: 'anthropic-haiku,codex', runner: null, maxUsd: 1, root: process.cwd() };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!(key in args) || value === undefined) throw new Error(`bad argument ${argv[i]}`);
    args[key] = key === 'maxUsd' ? Number(value) : value;
  }
  return args;
}

function main(argv) {
  const opts = parseArgs(argv);
  const root = path.resolve(opts.root);
  const runner = path.resolve(opts.runner ?? fileURLToPath(new URL('../../tools/swarm.mjs', import.meta.url)));
  const detailsDir = path.join(root, 'docs/state/lane-comparison-details');
  fs.mkdirSync(detailsDir, { recursive: true });
  const lanes = [];
  for (const lane of opts.lanes.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!LANES[lane]) throw new Error(`unknown lane ${lane}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bench-cmp-${lane}-`));
    try {
      log(`${lane}: building base repo`);
      const repo = path.join(tmp, 'repo');
      const baseInfo = buildBaseRepo(root, 'v1.65.0', repo);
      const run = runLane({ lane, repo, runner, maxUsd: opts.maxUsd, baseInfo, log });
      let hard = null;
      try {
        hard = runHardTask({ agent: LANES[lane].agent, model: LANES[lane].model, runner, maxUsd: opts.maxUsd, log });
      } catch (error) {
        log(`${lane}: hard task failed: ${error.message}`);
      }
      fs.writeFileSync(path.join(detailsDir, `${lane}.json`), JSON.stringify({ lane, agent: run.agent, model: run.model, baseHead: baseInfo.head, hard, results: run.results }, null, 1));
      const summary = summarizeLane({ lane, results: run.results, hard });
      lanes.push(summary);
      log(`${lane}: ${summary.passed}/${summary.tasks} passed`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const qwen = qwenAtFullLoad({
    detailsFile: path.join(root, 'docs/state/gpu-bakeoff-details-run4/qwen3.6-35b-a3b-nvfp4-bestof1.json'),
    hardTokens: 18445,
    hardPassed: true,
    passedLane: 7,
    hourlyUsd: 1.807,
    tokensPerSecond: 3718,
  });
  const markdown = renderComparison({ lanes, qwen, date: new Date().toISOString().slice(0, 10) });
  const out = path.join(root, 'docs/state/lane-comparison.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
