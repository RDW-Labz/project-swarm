// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  LANE_DAILY_DEFAULTS, resolveBudget, jobSpend, runTotals, laneDailyTotals,
  capDecision, ledgerRows, mergeLedger, validateIdleItems, runIdleMenu,
  PAID_LANES, LANE_RESERVE_DEFAULTS, spendDir, withSpendStore, laneDayTotals,
  estimateReservation, reserveSpend, settleSpend, releaseSpend, finalCost,
} from '../tools/spend.mjs';

test('budget precedence, lane lowering, null caps and ordered explicit raises', () => {
  assert.ok(Object.isFrozen(LANE_DAILY_DEFAULTS));
  assert.ok(Object.isFrozen(LANE_DAILY_DEFAULTS.openrouter));
  assert.equal(resolveBudget().lanes.openrouter.dailyUsd, 5);
  assert.equal(resolveBudget().maxTokens, null);
  const input = {
    config: { spend: { lanes: { openrouter: { dailyUsd: 8 }, ollama: { dailyTokens: 100 } } } },
    manifest: { budget: { maxUsd: 2, maxTokens: 1000, lanes: { openrouter: { dailyUsd: 20 }, ollama: { dailyTokens: 50 } } } },
    cli: { maxUsd: 3 },
  };
  const budget = resolveBudget(input);
  assert.equal(budget.maxUsd, 3);
  assert.equal(budget.maxTokens, 1000);
  assert.equal(budget.lanes.openrouter.dailyUsd, 8);
  assert.equal(budget.lanes.ollama.dailyTokens, 50);
  assert.equal(resolveBudget({ manifest: { budget: { lanes: { openrouter: { dailyUsd: 2 } } } } }).lanes.openrouter.dailyUsd, 2);
  assert.equal(resolveBudget({ manifest: { budget: { lanes: { openrouter: { dailyUsd: null } } } } }).lanes.openrouter.dailyUsd, 5);
  const raised = resolveBudget({ ...input, raises: [{ key: 'maxUsd', value: 4 }, { key: 'maxUsd', value: 5 }, { key: 'lane.openrouter.dailyUsd', value: 9 }, { key: 'lane.codex.dailyTokens', value: 1 }] });
  assert.equal(raised.maxUsd, 5);
  assert.equal(raised.lanes.openrouter.dailyUsd, 9);
  assert.equal(raised.lanes.codex.dailyTokens, 1);
  assert.equal(input.manifest.budget.maxUsd, 2);
  assert.equal(resolveBudget({ cli: { maxUsd: null } }).maxUsd, null);
});

test('budget rejects invalid caps, unknown fields/agents and non-increasing raises', () => {
  for (const value of [0, -1, NaN, Infinity, '5', false]) {
    assert.throws(() => resolveBudget({ manifest: { budget: { maxUsd: value } } }), { code: 'budget-invalid', message: /^budget-invalid: maxUsd / });
  }
  for (const input of [
    { cli: { maxTokens: 1.5 } },
    { manifest: { budget: { extra: 1 } } },
    { config: { spend: { lanes: { auto: {} } } } },
    { manifest: { budget: { lanes: { codex: { dailyUsd: 0 } } } } },
    { config: { spend: { lanes: { codex: { dailyTokens: 1.2 } } } } },
    { config: { spend: { lanes: { codex: { maxUsd: 1 } } } } },
    { config: { spend: { lanes: [] } } },
    { raises: [{ key: 'lane.auto.dailyUsd', value: 5 }] },
    { raises: [{ key: 'unknown', value: 5 }] },
  ]) assert.throws(() => resolveBudget(input), { code: 'budget-invalid' });
  for (const value of [4, 5, null]) assert.throws(() => resolveBudget({ raises: [{ key: 'lane.openrouter.dailyUsd', value }] }), { code: 'budget-raise-invalid' });
});

