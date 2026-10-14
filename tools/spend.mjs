// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { LANE_AGENTS } from './lanes.mjs';

export const LANE_DAILY_DEFAULTS = Object.freeze({ openrouter: Object.freeze({ dailyUsd: 5 }) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(key, reason, code = 'budget-invalid') {
  return Object.assign(new Error(`${code}: ${key} ${reason}`), { code });
}
function cap(value, key, tokens = false) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (tokens && !Number.isInteger(value)))) {
    throw invalid(key, `must be null or a positive ${tokens ? 'integer' : 'finite number'}`);
  }
  return value;
}
function fields(value, allowed, prefix) {
  if (!object(value)) throw invalid(prefix, 'must be an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${prefix}.${key}`, 'is unknown');
}
export function resolveBudget({ config = {}, manifest = {}, cli = {}, raises = [] } = {}) {
  const budget = { maxUsd: null, maxTokens: null, lanes: Object.fromEntries(LANE_AGENTS.map(agent => [agent, { dailyUsd: null, dailyTokens: null, ...LANE_DAILY_DEFAULTS[agent] }])) };
  if (config.spend !== undefined) fields(config.spend, ['lanes'], 'spend');
  if (manifest.budget !== undefined) fields(manifest.budget, ['maxUsd', 'maxTokens', 'lanes'], 'budget');
  for (const key of ['maxUsd', 'maxTokens']) {
    for (const source of [manifest.budget, cli]) if (source?.[key] !== undefined) budget[key] = cap(source[key], key, key === 'maxTokens');
  }
  for (const [source, lower] of [[config.spend?.lanes, false], [manifest.budget?.lanes, true]]) {
    if (source === undefined) continue;
    fields(source, LANE_AGENTS, 'lanes');
    for (const [agent, lane] of Object.entries(source)) {
      fields(lane, ['dailyUsd', 'dailyTokens'], `lane.${agent}`);
      for (const [key, value] of Object.entries(lane)) {
        cap(value, `lane.${agent}.${key}`, key === 'dailyTokens');
        const prior = budget.lanes[agent][key];
        budget.lanes[agent][key] = lower && prior !== null ? (value === null ? prior : Math.min(prior, value)) : value;
      }
    }
  }
  if (!Array.isArray(raises)) throw invalid('raises', 'must be an array');
  for (const raise of raises) {
    const { key, value } = raise ?? {};
    let target = budget, field = key;
    if (!['maxUsd', 'maxTokens'].includes(key)) {
      const match = /^lane\.([^.]+)\.(dailyUsd|dailyTokens)$/.exec(key);
      if (!match || !LANE_AGENTS.includes(match[1])) throw invalid(String(key), 'is unknown');
      target = budget.lanes[match[1]];
      field = match[2];
    }
    cap(value, key, /Tokens$/.test(field));
    if (value === null || (target[field] !== null && value <= target[field])) throw invalid(key, 'must be greater than the effective cap', 'budget-raise-invalid');
    target[field] = value;
  }
  return budget;
}

const spendNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function jobSpend(record) {
  return { usd: spendNumber(record?.costUsd), tokens: spendNumber(record?.usage?.total_tokens) };
}
export function runTotals(state) {
  const totals = { usd: 0, tokens: 0, unknownUsd: [] };
  for (const record of state.jobs ?? []) {
    const { usd, tokens } = jobSpend(record);
    totals.usd += usd ?? 0;
    totals.tokens += tokens ?? 0;
    if (tokens !== null && usd === null) totals.unknownUsd.push(record.id);
  }
  return totals;
}
export function laneDailyTotals(states, { now = () => new Date(), excludeRunId } = {}) {
  const midnight = new Date(now());
  midnight.setUTCHours(0, 0, 0, 0);
  const totals = {};
  for (const state of states) {
    if (excludeRunId !== undefined && (state.id ?? state.runId) === excludeRunId) continue;
    for (const record of state.jobs ?? []) {
      if (!record.agent || !(Date.parse(record.finishedAt) >= midnight.getTime())) continue;
      const { usd, tokens } = jobSpend(record);
      const lane = totals[record.agent] ??= { usd: 0, tokens: 0 };
      lane.usd += usd ?? 0;
      lane.tokens += tokens ?? 0;
    }
  }
  return totals;
}
export function capDecision({ budget, run, laneToday, agent }) {
  for (const [reason, target, limits, prefix, keys] of [
    ['run-cap', run, budget, 'run', ['maxUsd', 'maxTokens']],
    ['lane-cap', laneToday?.[agent] ?? {}, budget.lanes?.[agent] ?? {}, `lane ${agent}`, ['dailyUsd', 'dailyTokens']],
  ]) {
    for (const field of keys) {
      const usd = field.endsWith('Usd'), spent = target?.[usd ? 'usd' : 'tokens'] ?? 0, limit = limits[field];
      if (limit === null || limit === undefined || spent < limit) continue;
      const key = reason === 'run-cap' ? field : `lane.${agent}.${field}`;
      const amount = value => usd ? `$${value.toFixed(2)}` : String(value);
      return { reason, key, spent, cap: limit, message: `spend-cap: ${prefix} spent ${amount(spent)}${reason === 'lane-cap' ? ' today' : ''} >= ${field} ${amount(limit)}; resume with --raise ${key}=<N> --reason TEXT` };
    }
  }
  return null;
}

const clean = value => String(value ?? '').replace(/[|\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const subscription = new Set(['codex', 'cursor', 'claude', 'hermes', 'qwen']);
export function ledgerRows(state, { phase = '-' } = {}) {
  const rows = [];
  for (const record of state.jobs ?? []) {
    const attempts = record.attempts ?? [];
    attempts.forEach((attempt, index) => {
      const last = index === attempts.length - 1;
      const status = attempt.status ?? record.status;
      const error = attempt.error ?? record.error ?? '';
      const cost = last ? spendNumber(record.costUsd) : null;
      const tokens = last ? spendNumber(record.usage?.total_tokens) : null;
      const date = new Date(attempt.finishedAt);
      rows.push({
        key: `${state.id ?? state.runId}/${record.id}#${index + 1}`,
        date: Number.isNaN(date.getTime()) ? '-' : date.toISOString().slice(0, 10),
        phase: clean(phase), task: clean(`${record.id}: ${record.report?.summary || String(record.prompt ?? '').split(/\r?\n/)[0]}`).slice(0, 100),
        worker: clean(record.agent), model: clean(attempt.model ?? record.model ?? '-'),
        result: status === 'complete' ? 'pass' : `${clean(status)}: ${clean(error).slice(0, 60)}`,
        tokens: tokens === null ? '-' : Math.trunc(tokens).toLocaleString('en-US'),
        cost: cost !== null ? `$${cost.toFixed(2)}` : subscription.has(record.agent) ? 'subscription' : 'unknown',
      });
    });
  }
  return rows;
}
const ledgerHeader = '| date | phase | task | worker | model | result | tokens | rough cost |';
const divider = '| --- | --- | --- | --- | --- | --- | --- | --- |';
const rowText = row => `| ${['date', 'phase', 'task', 'worker', 'model', 'result', 'tokens', 'cost'].map(key => clean(row[key])).join(' | ')} |`;
export function mergeLedger(text, rows) {
  let lines = String(text ?? '').split('\n');
  let start = lines.findIndex(line => line.trim() === ledgerHeader);
  if (start < 0) {
    lines = ['# Usage ledger', '', 'Recorded worker attempts and reported usage.', '', ledgerHeader, divider, '', ...((text ?? '').trim() ? [String(text).trim()] : [])];
    start = 4;
  }
  let end = start + 2;
  while (lines[end]?.trim().startsWith('|')) end++;
  lines.splice(end, 0, ...rows.map(rowText));
  end += rows.length;
  const groups = new Map();
  for (const line of lines.slice(start + 2, end)) {
    const cells = line.trim().split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length !== 8) continue;
    const [date, , , worker, , result, tokens, cost] = cells;
    const key = `${date}\0${worker}`;
    const group = groups.get(key) ?? { date, worker, calls: 0, pass: 0, tokens: 0, usd: 0, paid: false, subscription: false };
    group.calls++;
    if (result.startsWith('pass')) group.pass++;
    if (/^[\d,]+$/.test(tokens)) group.tokens += Number(tokens.replaceAll(',', ''));
    if (/^\$\d+(\.\d+)?$/.test(cost)) { group.paid = true; group.usd += Number(cost.slice(1)); }
    if (cost === 'subscription') group.subscription = true;
    groups.set(key, group);
  }
  const summary = ['## Daily summary', '', '| date | tier | calls | pass | fail/blocked | tokens | rough cost |', '| --- | --- | --- | --- | --- | --- | --- |', ...[...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, g]) => `| ${g.date} | ${g.worker} | ${g.calls} | ${g.pass} | ${g.calls - g.pass} | ${g.tokens.toLocaleString('en-US')} | ${g.paid ? `$${g.usd.toFixed(2)}` : g.subscription ? 'subscription' : 'unknown'} |`)];
  const summaryStart = lines.findIndex(line => line.trim() === '## Daily summary');
  if (summaryStart < 0) lines.push('', ...summary, '');
  else {
    let summaryEnd = summaryStart + 1;
    while (summaryEnd < lines.length && !lines[summaryEnd].trim()) summaryEnd++;
    if (lines[summaryEnd]?.trim().startsWith('|')) while (lines[summaryEnd]?.trim().startsWith('|')) summaryEnd++;
    lines.splice(summaryStart, summaryEnd - summaryStart, ...summary);
  }
  return lines.join('\n');
}

