#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// node run.mjs prepare --src REPO [--ref main] --dest DIR [--validate]
// node run.mjs lane --lane NAME --repo DIR --runner PATH --out results-NAME.json [--max-usd 0.5]
// node run.mjs reverify --results a.json,b.json --repo DIR
// node run.mjs report --results a.json,b.json [--review] --out lane-benchmark.md
// node run.mjs endpoint --set replay --base-url URL --model NAME --key-env VAR --slots N --out results.json
// node run.mjs toolcalls --base-url URL --model NAME --key-env VAR
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASKS } from './tasks.mjs';
import { LANES, LANE_ORDER, buildBaseRepo, verifyOutputs, runLane, diffFor } from './lib.mjs';
import { getReplayTasks } from './tasks-replay.mjs';
import { chatCompletion, runEndpointLane } from './endpoint.mjs';
import { runToolcallChecks, formatToolcallReport } from './toolcalls.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const flag = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const log = message => process.stderr.write(`${message}\n`);
const benchDir = path.dirname(fileURLToPath(import.meta.url));

function activeTasks() {
  const set = flag('set') ?? 'default';
  if (set === 'replay') {
    const tasks = getReplayTasks();
    if (!tasks.length) fail('replay set empty: run node bench/lane-benchmark/replay-select.mjs first');
    return tasks;
  }
  return TASKS;
}

function gitShow(repo, commit, file) {
  const r = spawnSync('git', ['-C', repo, 'show', `${commit}:${file}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

async function prepare() {
  const src = path.resolve(flag('src') ?? '.');
  const tasks = activeTasks();
  if ((flag('set') ?? 'default') === 'replay') {
    log(`replay set: ${tasks.length} tasks (per-task bases extracted at verify/run time)`);
    return;
  }
  const dest = path.resolve(flag('dest') ?? fail('--dest required'));
  const info = buildBaseRepo(src, flag('ref') ?? 'main', dest);
  fs.writeFileSync(path.join(path.dirname(dest), `${path.basename(dest)}.base.json`), JSON.stringify({ head: info.head, sourceRef: info.sourceRef }));
  log(`base repo ${dest} at ${info.head} from ${info.sourceRef}`);
  if (args.includes('--validate')) {
    for (const task of tasks) {
      const empty = verifyOutputs(dest, task, Object.fromEntries(task.outputs.map(file => [file, fs.existsSync(path.join(dest, file)) ? fs.readFileSync(path.join(dest, file), 'utf8') : ''])));
      const reference = task.outputs.every(file => file in info.originals) && task.verify.structural === undefined && !task.verify.mutants && task.outputs.length === 1
        ? verifyOutputs(dest, task, Object.fromEntries(task.outputs.map(file => [file, info.originals[file]]))) : null;
      log(`${task.id}: base ${empty.pass ? 'PASSES (bad)' : 'fails (good)'}${reference ? `; original ${reference.pass ? 'passes (good)' : 'FAILS (bad)'}` : ''}`);
      if (empty.pass || (reference && !reference.pass)) process.exitCode = 1;
    }
  }
}

async function lane() {
  const name = flag('lane') ?? fail('--lane required');
  const repo = path.resolve(flag('repo') ?? fail('--repo required'));
  const baseFile = path.join(path.dirname(repo), `${path.basename(repo)}.base.json`);
  const baseInfo = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, 'utf8')) : null;
  const tasks = activeTasks();
  const result = runLane({ lane: name, repo, runner: path.resolve(flag('runner') ?? fail('--runner required')), maxUsd: Number(flag('max-usd') ?? 0.5), baseInfo, log, tasks });
  fs.writeFileSync(flag('out') ?? `results-${name}.json`, JSON.stringify(result, null, 1));
  const passed = result.results.filter(item => item.pass).length;
  log(`${name}: ${passed}/${result.results.length} passed in ${(result.wallMs / 1000).toFixed(0)}s`);
}

async function review(data, repo) {
  const { executeApi } = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/api-adapters.mjs')).href);
  let cost = 0;
  for (const laneResult of data) {
    for (const item of laneResult.results) {
      if (Number.isFinite(item.reviewScore)) continue;
      const task = TASKS.find(entry => entry.id === item.taskId);
      const diff = diffFor(repo, task, item.outputs);
      const job = {
        id: `review-${laneResult.lane}-${item.taskId}`.slice(0, 80), agent: 'anthropic', model: 'claude-haiku-5-5', tier: 'cheap', sensitive: true, outputs: [], context: [], maxOutputTokens: 4096, timeoutMs: 120000,
        prompt: `You are reviewing one result of a coding benchmark. Be strict and specific.\nTask given to the worker:\n${task.prompt}\n\nAutomatic check: ${item.pass ? 'PASSED' : 'FAILED'} (${item.detail}).\n\nThe worker's change as a unified diff against the base:\n${diff || '[no output]'}\n\nThe base versions of the files the worker was given are attached, so you can check the diff against them. Rate the quality from 1 to 5: 5 = merge as is; 4 = good with minor nits; 3 = works but has notable problems; 2 = poor or mostly wrong; 1 = wrong, empty or harmful. Put exactly this in the summary field: SCORE=<n> <one short sentence>. Return files: [] and edits: [].`,
      };
      const context = task.context.filter(file => file !== 'tools/swarm.mjs').map(file => ({ path: file, content: fs.readFileSync(path.join(repo, file), 'utf8') }));
      const reply = await executeApi(job, context, { env: process.env });
      const match = /SCORE=([1-5])\s*(.*)/.exec(reply.response ?? '');
      item.reviewScore = match ? Number(match[1]) : null;
      item.reviewNote = match ? match[2].slice(0, 200) : `review failed: ${reply.error ?? 'no score'}`;
      cost += reply.costUsd ?? 0;
      log(`reviewed ${laneResult.lane}/${item.taskId}: ${item.reviewScore}`);
    }
  }
  return cost;
}