test('spend totals count incomplete records and preserve unknown cost ids', () => {
  assert.deepEqual(jobSpend({}), { usd: null, tokens: null });
  assert.deepEqual(jobSpend({ costUsd: 0, usage: { total_tokens: 0 } }), { usd: 0, tokens: 0 });
  assert.deepEqual(jobSpend({ costUsd: Infinity, usage: { total_tokens: '3' } }), { usd: null, tokens: null });
  // Jobs without agent are metered; c has tokens but no costUsd (unknownUsd + billed unknown);
  // d has neither (billed unknown). Missing lane uses anthropic reserve default 0.5 each → billedUnknownUsd 1.
  assert.deepEqual(runTotals({ jobs: [
    { id: 'a', status: 'complete', costUsd: 1, usage: { total_tokens: 200 } },
    { id: 'b', status: 'failed', costUsd: 2 },
    { id: 'c', status: 'running', usage: { total_tokens: 20 } },
    { id: 'd' },
  ] }), {
    usd: 3,
    tokens: 220,
    unknownUsd: ['c'],
    billedUsd: 3,
    billedUnknown: 2,
    billedUnknownUsd: 1,
    billedUnknownRented: 0,
    hasPaidLaneJob: true,
  });
});

test('daily totals use UTC midnight inclusively and exclude the requested run', () => {
  const job = (finishedAt, costUsd, agent = 'openrouter') => ({ finishedAt, agent, costUsd, usage: { total_tokens: 10 } });
  assert.deepEqual(laneDailyTotals([
    { id: 'old', jobs: [job('2026-10-13T23:59:59.999Z', 99), job('2026-10-14T00:00:00Z', 2), job('invalid', 99), job('2026-10-14T03:00:00Z', 1, 'codex')] },
    { id: 'skip', jobs: [job('2026-10-14T01:00:00Z', 99)] },
  ], { now: () => new Date('2026-10-14T01:00:00-05:00'), excludeRunId: 'skip' }), {
    openrouter: { usd: 2, tokens: 10 }, codex: { usd: 1, tokens: 10 },
  });
});

test('cap decisions check run before lane, use inclusive bounds and actionable messages', () => {
  const budget = resolveBudget({ cli: { maxUsd: 1, maxTokens: 100 } });
  const input = { budget, run: { usd: 0.9, tokens: 99 }, laneToday: {}, agent: 'openrouter' };
  assert.equal(capDecision(input), null);
  assert.deepEqual(capDecision({ ...input, run: { usd: 1.2, tokens: 100 } }), {
    reason: 'run-cap', key: 'maxUsd', spent: 1.2, cap: 1,
    message: 'spend-cap: run spent $1.20 >= maxUsd $1.00; resume with --raise maxUsd=<N> --reason TEXT',
  });
  assert.equal(capDecision({ ...input, run: { usd: 0, tokens: 100 } }).message, 'spend-cap: run spent 100 >= maxTokens 100; resume with --raise maxTokens=<N> --reason TEXT');
  assert.equal(capDecision({ ...input, laneToday: { openrouter: { usd: 5.01, tokens: 0 } } }).message, 'spend-cap: lane openrouter spent $5.01 today >= dailyUsd $5.00; resume with --raise lane.openrouter.dailyUsd=<N> --reason TEXT');
  const tokenBudget = resolveBudget({ config: { spend: { lanes: { ollama: { dailyTokens: 10 } } } } });
  assert.equal(capDecision({ budget: tokenBudget, run: {}, agent: 'ollama', laneToday: { ollama: { tokens: 10 } } }).key, 'lane.ollama.dailyTokens');
});

const attempt = (status = 'complete') => ({ finishedAt: '2026-10-14T01:00:00+01:00', status });
test('ledger rows include attempt keys, sanitized bounded tasks, usage and cost types', () => {
  const rows = ledgerRows({ id: 'run', jobs: [
    { id: 'a', agent: 'openrouter', model: 'm', prompt: 'fallback', report: { summary: 'hello|world\n\x01' + 'x'.repeat(110) }, status: 'complete', costUsd: 1.235, usage: { total_tokens: 12345 }, attempts: [attempt('failed'), attempt()] },
    { id: 'b', agent: 'codex', prompt: 'first line\nsecond line', status: 'failed', error: 'e'.repeat(90), attempts: [{ finishedAt: '2026-10-14T02:00:00Z' }] },
    { id: 'c', agent: 'ollama', status: 'complete', attempts: [attempt()] },
    { id: 'd', agent: 'claude', status: 'held', attempts: [] },
  ] }, { phase: '6' });
  assert.deepEqual(rows.map(row => row.key), ['run/a#1', 'run/a#2', 'run/b#1', 'run/c#1']);
  assert.equal(rows[0].date, '2026-10-14');
  assert.equal(rows[0].tokens, '-');
  assert.equal(rows[0].cost, 'unknown');
  assert.equal(rows[1].tokens, '12,345');
  assert.equal(rows[1].cost, '$1.24');
  assert.equal(rows[1].result, 'pass');
  assert.equal(rows[1].phase, '6');
  assert.equal(rows[1].task.length, 100);
  assert.doesNotMatch(rows[1].task, /[|\x00-\x1f]/);
  assert.equal(rows[2].task, 'b: first line');
  assert.equal(rows[2].result, 'failed: ' + 'e'.repeat(60));
  assert.equal(rows[2].cost, 'subscription');
  assert.equal(rows[3].cost, 'unknown');
});