export function validateIdleItems(items) {
  const fail = reason => { throw invalid('items', reason, 'idle-invalid'); };
  if (!Array.isArray(items)) fail('must be an array');
  for (const item of items) {
    if (!object(item) || typeof item.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(item.name)) fail('name is invalid');
    if (!Array.isArray(item.argv) || !item.argv.length || item.argv.some(arg => typeof arg !== 'string') || !item.argv[0]) fail('argv must be a non-empty string array');
    if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000 || item.timeoutMs > 3600000)) fail('timeoutMs must be an integer 1000–3600000');
  }
  return items;
}
const execFileAsync = promisify(execFile);
async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}
function command(argv, cwd, timeout, spawnImpl) {
  return new Promise(resolve => {
    let child, timer, timedOut = false, settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    env.SWARM_IDLE = '1';
    try {
      child = spawnImpl(argv[0], argv.slice(1), { cwd, env, stdio: 'ignore' });
      child.once('error', error => finish({ exitCode: null, error: error.message, timedOut }));
      child.once('close', code => finish({ exitCode: code, error: timedOut ? 'idle-timeout' : code === 0 ? null : `idle-exit: ${code}`, timedOut }));
      timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(0, timeout));
    } catch (error) { finish({ exitCode: null, error: error.message, timedOut }); }
  });
}
export async function runIdleMenu(root, { runId, items, baseCommit, until = null, now = Date.now, spawnImpl = spawn, gitImpl = git }) {
  validateIdleItems(items);
  // Run ids are path components and branch components, never arbitrary paths or refs.
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId)) throw invalid('runId', 'is invalid', 'idle-invalid');
  const results = [];
  for (const item of items) {
    if (until !== null && now() >= until) break;
    const branch = `idle/${runId}/${item.name}`;
    const dir = path.join(root, '.swarm', 'idle', runId, item.name);
    const result = { name: item.name, status: 'failed', branch, exitCode: null, commit: null, error: null };
    results.push(result);
    let added = false;
    try {
      let exists = false;
      try { await gitImpl(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); exists = true; }
      catch (error) { if (error.code !== 1) throw error; }
      if (exists) { result.status = 'skipped'; result.error = 'idle-branch-exists'; continue; }
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await gitImpl(root, ['worktree', 'add', '-b', branch, dir, baseCommit]);
      added = true;
      const timeout = Math.min(item.timeoutMs ?? 600000, until === null ? Infinity : until - now());
      const outcome = timeout <= 0 ? { timedOut: true, exitCode: null, error: 'idle-timeout' } : await command(item.argv, dir, timeout, spawnImpl);
      result.exitCode = outcome.exitCode;
      result.error = outcome.error;
      if (outcome.timedOut) result.status = 'timeout';
      else if (outcome.exitCode !== 0) result.status = 'failed';
      else if (String(await gitImpl(dir, ['status', '--porcelain'])).trim()) {
        await gitImpl(dir, ['add', '-A']);
        await gitImpl(dir, ['-c', 'user.name=swarm-idle', '-c', 'user.email=swarm-idle@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', `idle: ${item.name}`]);
        result.commit = await gitImpl(dir, ['rev-parse', 'HEAD']);
        result.status = 'committed';
      } else result.status = 'unchanged';
    } catch (error) { result.status = 'failed'; result.error = error.message; }
    finally {
      if (added) try { await gitImpl(root, ['worktree', 'remove', '--force', dir]); }
      catch (error) { result.status = 'failed'; result.error = error.message; }
    }
  }
  const target = path.join(root, '.swarm', 'runs', runId, 'idle.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  let history = [];
  try { history = JSON.parse(await fs.readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  history.push({ at: new Date(now()).toISOString(), results });
  await fs.writeFile(target, `${JSON.stringify(history, null, 2)}\n`);
  return results;
}