const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
const p90 = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1] : null; };
const usd = value => (value === null ? 'n/a' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

function summarizeFailureReasons(results) {
  const counts = new Map();
  for (const r of results) {
    if (r.pass) continue;
    const key = r.reason ?? r.detail?.slice(0, 80) ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return 'no failures';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} (${n})`)
    .join('; ');
}

export function renderReplayReport(entries) {
  const tableFor = data => {
    const results = data.results ?? [];
    const passed = results.filter(r => r.pass).length;
    const walls = results.map(r => r.wallSec ?? (r.durationMs ?? NaN) / 1000);
    const tps = results.map(r => r.completionTokensPerSec).filter(Number.isFinite);
    const label = data.model ?? data.lane ?? 'model';
    return {
      label,
      row: `| ${label} | ${passed}/${results.length} | ${((passed / Math.max(1, results.length)) * 100).toFixed(0)}% | ${median(walls)?.toFixed(1) ?? 'n/a'} | ${p90(walls)?.toFixed(1) ?? 'n/a'} | ${median(tps)?.toFixed(1) ?? 'n/a'} | ${data.slots ?? 'n/a'} |`,
      results,
      failureSummary: summarizeFailureReasons(results),
    };
  };
  const tables = entries.map(tableFor);
  const perTaskSections = tables.map(t => {
    const lines = t.results.map(r => `- ${r.taskId}: ${r.reason ?? (r.pass ? 'passed' : r.detail?.slice(0, 120) ?? 'failed')}`);
    return `### ${t.label}\n\nFailure reasons: ${t.failureSummary}\n\n${lines.join('\n')}`;
  });
  return `# Replay benchmark

| Model | Pass | Rate | Median s | p90 s | tok/s | Slots |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${tables.map(t => t.row).join('\n')}

## Per task

${perTaskSections.join('\n\n')}
`;
}

function isReplayResult(data) {
  return data.set === 'replay' || data.lane === 'endpoint' || (data.results?.[0] && 'wallSec' in data.results[0] && !('agent' in data.results[0]));
}