test('mergeLedger creates, appends, recomputes sorted summaries and preserves trailing text', () => {
  const row = { date: '2026-10-14', phase: '6', task: 'a', worker: 'codex', model: 'm', result: 'pass', tokens: '1,000', cost: 'subscription' };
  const first = mergeLedger('', [row]);
  assert.match(first, /^# Usage ledger/);
  assert.match(first, /\| 2026-10-14 \| codex \| 1 \| 1 \| 0 \| 1,000 \| subscription \|/);
  const trailing = '\n## Notes\nKeep this exact text.\n';
  const second = mergeLedger(first + trailing, [
    { ...row, result: 'blocked: x', tokens: '25', cost: '$0.40' },
    { ...row, worker: 'ollama', tokens: '-', cost: 'unknown' },
    { ...row, date: '2026-10-13', cost: '$1.00' },
  ]);
  assert.match(second, /\| 2026-10-14 \| codex \| 2 \| 1 \| 1 \| 1,025 \| \$0.40 \|/);
  assert.match(second, /\| 2026-10-14 \| ollama \| 1 \| 1 \| 0 \| 0 \| unknown \|/);
  assert.ok(second.endsWith(trailing));
  assert.equal(mergeLedger(second, []), second);
  assert.ok(mergeLedger('Existing prose.\n', []).includes('Existing prose.'));
});

test('idle item validation rejects malformed names, commands and timeouts', () => {
  assert.deepEqual(validateIdleItems([]), []);
  for (const item of [null, { name: 1, argv: ['true'] }, { name: '../bad', argv: ['true'] }, { name: 'UPPER', argv: ['true'] }, { name: 'x', argv: [] }, { name: 'x', argv: [1] }, { name: 'x', argv: ['true'], timeoutMs: 999 }, { name: 'x', argv: ['true'], timeoutMs: 3600001 }, { name: 'x', argv: ['true'], timeoutMs: 1000.5 }]) {
    assert.throws(() => validateIdleItems([item]), { code: 'idle-invalid' });
  }
  assert.throws(() => validateIdleItems({}), { code: 'idle-invalid' });
});

const exec = promisify(execFile);
const tempSpend = () => fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'spend-store-'));
const fixedNow = () => Date.parse('2026-10-14T12:00:00Z');
const entry = overrides => ({ day: '2026-10-14', lane: 'openrouter', runId: 'r', root: '/fixture', jobId: 'j', usd: 0.5, tokens: 10, kind: 'reservation', pid: process.pid, host: os.hostname(), at: '2026-10-14T12:00:00Z', flagged: false, ...overrides });

