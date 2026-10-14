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
  assert.deepEqual(runTotals({ jobs: [
    { id: 'a', status: 'complete', costUsd: 1, usage: { total_tokens: 200 } },
    { id: 'b', status: 'failed', costUsd: 2 },
    { id: 'c', status: 'running', usage: { total_tokens: 20 } },
    { id: 'd' },
  ] }), { usd: 3, tokens: 220, unknownUsd: ['c'] });
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