export function renderReport(data, { reviewCost = null, meta = {} } = {}) {
  const lanes = LANE_ORDER.filter(name => data.some(item => item.lane === name));
  const by = name => data.find(item => item.lane === name);
  const rows = lanes.map(name => {
    const entry = by(name), spec = LANES[name], results = entry.results;
    const costs = results.map(item => item.costUsd);
    const cost = spec.paid ? usd(costs.reduce((sum, value) => sum + (value ?? 0), 0)) : `subscription (${results.reduce((sum, item) => sum + (item.tokens ?? 0), 0).toLocaleString('en-US')} tokens)`;
    const scores = results.map(item => item.reviewScore).filter(Number.isFinite);
    const quality = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 'n/a';
    const sec = median(results.map(item => (item.durationMs ?? NaN) / 1000));
    return `| ${name} | ${spec.agent} / ${spec.model} | ${results.filter(item => item.pass).length}/${results.length} | ${cost} | ${sec === null ? 'n/a' : `${sec.toFixed(0)} s`} | ${quality} |`;
  });
  const types = [...new Set(TASKS.map(task => task.type))];
  const matrix = TASKS.map(task => `| ${task.id} | ${task.type} | ${lanes.map(name => { const item = by(name).results.find(entry => entry.taskId === task.id); return item ? `${item.pass ? '✓' : '✗'}${item.reviewScore ? ` ${item.reviewScore}` : ''}` : '-'; }).join(' | ')} |`);
  const route = types.map(type => {
    const tasks = TASKS.filter(task => task.type === type);
    const good = lanes.filter(name => tasks.every(task => { const item = by(name).results.find(entry => entry.taskId === task.id); return item?.pass && (item.reviewScore ?? 5) >= 4; }));
    return `| ${type} | ${good.length ? good.join(' → ') : 'none passed both with quality 4 or more'} |`;
  });
  return `# Lane benchmark

Ten tasks from this repo, two of each kind, run on every lane and checked by real tests plus a review.${meta.base ? ` Base: \`${meta.base}\`.` : ''} Quality is a Claude Haiku review from 1 to 5 of the diff (a cheaper reviewer keeps the run inside its budget; it is told the automatic result).${reviewCost !== null ? ` Review cost: ${usd(reviewCost)}.` : ''}

## Per lane

| Lane | Agent / model | Passed | Cost | Median time | Quality |
| --- | --- | ---: | --- | ---: | ---: |
${rows.join('\n')}

## Per task (✓ passed, ✗ failed, then the quality score)

| Task | Kind | ${lanes.join(' | ')} |
| --- | --- | ${lanes.map(() => '---').join(' | ')} |
${matrix.join('\n')}

## Lanes that passed both tasks of a kind with quality 4 or more (cheapest first)

| Kind | Lanes |
| --- | --- |
${route.join('\n')}

## Notes

