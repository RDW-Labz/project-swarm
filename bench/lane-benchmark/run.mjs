#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// node run.mjs prepare --src REPO [--ref main] --dest DIR [--validate]
// node run.mjs lane --lane NAME --repo DIR --runner PATH --out results-NAME.json [--max-usd 0.5]
// node run.mjs reverify --results a.json,b.json --repo DIR
// node run.mjs report --results a.json,b.json [--review] --out lane-benchmark.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASKS } from './tasks.mjs';
import { LANES, LANE_ORDER, buildBaseRepo, verifyOutputs, runLane, diffFor } from './lib.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const flag = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const log = message => process.stderr.write(`${message}\n`);

async function prepare() {
  const dest = path.resolve(flag('dest') ?? fail('--dest required')), src = path.resolve(flag('src') ?? fail('--src required'));
  const info = buildBaseRepo(src, flag('ref') ?? 'main', dest);
  fs.writeFileSync(path.join(path.dirname(dest), `${path.basename(dest)}.base.json`), JSON.stringify({ head: info.head, sourceRef: info.sourceRef }));
  log(`base repo ${dest} at ${info.head} from ${info.sourceRef}`);
  if (args.includes('--validate')) {
    for (const task of TASKS) {
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
  const result = runLane({ lane: name, repo, runner: path.resolve(flag('runner') ?? fail('--runner required')), maxUsd: Number(flag('max-usd') ?? 0.5), baseInfo, log });
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
const usd = value => (value === null ? 'n/a' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

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
  let reviewCost = null;
  if (args.includes('--review')) {
    reviewCost = await review(data, path.resolve(flag('repo') ?? fail('--repo required for --review')));
    files.forEach((file, index) => fs.writeFileSync(file, JSON.stringify(data[index], null, 1)));
  }
  fs.writeFileSync(flag('out') ?? 'lane-benchmark.md', renderReport(data, { reviewCost, meta: { base: data[0]?.sourceRef?.slice(0, 10) } }));
}

function fail(message) { throw new Error(message); }

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ({ prepare, lane, report, reverify })[command]?.().catch?.(error => { log(`error: ${error.message}`); process.exitCode = 1; }) ?? log('usage: run.mjs prepare|lane|report');
}