test('reservation defaults, rate validation and every estimation source', () => {
  assert.deepEqual(PAID_LANES, ['openrouter', 'openai', 'gemini', 'lambda', 'anthropic', 'rented']);
  assert.ok(Object.isFrozen(PAID_LANES) && Object.isFrozen(LANE_RESERVE_DEFAULTS));
  assert.equal(spendDir({ SWARM_SPEND_DIR: '/fixture/spend' }, '/home'), '/fixture/spend');
  assert.equal(spendDir({}, '/home'), '/home/.project-swarm/spend');
  assert.equal(resolveBudget().lanes.openai.reserveUsd, 0.5);
  assert.equal(resolveBudget({ config: { spend: { lanes: { openrouter: { reserveUsd: 2 } }, rates: { m: { inUsdPerToken: 0, outUsdPerToken: 0.001 } } } } }).lanes.openrouter.reserveUsd, 2);
  for (const reserveUsd of [null, 0, -1, Infinity, '1']) assert.throws(() => resolveBudget({ config: { spend: { lanes: { openai: { reserveUsd } } } } }), { code: 'budget-invalid' });
  for (const rates of [null, [], { m: {} }, { m: { inUsdPerToken: -1, outUsdPerToken: 1 } }, { m: { inUsdPerToken: 1, outUsdPerToken: Infinity } }, { m: { inUsdPerToken: 1, outUsdPerToken: 1, creditUsd: '1' } }, { m: { inUsdPerToken: 1, outUsdPerToken: 1, unknown: 1 } }]) assert.throws(() => resolveBudget({ config: { spend: { rates } } }), { code: 'budget-invalid' });
  const input = { job: { maxOutputTokens: 100, maxCredits: 4 }, lane: 'openrouter', model: 'm', inputChars: 9, rates: { creditUsd: 0.2, inUsdPerToken: 0.01, outUsdPerToken: 0.02 } };
  assert.deepEqual(estimateReservation(input), { usd: 0.8, tokens: 103, source: 'max-credits' });
  assert.deepEqual(estimateReservation({ ...input, job: { maxOutputTokens: 100 } }), { usd: 2.09, tokens: 103, source: 'rate' });
  assert.deepEqual(estimateReservation({ ...input, rates: null, laneDefaults: { openrouter: { reserveUsd: 0.7 } } }), { usd: 0.7, tokens: 103, source: 'lane-default' });
  assert.deepEqual(estimateReservation({ ...input, lane: 'ollama' }), { usd: 0, tokens: 103, source: 'unpaid' });
  assert.equal(estimateReservation({ ...input, job: {}, model: 'deepseek/test' }).tokens, 16003);
  assert.equal(estimateReservation({ ...input, job: {}, lane: 'openai', rates: null }).tokens, 8195);
  assert.equal(estimateReservation({ ...input, rates: { creditUsd: 0 } }).usd, 0.5);
});

test('final costs preserve reported zero, estimate token aliases and retain unpaid zero', () => {
  const input = { lane: 'openrouter', record: {}, reservation: { usd: 0.5 }, rates: { inUsdPerToken: 0.01, outUsdPerToken: 0.02 } };
  assert.deepEqual(finalCost({ ...input, record: { costUsd: 0 } }), { usd: 0, kind: 'actual', flagged: false, costSource: 'reported' });
  assert.equal(finalCost({ ...input, record: { costUsd: 2, costSource: 'provider' } }).costSource, 'provider');
  assert.deepEqual(finalCost({ ...input, lane: 'ollama' }), { usd: 0, kind: 'actual', flagged: false, costSource: null });
  for (const usage of [{ input_tokens: 10, output_tokens: 20 }, { prompt_tokens: 10, completion_tokens: 20 }]) assert.deepEqual(finalCost({ ...input, record: { usage } }), { usd: 0.5, kind: 'estimated', flagged: true, costSource: 'estimated-from-tokens' });
  assert.equal(finalCost({ ...input, record: { usage: { output_tokens: 10 } } }).usd, 0.2);
  for (const record of [{}, { usage: { total_tokens: 100 } }, { usage: { input_tokens: 0 } }]) assert.deepEqual(finalCost({ ...input, record }), { usd: 0.5, kind: 'reserved-as-cost', flagged: true, costSource: 'reservation' });
});

test('store serializes callers, writes changes only, prunes and preserves crashed reservations', async () => {
  const dir = await tempSpend(), file = path.join(dir, 'daily.json');
  const store = { version: 1, entries: { old: entry({ day: '2026-09-12' }), boundary: entry({ day: '2026-09-13' }), crashed: entry({ pid: 99999999 }), foreign: entry({ pid: 99999999, host: 'other-host' }) } };
  await fs.writeFile(file, JSON.stringify(store));
  await withSpendStore(async current => {
    assert.equal(current.entries.old, undefined);
    assert.equal(current.entries.boundary.kind, 'reservation');
    assert.equal(current.entries.crashed.kind, 'reserved-as-cost');
    assert.equal(current.entries.crashed.flagged, true);
    assert.equal(current.entries.foreign.kind, 'reservation');
    await assert.rejects(withSpendStore(() => {}, { dir, timeoutMs: 30 }), { code: 'spend-store-locked' });
  }, { dir, now: fixedNow, isAlive: pid => pid === process.pid });
  const before = await fs.stat(file);
  assert.equal(await withSpendStore(() => 42, { dir, now: fixedNow }), 42);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(laneDayTotals(saved, { day: '2026-10-14' }), { openrouter: { usd: 1, tokens: 20 } });
  await assert.rejects(fs.access(path.join(dir, 'daily.lock')), { code: 'ENOENT' });
  await assert.rejects(withSpendStore(() => { throw new Error('callback'); }, { dir }), /callback/);
  await assert.rejects(fs.access(path.join(dir, 'daily.lock')), { code: 'ENOENT' });
});

