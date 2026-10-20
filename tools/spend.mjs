// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { defaultMaxOutputTokens } from './openrouter.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { LANE_AGENTS } from './lanes.mjs';
import { validateRentedConfig } from './rented.mjs';

export const LANE_DAILY_DEFAULTS = Object.freeze({ openrouter: Object.freeze({ dailyUsd: 5 }), anthropic: Object.freeze({ dailyUsd: 20 }) });
export const PAID_LANES = Object.freeze(['openrouter', 'openai', 'gemini', 'lambda', 'anthropic', 'rented']);
// A rented server costs by the hour (see tools/rented.mjs), not by the request, so a rented job reserves nothing of its own.
export const LANE_RESERVE_DEFAULTS = Object.freeze({ openrouter: 0.5, openai: 0.5, gemini: 0.5, lambda: 0.5, anthropic: 0.5, rented: 0 });
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
  const budget = { maxUsd: null, maxTokens: null, lanes: Object.fromEntries(LANE_AGENTS.map(agent => [agent, { dailyUsd: null, dailyTokens: null, ...LANE_DAILY_DEFAULTS[agent], ...(PAID_LANES.includes(agent) ? { reserveUsd: LANE_RESERVE_DEFAULTS[agent] } : {}) }])) };
  // A rented server's day cap defaults to one run's maximum rental (hourlyUsd x maxHoursPerRun) unless the config sets it.
  const rentedDefault = config.rentedGpu ? validateRentedConfig(config.rentedGpu).config?.dailyUsd : undefined;
  if (rentedDefault > 0) budget.lanes.rented.dailyUsd = rentedDefault;
  if (config.spend !== undefined) fields(config.spend, ['lanes', 'rates', 'projectMaxUsd'], 'spend');
  if (config.spend?.projectMaxUsd !== undefined) cap(config.spend.projectMaxUsd, 'spend.projectMaxUsd');
  validateRates(config.spend?.rates);
  if (manifest.budget !== undefined) fields(manifest.budget, ['maxUsd', 'maxTokens', 'lanes'], 'budget');
  for (const key of ['maxUsd', 'maxTokens']) {
    for (const source of [manifest.budget, cli]) if (source?.[key] !== undefined) budget[key] = cap(source[key], key, key === 'maxTokens');
  }
  for (const [source, lower] of [[config.spend?.lanes, false], [manifest.budget?.lanes, true]]) {
    if (source === undefined) continue;
    fields(source, LANE_AGENTS, 'lanes');
    for (const [agent, lane] of Object.entries(source)) {
      fields(lane, lower ? ['dailyUsd', 'dailyTokens'] : ['dailyUsd', 'dailyTokens', 'reserveUsd'], `lane.${agent}`);
      for (const [key, value] of Object.entries(lane)) {
        if (key === 'reserveUsd' && value === null) throw invalid(`lane.${agent}.${key}`, 'must be a positive finite number');
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

// Rates may be zero (public pricing sometimes includes free input), unlike caps.
export function validateRates(rates) {
  if (rates === undefined) return;
  if (!object(rates)) throw invalid('spend.rates', 'must be an object');
  for (const [model, rate] of Object.entries(rates)) {
    const prefix = `spend.rates.${model}`;
    fields(rate, ['inUsdPerToken', 'outUsdPerToken', 'creditUsd'], prefix);
    for (const key of ['inUsdPerToken', 'outUsdPerToken', ...(Object.hasOwn(rate, 'creditUsd') ? ['creditUsd'] : [])]) {
      if (typeof rate[key] !== 'number' || !Number.isFinite(rate[key]) || rate[key] < 0) throw invalid(`${prefix}.${key}`, 'must be a nonnegative finite number');
    }
  }
}

export function spendDir(env = process.env, home = os.homedir()) {
  return env.SWARM_SPEND_DIR || path.join(home, '.project-swarm', 'spend');
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
const utcDay = now => new Date(now()).toISOString().slice(0, 10);
const storeError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

export async function withSpendStore(fn, { dir = spendDir(), now = Date.now, isAlive = pidAlive, timeoutMs = 10000 } = {}) {
  const lock = path.join(dir, 'daily.lock'), file = path.join(dir, 'daily.json');
  const host = os.hostname(), started = Date.now();
  await fs.mkdir(dir, { recursive: true });
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lock);
        let owner;
        try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
        catch (error) {
          if (error instanceof SyntaxError) owner = {}; // An invalid owner is held until timeout.
          else if (error.code !== 'ENOENT') throw error;
        }
        if ((owner?.host === host && Number.isInteger(owner.pid) && owner.pid > 0 && !isAlive(owner.pid)) || (!owner && Date.now() - stat.mtimeMs > 60000)) {
          // Claim stale cleanup before removing it, so concurrent cleaners cannot
          // remove the replacement lock acquired by another caller.
          const cleanup = path.join(lock, 'cleanup');
          try { await fs.mkdir(cleanup); } catch (error) {
            if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
            if (Date.now() - started >= timeoutMs) throw storeError('spend-store-locked', 'timed out waiting for stale lock cleanup');
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
          }
          const current = await fs.stat(lock);
          if (current.ino !== stat.ino || current.dev !== stat.dev) {
            await fs.rm(cleanup, { recursive: true, force: true });
            continue;
          }
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (Date.now() - started >= timeoutMs) throw storeError('spend-store-locked', 'timed out waiting for daily.lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let temp;
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host, at: new Date(now()).toISOString() }));
    let store;
    try { store = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') store = { version: 1, entries: {} };
      else throw storeError('spend-store-invalid', 'daily.json could not be read as JSON');
    }
    if (!object(store) || store.version !== 1 || !object(store.entries) || Object.values(store.entries).some(entry => !object(entry)
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) || !Number.isFinite(Date.parse(entry.day))
      || !LANE_AGENTS.includes(entry.lane) || !['reservation', 'actual', 'estimated', 'reserved-as-cost'].includes(entry.kind)
      || spendNumber(entry.usd) === null || spendNumber(entry.tokens) === null)) {
      throw storeError('spend-store-invalid', 'daily.json has an invalid shape');
    }
    const before = JSON.stringify(store);
    const oldest = Date.parse(utcDay(now)) - 31 * 86400000, alive = new Map();
    const ownerAlive = pid => { if (!alive.has(pid)) alive.set(pid, isAlive(pid)); return alive.get(pid); };
    for (const [key, entry] of Object.entries(store.entries)) {
      if (Date.parse(entry.day) < oldest) delete store.entries[key];
      else if (entry.kind === 'reservation' && entry.host === host && !ownerAlive(entry.pid)) {
        entry.kind = 'reserved-as-cost'; entry.flagged = true;
      }
    }
    const result = await fn(store);
    if (JSON.stringify(store) !== before) {
      temp = path.join(dir, `.daily-${process.pid}-${crypto.randomUUID()}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(store)}\n`); }
      finally { await handle.close(); }
      await fs.rename(temp, file);
      temp = null;
    }
    return result;
  } finally {
    if (temp) await fs.rm(temp, { force: true });
    await fs.rm(lock, { recursive: true, force: true });
  }
}