${data.map(item => `- ${item.lane}: ${item.results.filter(entry => !entry.pass).map(entry => `${entry.taskId} (${entry.detail.slice(0, 90)})`).join('; ') || 'no failures'}`).join('\n')}
`;
}

// Re-checks saved outputs with the current task definitions (after a task's check was fixed) and
// clears the reviews so they are redone.
async function reverify() {
  const repo = path.resolve(flag('repo') ?? fail('--repo required'));
  for (const file of (flag('results') ?? fail('--results required')).split(',')) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of data.results) {
      const task = TASKS.find(entry => entry.id === item.taskId);
      if (item.status !== 'complete' && Object.keys(item.outputs).length < task.outputs.length) continue;
      const verified = verifyOutputs(repo, task, item.outputs);
      if (verified.pass !== item.pass) log(`${data.lane}/${item.taskId}: ${item.pass} -> ${verified.pass}`);
      Object.assign(item, { pass: verified.pass, detail: verified.detail, score: verified.score });
      delete item.reviewScore; delete item.reviewNote;
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
  }
}

async function report() {
  const files = (flag('results') ?? fail('--results required')).split(',');
  const data = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  if (data.every(isReplayResult)) {
    const labeled = data.map((item, i) => ({ ...item, model: item.model ?? path.basename(files[i], '.json') }));
    fs.writeFileSync(flag('out') ?? 'replay-benchmark.md', renderReplayReport(labeled));
    return;
  }
  let reviewCost = null;
  if (args.includes('--review')) {
    reviewCost = await review(data, path.resolve(flag('repo') ?? fail('--repo required for --review')));
    files.forEach((file, index) => fs.writeFileSync(file, JSON.stringify(data[index], null, 1)));
  }
  fs.writeFileSync(flag('out') ?? 'lane-benchmark.md', renderReport(data, { reviewCost, meta: { base: data[0]?.sourceRef?.slice(0, 10) } }));
}

function loadApiKey() {
  const keyEnv = flag('key-env') ?? fail('--key-env required');
  const apiKey = process.env[keyEnv];
  if (!apiKey) fail(`environment variable ${keyEnv} is not set`);
  return { keyEnv, apiKey };
}

export function scrubSecret(text, secret) {
  if (!secret || !text) return text;
  return String(text).split(secret).join('[REDACTED]');
}

async function endpoint() {
  const { apiKey } = loadApiKey();
  const baseUrl = flag('base-url') ?? fail('--base-url required');
  const model = flag('model') ?? fail('--model required');
  const slots = Number(flag('slots') ?? 4);
  const maxTokens = Number(flag('max-tokens') ?? 16000);
  const promptTokens = Number(flag('prompt-tokens') ?? 24000);
  const thinking = flag('thinking') ?? 'auto';
  if (!['auto', 'off'].includes(thinking)) fail('--thinking must be auto or off');
  const srcRepo = path.resolve(flag('src') ?? path.join(benchDir, '../..'));
  const tasks = activeTasks();
  const verify = (baseDir, task, outputs) => verifyOutputs(baseDir, task, outputs, { readAtMerge: (c, f) => gitShow(srcRepo, c, f) });
  const result = await runEndpointLane({
    tasks,
    slots,
    srcRepo,
    verifyOutputs: verify,
    readContextAtBase: (commit, file) => gitShow(srcRepo, commit, file),
    promptTokenBudget: promptTokens,
    api: prompt => chatCompletion({ baseUrl, model, apiKey, prompt, maxTokens, thinking }),
    log,
  });
  const out = {
    ...result,
    model,
    baseUrl,
    maxTokens,
    promptTokens,
    thinking,
    wallMs: result.results.reduce((s, r) => s + (r.wallSec ?? 0) * 1000, 0),
  };
  const outPath = flag('out') ?? 'results-endpoint.json';
  const serialized = JSON.stringify(out, null, 1);
  if (serialized.includes(apiKey)) fail('api key leaked into results');
  fs.writeFileSync(outPath, serialized);
  const passed = result.results.filter(r => r.pass).length;
  log(`endpoint/${model}: ${passed}/${result.results.length} passed`);
}

async function toolcalls() {
  const { apiKey } = loadApiKey();
  const baseUrl = flag('base-url') ?? fail('--base-url required');
  const model = flag('model') ?? fail('--model required');
  const lines = await runToolcallChecks({ baseUrl, model, apiKey });
  const reportText = formatToolcallReport(lines);
  if (reportText.includes(apiKey)) fail('api key leaked into toolcalls output');
  process.stdout.write(`${reportText}\n`);
}

function fail(message) { throw new Error(message); }

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ({ prepare, lane, report, reverify, endpoint, toolcalls })[command]?.().catch?.(error => {
    const keyEnv = flag('key-env');
    const secret = keyEnv ? process.env[keyEnv] : '';
    log(`error: ${scrubSecret(error.message, secret)}`);
    process.exitCode = 1;
  }) ?? log('usage: run.mjs prepare|lane|endpoint|toolcalls|report|reverify');
}