test('store clears stale locks, times out on live/foreign locks and refuses malformed files', async () => {
  for (const owner of [null, { pid: 99999999, host: os.hostname() }]) {
    const dir = await tempSpend(), lock = path.join(dir, 'daily.lock');
    await fs.mkdir(lock);
    if (owner) await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    else await fs.utimes(lock, new Date(Date.now() - 61000), new Date(Date.now() - 61000));
    await withSpendStore(store => { store.entries.ok = entry(); }, { dir });
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'daily.json'), 'utf8')).entries.ok.usd, 0.5);
  }
  for (const owner of [{ pid: process.pid, host: os.hostname() }, { pid: 99999999, host: 'other-host' }]) {
    const dir = await tempSpend();
    await fs.mkdir(path.join(dir, 'daily.lock'));
    await fs.writeFile(path.join(dir, 'daily.lock', 'owner.json'), JSON.stringify(owner));
    await assert.rejects(withSpendStore(() => {}, { dir, timeoutMs: 30 }), { code: 'spend-store-locked' });
  }
  for (const text of ['{broken', '{}', '{"version":1,"entries":{"x":{}}}']) {
    const dir = await tempSpend(), file = path.join(dir, 'daily.json');
    await fs.writeFile(file, text);
    await assert.rejects(withSpendStore(() => { assert.fail('must not call callback'); }, { dir }), { code: 'spend-store-invalid' });
    assert.equal(await fs.readFile(file, 'utf8'), text);
    await assert.rejects(fs.access(path.join(dir, 'daily.lock')), { code: 'ENOENT' });
  }
});

test('reservation admission, settlement and release preserve original UTC day', async () => {
  const dir = await tempSpend(), budget = resolveBudget({ cli: { maxTokens: 10 } });
  const input = { dir, key: '0123456789ab/r/j#1', lane: 'openrouter', runId: 'r', root: '/fixture', jobId: 'j', usd: 0.5, tokens: 10, budget, runTotals: { usd: 0, tokens: 0 }, now: fixedNow };
  const admitted = await reserveSpend(input);
  assert.equal(admitted.decision, null);
  assert.ok(admitted.dailyLimit?.evaluation?.allow);
  assert.equal((await reserveSpend({ ...input, key: 'blocked', runTotals: { tokens: 10 } })).decision.reason, 'run-cap');
  await settleSpend({ dir, key: input.key, usd: 0.6, tokens: 20, kind: 'estimated', flagged: true, now: () => fixedNow() + 86400000 });
  await withSpendStore(store => {
    assert.equal(store.entries[input.key].day, '2026-10-14');
    assert.equal(store.entries[input.key].kind, 'estimated');
    assert.equal(store.entries[input.key].usd, 0.6);
    assert.equal(store.entries.blocked, undefined);
  }, { dir, now: fixedNow });
  await releaseSpend({ dir, key: input.key });
  await releaseSpend({ dir, key: 'missing' });
  await settleSpend({ dir, key: 'missing', usd: 1, tokens: 1, kind: 'actual', flagged: false });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'daily.json'), 'utf8')).entries, {});
});

test('eight child processes admit exactly ten half-dollar reservations at a five-dollar cap', async () => {
  const dir = await tempSpend();
  const moduleUrl = new URL('../tools/spend.mjs', import.meta.url).href;
  const code = `import { reserveSpend, resolveBudget } from ${JSON.stringify(moduleUrl)}; for (let n = 0; n < 8; n++) await reserveSpend({dir: process.env.SWARM_SPEND_DIR, key: '0123456789ab/r/' + process.pid + '#' + n, lane: 'openrouter', runId: 'r', root: '/fixture', jobId: String(process.pid), usd: 0.5, tokens: 10, budget: resolveBudget(), runTotals: { usd: 0, tokens: 0 }});`;
  const results = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SWARM_SPEND_DIR: dir } })));
  assert.equal(results.length, 8);
  const store = JSON.parse(await fs.readFile(path.join(dir, 'daily.json'), 'utf8'));
  assert.equal(Object.keys(store.entries).length, 10);
  assert.deepEqual(laneDayTotals(store), { openrouter: { usd: 5, tokens: 100 } });
});