export function laneDayTotals(store, { day = utcDay(Date.now) } = {}) {
  const totals = {};
  for (const entry of Object.values(store.entries)) {
    if (entry.day !== day) continue;
    const lane = totals[entry.lane] ??= { usd: 0, tokens: 0 };
    lane.usd += entry.usd; lane.tokens += entry.tokens;
  }
  return totals;
}

// In-flight work on codex, cursor, hermes, and qwen does not reserve against spend caps; only metered lanes reserve spend while a job runs. Claude still reserves a list-price
// estimate below (the most a finished job of this lane and model cost in the run with five or more samples, else a conservative default per model) so parallel claude jobs count against the cap.
export const FLAT_RATE_RESERVE_DEFAULTS = Object.freeze({ claude: Object.freeze({ opus: 1.0, sonnet: 0.5, haiku: 0.2, other: 0.5 }), codex: 0, cursor: 0, hermes: 0, qwen: 0 });
export function flatRateReserve({ lane, model, history = [] }) {
  if (lane === 'codex' || lane === 'cursor' || lane === 'hermes' || lane === 'qwen') return 0;
  const costs = history.filter(x => typeof x === 'number' && Number.isFinite(x) && x > 0);
  // Five or more finished jobs of this lane and model: the most any of them cost (never less than something already seen). Fewer: a conservative default.
  if (costs.length >= 5) return Math.max(...costs);
  const d = FLAT_RATE_RESERVE_DEFAULTS[lane];
  if (d === undefined) return 0;
  if (typeof d === 'number') return d;
  const m = String(model ?? '').toLowerCase();
  return m.includes('opus') ? d.opus : m.includes('sonnet') ? d.sonnet : m.includes('haiku') ? d.haiku : d.other;
}