test('ledger flags estimates and reservations and sums them in the daily summary', () => {
  const rows = ledgerRows({ id: 'r', jobs: ['reported', 'estimated-from-tokens', 'reservation'].map((costSource, i) => ({ id: `j${i}`, agent: 'openrouter', costUsd: 0.5, costSource, status: 'complete', attempts: [attempt()] })) });
  assert.deepEqual(rows.map(row => row.cost), ['$0.50', '$0.50 est', '$0.50 reserved']);
  const ledger = mergeLedger('', rows);
  assert.match(ledger, /\| 2026-10-14 \| openrouter \| 3 \| 3 \| 0 \| 0 \| \$1.50 \(incl\. estimates\) \|/);
  assert.equal(mergeLedger(ledger, []), ledger);
});

async function git(root, args) {
  return (await exec('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim();
}
test('idle commands commit on isolated branches, fail, time out, sanitize env and clean up', async () => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'spend-idle-'));
  await git(root, ['init', '-b', 'main']);
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(root, 'tracked'), 'base\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'base']);
  const baseCommit = await git(root, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(root, 'tracked'), 'dirty root stays\n');
  const before = await git(root, ['status', '--porcelain']);
  const item = (name, code, timeoutMs) => ({ name, argv: [process.execPath, '-e', code], ...(timeoutMs ? { timeoutMs } : {}) });
  const items = [
    item('write-env', "require('node:fs').writeFileSync('env.json', JSON.stringify(process.env))"),
    item('unchanged', 'process.exit(0)'),
    item('fail', "require('node:fs').writeFileSync('partial', 'x'); process.exit(3)"),
    item('timeout', 'setInterval(() => {}, 1000)', 1000),
    item('missing', 'process.exit(0)'),
  ];
  items[4].argv = [path.join(root, 'no-such-executable')];
  const suppliedEnvs = [];
  const spawnImpl = (command, args, options) => {
    suppliedEnvs.push(options.env);
    return spawn(command, args, options);
  };
  const results = await runIdleMenu(root, { runId: 'run-1', items, baseCommit, spawnImpl });
  assert.deepEqual(results.map(result => result.status), ['committed', 'unchanged', 'failed', 'timeout', 'failed']);
  assert.equal(results[2].exitCode, 3);
  assert.equal(results[0].branch, 'idle/run-1/write-env');
  assert.match(results[0].commit, /^[a-f0-9]{40}$/);
  const env = JSON.parse(await git(root, ['show', 'idle/run-1/write-env:env.json']));
  assert.equal(env.SWARM_IDLE, '1');
  const allowed = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'SWARM_IDLE'];
  for (const supplied of suppliedEnvs) assert.deepEqual(Object.keys(supplied).filter(key => !allowed.includes(key)), []);
  // CoreFoundation inserts this variable during Node startup on macOS; it is
  // absent from the environment passed to spawn, which is checked above.
  const runtimeKeys = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];
  assert.deepEqual(Object.keys(env).filter(key => ![...allowed, ...runtimeKeys].includes(key)), []);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), baseCommit);
  assert.equal(await git(root, ['branch', '--show-current']), 'main');
  assert.equal(await git(root, ['status', '--porcelain']), before);
  assert.equal(await fs.readFile(path.join(root, 'tracked'), 'utf8'), 'dirty root stays\n');
  for (const entry of items) await assert.rejects(fs.access(path.join(root, '.swarm', 'idle', 'run-1', entry.name)), { code: 'ENOENT' });
  const repeated = await runIdleMenu(root, { runId: 'run-1', items: [items[0]], baseCommit });
  assert.equal(repeated[0].status, 'skipped');
  assert.equal(repeated[0].error, 'idle-branch-exists');
  assert.deepEqual(await runIdleMenu(root, { runId: 'run-1', items, baseCommit, until: 100, now: () => 100 }), []);
  const history = JSON.parse(await fs.readFile(path.join(root, '.swarm', 'runs', 'run-1', 'idle.json'), 'utf8'));
  assert.equal(history.length, 3);
  assert.deepEqual(history[0].results, results);
});

test('a fake clock far from the real one never makes a fresh lock look stale (30 concurrent writers all finish)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-clock-'));
  try {
    const now = () => Date.UTC(2030, 0, 1);
    let done = 0;
    await Promise.all(Array.from({ length: 30 }, () => withSpendStore(async () => { done += 1; }, { dir, now, timeoutMs: 20000 })));
    assert.equal(done, 30);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