export function estimateReservation({ job, lane, model, inputChars, rates, laneDefaults = LANE_RESERVE_DEFAULTS, flatHistory }) {
  const maxOut = job.maxOutputTokens ?? (lane === 'openrouter' ? defaultMaxOutputTokens(model) : 8192);
  const tokens = maxOut + Math.ceil(inputChars / 4);
  if (!PAID_LANES.includes(lane)) return { usd: flatRateReserve({ lane, model, history: flatHistory }), tokens, source: 'unpaid' };
  let usd, source;
  if (job.maxCredits != null && rates?.creditUsd != null) { usd = job.maxCredits * rates.creditUsd; source = 'max-credits'; }
  else if (rates?.inUsdPerToken != null && rates?.outUsdPerToken != null) { usd = inputChars * rates.inUsdPerToken + maxOut * rates.outUsdPerToken; source = 'rate'; }
  else { usd = laneDefaults[lane]?.reserveUsd ?? laneDefaults[lane] ?? LANE_RESERVE_DEFAULTS[lane]; source = 'lane-default'; }
  // Free/empty pricing cannot make an unreported paid attempt disappear.
  if (!(usd > 0)) { usd = laneDefaults[lane]?.reserveUsd ?? laneDefaults[lane] ?? LANE_RESERVE_DEFAULTS[lane]; source = 'lane-default'; }
  return { usd, tokens, source };
}

export async function reserveSpend({ dir, key, lane, runId, root, jobId, usd, tokens, budget, runTotals, now = Date.now, isAlive }) {
  return withSpendStore(store => {
    const day = utcDay(now);
    const decision = capDecision({ budget, run: runTotals, laneToday: laneDayTotals(store, { day }), agent: lane, add: { usd, tokens } });
    if (decision) return { decision };
    store.entries[key] = { day, lane, runId, root, jobId, usd, tokens, kind: 'reservation', pid: process.pid, host: os.hostname(), at: new Date(now()).toISOString(), flagged: false };
    return { decision: null };
  }, { dir, now, isAlive });
}
export async function settleSpend({ dir, key, usd, tokens, kind, flagged, now = Date.now }) {
  return withSpendStore(store => {
    if (store.entries[key]) Object.assign(store.entries[key], { usd, tokens, kind, flagged });
  }, { dir, now });
}
// One running entry for something that costs by the hour: created on first call, raised afterwards, never lowered, no cap check
// (the rental guard decides before each launch; the money is already being spent).
export async function accrueSpend({ dir, key, lane, runId, root, jobId, usd, now = Date.now, isAlive }) {
  return withSpendStore(store => {
    const current = store.entries[key];
    if (current) { if (usd > (current.usd ?? 0)) current.usd = usd; return; }
    store.entries[key] = { day: utcDay(now), lane, runId, root, jobId, usd, tokens: 0, kind: 'estimated', pid: process.pid, host: os.hostname(), at: new Date(now()).toISOString(), flagged: false };
  }, { dir, now, isAlive });
}
export async function releaseSpend({ dir, key }) {
  return withSpendStore(store => { delete store.entries[key]; }, { dir });
}
export function finalCost({ lane, record, reservation, rates }) {
  const job = object(record) ? record : {};
  if (typeof job.costUsd === 'number') return { usd: job.costUsd, kind: 'actual', flagged: false, costSource: job.costSource ?? 'reported' };
  if (!PAID_LANES.includes(lane)) return { usd: 0, kind: 'actual', flagged: false, costSource: null };
  const input = job.usage?.input_tokens ?? job.usage?.prompt_tokens;
  const output = job.usage?.output_tokens ?? job.usage?.completion_tokens;
  if ((typeof input === 'number' || typeof output === 'number') && rates?.inUsdPerToken != null && rates?.outUsdPerToken != null) {
    const usd = (input ?? 0) * rates.inUsdPerToken + (output ?? 0) * rates.outUsdPerToken;
    if (usd > 0) return { usd, kind: 'estimated', flagged: true, costSource: 'estimated-from-tokens' };
  }
  return { usd: reservation.usd, kind: 'reserved-as-cost', flagged: true, costSource: 'reservation' };
}

const spendNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function jobSpend(record) {
  return { usd: spendNumber(record?.costUsd), tokens: spendNumber(record?.usage?.total_tokens) };
}
export function runTotals(state) {
  const totals = { usd: Number.isFinite(state.rental?.usd) ? state.rental.usd : 0, tokens: 0, unknownUsd: [] };
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
// `add` is what the job about to start is expected to cost (its reservation). The cap is HARD: a job is refused when what has been spent and what is already
// reserved, plus this job's own worst case, would pass the cap (and as before when the cap is already reached).
export function capDecision({ budget, run, laneToday, agent, add }) {
  for (const [reason, target, limits, prefix, keys] of [
    ['run-cap', run, budget, 'run', ['maxUsd', 'maxTokens']],
    ['lane-cap', laneToday?.[agent] ?? {}, budget.lanes?.[agent] ?? {}, `lane ${agent}`, ['dailyUsd', 'dailyTokens']],
  ]) {
    for (const field of keys) {
      const usd = field.endsWith('Usd'), spent = target?.[usd ? 'usd' : 'tokens'] ?? 0, limit = limits[field];
      // The hard rule is for dollars; a token cap keeps its earlier meaning (refuse once reached; in-flight reservations are already counted).
      const extra = usd ? Number(add?.usd) || 0 : 0;
      if (limit === null || limit === undefined || (spent < limit && spent + extra <= limit + 1e-9)) continue;
      const key = reason === 'run-cap' ? field : `lane.${agent}.${field}`;
      const amount = value => usd ? `$${value.toFixed(2)}` : String(value);
      const would = spent < limit ? ` plus this job's worst case ${amount(extra)} would pass` : ' >=';
      return { reason, key, spent, cap: limit, message: `spend-cap: ${prefix} spent ${amount(spent)}${reason === 'lane-cap' ? ' today' : ''}${would} ${field} ${amount(limit)}; resume with --raise ${key}=<N> --reason TEXT` };
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
        cost: cost !== null ? `$${cost.toFixed(2)}${record.costSource === 'estimated-from-tokens' ? ' est' : record.costSource === 'reservation' ? ' reserved' : ''}` : subscription.has(record.agent) ? 'subscription' : 'unknown',
      });
    });
  }
  return rows;
}
const ledgerHeader = '| date | phase | task | worker | model | result | tokens | rough cost |';
const divider = '| --- | --- | --- | --- | --- | --- | --- | --- |';
const rowText = row => `| ${['date', 'phase', 'task', 'worker', 'model', 'result', 'tokens', 'cost'].map(key => clean(row[key])).join(' | ')} |`;
// A detail row has 8 cells. A row with MORE cells (a stray pipe inside the task text, written by an older version or by hand) is read from
// the right: cost, tokens, result, model and worker are the last five cells, so a shifted row is still counted under the right day and tier.
export function parseLedgerRow(line) {
  const cells = String(line).trim().split('|').slice(1, -1).map(cell => cell.trim());
  if (cells.length < 8) return null;
  const tail = cells.slice(-5);
  const [worker, , result, tokens, cost] = tail;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[0]) && cells[0] !== '-') return null;
  return { date: cells[0], worker, result, tokens, cost };
}
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
  let uncounted = 0;
  for (const line of lines.slice(start + 2, end)) {
    if (/^\|[\s|:-]*\|$/.test(line.trim()) || /^\|\s*date\s*\|/.test(line.trim())) continue; // a repeated divider or header is not a data row
    const cells = parseLedgerRow(line);
    if (!cells) { uncounted++; continue; }
    const { date, worker, result, tokens, cost } = cells;
    const key = `${date}\0${worker}`;
    const group = groups.get(key) ?? { date, worker, calls: 0, pass: 0, tokens: 0, usd: 0, paid: false, subscription: false, estimated: false };
    group.calls++;
    if (result.startsWith('pass')) group.pass++;
    if (/^[\d,]+$/.test(tokens)) group.tokens += Number(tokens.replaceAll(',', ''));
    const paid = /^\$(\d+(?:\.\d+)?)(?: (est|reserved))?$/.exec(cost);
    if (paid) { group.paid = true; group.usd += Number(paid[1]); group.estimated ||= Boolean(paid[2]); }
    if (cost === 'subscription') group.subscription = true;
    groups.set(key, group);
  }
  const all = [...groups.values()].reduce((sum, g) => ({ calls: sum.calls + g.calls, pass: sum.pass + g.pass, tokens: sum.tokens + g.tokens, usd: sum.usd + g.usd, paid: sum.paid || g.paid }), { calls: 0, pass: 0, tokens: 0, usd: 0, paid: false });
  const anyEstimate = [...groups.values()].some(g => g.estimated), anySubscription = [...groups.values()].some(g => g.subscription);
  const summary = ['## Daily summary', '', '| date | tier | calls | pass | fail/blocked | tokens | rough cost |', '| --- | --- | --- | --- | --- | --- | --- |', ...[...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, g]) => `| ${g.date} | ${g.worker} | ${g.calls} | ${g.pass} | ${g.calls - g.pass} | ${g.tokens.toLocaleString('en-US')} | ${g.paid ? `$${g.usd.toFixed(2)}${g.estimated ? ' (incl. estimates)' : ''}` : g.subscription ? 'subscription' : 'unknown'} |`),
    ...(groups.size ? [`| **total** | all | ${all.calls} | ${all.pass} | ${all.calls - all.pass} | ${all.tokens.toLocaleString('en-US')} | ${all.paid ? `$${all.usd.toFixed(2)}${anyEstimate ? ' (incl. estimates)' : ''}` : anySubscription ? 'subscription' : 'unknown'} |`] : []),
    ...(uncounted ? ['', `${uncounted} ledger row${uncounted === 1 ? ' that' : 's that'} could not be read ${uncounted === 1 ? 'is' : 'are'} not in these totals.`] : [])];
  const summaryStart = lines.findIndex(line => line.trim() === '## Daily summary');
  if (summaryStart < 0) lines.push('', ...summary, '');
  else {
    let summaryEnd = summaryStart + 1;
    while (summaryEnd < lines.length && !lines[summaryEnd].trim()) summaryEnd++;
    if (lines[summaryEnd]?.trim().startsWith('|')) while (lines[summaryEnd]?.trim().startsWith('|')) summaryEnd++;
    // The note a previous merge wrote under the table is replaced too, so it neither repeats nor outlives the bad row.
    let probe = summaryEnd;
    while (probe < lines.length && !lines[probe].trim()) probe++;
    if (/^\d+ ledger rows? that could not be read /.test(lines[probe] ?? '')) summaryEnd = probe + 1;
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
