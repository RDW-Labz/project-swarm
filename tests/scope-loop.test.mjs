// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scopeLoop, ledgerSummary, classifyIdle, loopExitCode } from '../tools/scope-loop.mjs';

const tk = (id, status, extra = {}) => ({ id, status, type: 'build', ...extra });
// A fake project: tickets finish in dependency order, one wave at a time.
function fake({ tickets, fail = {}, review = null } = {}) {
  const t = tickets.map(x => ({ ...x }));
  const calls = [], logs = [];
  const nothing = code => Object.assign(new Error('no ready tickets'), { code });
  const deps = {
    prepare: async () => {
      const done = new Set(t.filter(x => x.status === 'done').map(x => x.id));
      const ready = t.filter(x => x.status === 'ready' && (x.after ?? []).every(d => done.has(d)) && x.type !== 'human');
      if (!ready.length) throw nothing('scope-nothing');
      ready.forEach(x => { x.status = 'running'; });
      calls.push(['prepare', ready.map(x => x.id)]);
      return { file: `wave-${calls.length}.json`, ids: ready.map(x => x.id) };
    },
    runWave: async file => {
      const ids = t.filter(x => x.status === 'running').map(x => x.id);
      calls.push(['runWave', file]);
      const failed = fail.run?.(ids, calls.length);
      if (failed) return failed;
      return { status: 'committed', stage: 'commit', runId: `run-${calls.length}`, integrate: { files: ['a'] } };
    },
    sync: async (runId, { integrated }) => {
      calls.push(['sync', runId, integrated]);
      if (integrated) { t.filter(x => x.status === 'review').forEach(x => { x.status = 'done'; }); return review?.(runId, calls) ?? 'done'; }
      t.filter(x => x.status === 'running').forEach(x => { x.status = 'review'; });
      return 'review';
    },
    salvage: async (runId, n) => { calls.push(['salvage', runId, n]); return { integrated: true, jobs: 1 }; },
    review: async (kind, file) => { calls.push(['review', kind, file]); return { runId: `rv-${calls.length}` }; },
    record: async (kind, runId) => { calls.push(['record', kind, runId]); },
    ledger: async () => ({ tickets: t }),
    revert: async ids => { calls.push(['revert', ids]); t.filter(x => ids.includes(x.id) && x.status === 'running').forEach(x => { x.status = 'ready'; }); },
    stopped: async () => null,
    log: text => logs.push(text),
  };
  return { deps, calls, logs, t };
}

test('waves run until every ticket is done: build, run, sync, sync --integrated, next', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready'), tk('T-2', 'ready'), tk('T-3', 'ready', { after: ['T-1'] }), tk('T-4', 'ready', { after: ['T-3'] })] });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'complete');
  assert.equal(out.waves.length, 3);
  assert.deepEqual(out.waves.map(w => w.ids), [['T-1', 'T-2'], ['T-3'], ['T-4']]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'sync').slice(0, 2), [['sync', 'run-2', false], ['sync', 'run-2', true]]);
  assert.equal(out.summary.done, 4);
  assert.equal(loopExitCode(out.status), 0);
});

test('only human tickets left: it says so and stops with exit 0; stuck tickets exit 1', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready'), tk('T-9', 'ready', { type: 'human' })] });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'waiting-human');
  assert.match(out.reason, /1 human ticket/);
  assert.equal(loopExitCode(out.status), 0);
  const g = fake({ tickets: [tk('T-1', 'blocked'), tk('T-2', 'review')] });
  const stuck = await scopeLoop({ deps: g.deps });
  assert.equal(stuck.status, 'stuck');
  assert.match(stuck.reason, /1 in review, 1 blocked/);
  assert.equal(loopExitCode(stuck.status), 1);
});

test('a wave that cannot start (project cap, stop marker) puts its tickets back to ready and stops', async () => {
  const cap = fake({ tickets: [tk('T-1', 'ready')], fail: { run: () => ({ status: 'failed', stage: 'run', runId: null, reason: 'project-cap: this project has spent $5.00 >= the project cap $5.00; no new run starts' }) } });
  const out = await scopeLoop({ deps: cap.deps });
  assert.equal(out.status, 'cap');
  assert.deepEqual(cap.calls.find(c => c[0] === 'revert'), ['revert', ['T-1']]);
  assert.equal(cap.t[0].status, 'ready');
  const stop = fake({ tickets: [tk('T-1', 'ready')], fail: { run: () => ({ status: 'failed', stage: 'run', runId: null, reason: 'stopped: swarm stop --all ran at T; run swarm stop --clear first' }) } });
  assert.equal((await scopeLoop({ deps: stop.deps })).status, 'stopped');
  const marker = fake({ tickets: [tk('T-1', 'ready')] });
  marker.deps.stopped = async () => 'stopped: swarm stop --all ran';
  const first = await scopeLoop({ deps: marker.deps });
  assert.equal(first.status, 'stopped');
  assert.equal(marker.calls.length, 0, 'nothing started');
});

test('a paused run keeps its tickets running and tells you to resume; no sync', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready')], fail: { run: () => ({ status: 'failed', stage: 'run', runId: 'run-2', reason: 'run paused' }) } });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'paused');
  assert.match(out.reason, /swarm resume run-2/);
  assert.equal(f.calls.some(c => c[0] === 'sync'), false);
  assert.equal(f.t[0].status, 'running');
  assert.equal(loopExitCode('paused'), 75);
});

test('a wave where some jobs failed integrates the finished ones and goes on', async () => {
  let first = true;
  const f = fake({ tickets: [tk('T-1', 'ready'), tk('T-2', 'ready')], fail: { run: () => { if (!first) return null; first = false; return { status: 'failed', stage: 'run', runId: 'run-2', reason: 'run failed' }; } } });
  const out = await scopeLoop({ deps: f.deps });
  assert.ok(f.calls.some(c => c[0] === 'salvage'));
  assert.equal(out.status, 'complete');
});

test('a failed integrate (checks) stops the loop: the next wave would build on unmerged code', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready'), tk('T-2', 'ready', { after: ['T-1'] })], fail: { run: () => ({ status: 'failed', stage: 'integrate', runId: 'run-2', reason: 'checks failed: unit', integrate: { files: [] } }) } });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /stopped at integrate: checks failed: unit/);
  assert.equal(out.waves.length, 1);
});

test('reviews the sync asks for are run, recorded, and the sync repeated', async () => {
  let asked = 0;
  const f = fake({ tickets: [tk('T-1', 'ready')], review: () => (asked++ === 0 ? '1 ticket(s) stay in review until an Opus security review passes: T-1. Run: swarm run .swarm/security-reviews/run-2.json; then swarm scope security-review RUNID' : 'done') });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'complete');
  const reviewCalls = f.calls.filter(c => ['review', 'record'].includes(c[0]));
  assert.deepEqual(reviewCalls[0], ['review', 'security', '.swarm/security-reviews/run-2.json']);
  assert.deepEqual(reviewCalls[1].slice(0, 2), ['record', 'security']);
  assert.match(reviewCalls[1][2], /^rv-/);
  assert.equal(out.waves[0].reviews, 1);
});

test('review rounds are limited, and waves that finish nothing end in no-progress', async () => {
  const always = fake({ tickets: [tk('T-1', 'ready')], review: () => 'Run: swarm run .swarm/acceptance-reviews/r.json' });
  always.deps.sync = async (runId, { integrated }) => { always.calls.push(['sync', runId, integrated]); return integrated ? 'Run: swarm run .swarm/acceptance-reviews/r.json' : 'review'; };
  const out = await scopeLoop({ deps: always.deps, maxWaves: 1 });
  assert.equal(always.calls.filter(c => c[0] === 'review').length, 3, 'three rounds, then it is left for the owner');
  assert.equal(out.status, 'max-waves');
  // Tickets that never finish: every wave is a failure to progress.
  const stall = fake({ tickets: [tk('T-1', 'ready')] });
  stall.deps.sync = async (runId, { integrated }) => { stall.t.forEach(x => { x.status = 'ready'; }); return 'x'; };
  const s = await scopeLoop({ deps: stall.deps });
  assert.equal(s.status, 'no-progress');
  assert.equal(s.waves.length, 4);
});

test('--max-waves bounds the loop', async () => {
  const f = fake({ tickets: Array.from({ length: 5 }, (_, n) => tk(`T-${n}`, 'ready', n ? { after: [`T-${n - 1}`] } : {})) });
  const out = await scopeLoop({ deps: f.deps, maxWaves: 2 });
  assert.equal(out.status, 'max-waves');
  assert.equal(out.waves.length, 2);
  assert.match(out.reason, /run it again to continue/);
});

test('summary and idle classification', () => {
  const s = ledgerSummary({ tickets: [tk('a', 'done'), tk('b', 'cancelled'), tk('c', 'review'), tk('d', 'ready', { type: 'human' })] });
  assert.deepEqual(s, { total: 3, done: 1, ready: 1, running: 0, review: 1, blocked: 0, humans: 1 });
  assert.equal(classifyIdle({ total: 2, done: 2, ready: 0, running: 0, review: 0, blocked: 0, humans: 0 }).status, 'complete');
  assert.equal(classifyIdle({ total: 2, done: 1, ready: 0, running: 0, review: 0, blocked: 0, humans: 1 }).status, 'waiting-human');
});

test('CLI: go --scope refuses --pr and a bad --max-waves; --wave still builds one wave and --max-waves is not a wave flag', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-loop-')));
  const run = (...args) => spawnSync(process.execPath, ['tools/swarm.mjs', '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, SWARM_CONFIG: path.join(root, 'none.json') } });
  const pr = run('go', '--scope', '--pr', 'x.json');
  assert.notEqual(pr.status, 0);
  assert.match(pr.stderr, /go --scope --wave --pr FILE/);
  assert.match(run('go', '--scope', '--max-waves', '0').stderr, /--max-waves must be/);
  const noRepo = run('go', '--scope');
  assert.equal(noRepo.status, 1);
  assert.match(noRepo.stderr, /not a git repository/);
  const git = (...a) => spawnSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const onMain = run('go', '--scope');
  assert.equal(onMain.status, 1);
  assert.match(onMain.stderr, /you are on main.*--allow-main-branch/);
  git('switch', '-q', '-c', 'build');
  const noLedger = run('go', '--scope');
  assert.equal(noLedger.status, 1);
  assert.equal(JSON.parse(noLedger.stdout).status, 'failed');
  assert.match(JSON.parse(noLedger.stdout).reason, /no ticket ledger/);
  // One loop per project: a live lock refuses a second one.
  await fs.mkdir(path.join(root, '.swarm/project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/project/scope-loop.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const locked = run('go', '--scope');
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /scope-loop-running: pid \d+ already runs scope-loop/);
  await fs.rm(path.join(root, '.swarm/project/scope-loop.lock'));
  // Never beside autopilot either.
  await fs.writeFile(path.join(root, '.swarm/project/autopilot.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const beside = run('go', '--scope');
  assert.equal(beside.status, 1);
  assert.match(beside.stderr, /autopilot-running/);
  assert.equal(await fs.stat(path.join(root, '.swarm/project/scope-loop.lock')).then(() => true, () => false), false, 'the loop lock is released when the second lock is refused');
  await fs.rm(path.join(root, '.swarm/project/autopilot.lock'));
  for (const flag of ['--concurrency', '--leads', '--batch']) assert.match(run('go', '--scope', flag, '2').stderr, /has no effect on go --scope/);
  const wave = run('go', '--scope', '--wave');
  assert.notEqual(wave.status, 0);
  assert.match(wave.stderr, /no ticket ledger/);
  assert.notEqual(run('go', '--scope', '--wave', '--max-waves', '2').status, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('CLI: go --scope on an approved ledger with the project cap reached starts no wave, puts the tickets back to ready and says cap', async () => {
  const { runScopeCommand } = await import('../tools/scope-commands.mjs');
  const { readLedger } = await import('../tools/tickets.mjs');
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'scope-loop-cap-')));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  const git = (...a) => spawnSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'build');
  await fs.mkdir(path.join(root, 'docs/scope'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  const SCOPE = ['# Scope: Demo', 'Version: 1', '', '## Overview', 'Demo.', '', '## Stages', '- S1: Core', '', '## S1 Core', '### R-001 A user can create a request.', 'Acceptance:', '- Returns 201.', '', '## Protected', '- .env', ''].join('\n');
  await fs.writeFile(path.join(root, 'docs/scope/scope.md'), SCOPE);
  const item = key => ({ key, title: key, type: 'build', scopeRefs: ['R-001'], acceptance: ['ok'], files: [`src/${key}.mjs`], size: 'S', risk: 'low' });
  const ws = '.swarm/workspaces/r1/split-S1';
  await fs.mkdir(path.join(root, ws, 'docs/scope/split'), { recursive: true });
  await fs.writeFile(path.join(root, ws, 'docs/scope/split/S1.json'), JSON.stringify([item('mod'), { ...item('mount'), integration: true, files: ['src/routes/m.mjs'], tests: ['tests/m.test.mjs'], dependsOn: ['mod'] }]));
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/state.json'), JSON.stringify({ id: 'r1', status: 'complete', jobs: [{ id: 'split-S1', status: 'complete', workspace: ws, costUsd: 9 }] }));
  const split = await runScopeCommand(root, 'scope', ['split', '--ingest', 'r1']);
  assert.equal(split.exitCode, 0, split.stdout);
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, acceptance: { enforce: false }, protectedPaths: [], budget: { maxUsd: 5, projectMaxUsd: 1 } } }));
  const approved = await runScopeCommand(root, 'scope', ['approve', '--yes']);
  assert.equal(approved.exitCode, 0, approved.stdout);
  git('add', '-A'); git('commit', '-qm', 'scope');
  await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({ lanes: { anthropic: { model: 'claude-haiku-5-5' } } }));
  const run = spawnSync(process.execPath, ['tools/swarm.mjs', '--root', root, 'go', '--scope'], { encoding: 'utf8', env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') } });
  const result = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(result.status, 'cap', `${run.stdout}\n${run.stderr}`);
  assert.equal(run.status, 1);
  const tickets = (await readLedger(root)).tickets;
  assert.ok(tickets.every(x => x.status !== 'running'), JSON.stringify(tickets.map(x => [x.id, x.status])));
  assert.equal(tickets.find(x => x.id === 'T-0001').status, 'ready', 'the ticket is not left marked running');
  await fs.rm(temp, { recursive: true, force: true });
});

test('a cancelled run (Ctrl-C, stop --all) stops the loop with nothing synced, salvaged or reviewed', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready'), tk('T-2', 'ready', { after: ['T-1'] })], fail: { run: () => ({ status: 'failed', stage: 'run', runId: 'run-2', reason: 'run cancelled' }) } });
  const out = await scopeLoop({ deps: f.deps });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /was cancelled; its tickets stay running/);
  assert.equal(f.calls.some(c => ['sync', 'salvage', 'review'].includes(c[0])), false);
  assert.equal(f.t[0].status, 'running');
});

test('a step that throws ends the loop with a named reason and the summary, never an unhandled error', async () => {
  const sync = fake({ tickets: [tk('T-1', 'ready')] });
  sync.deps.sync = async () => { throw new Error('run run-2 is not integrated yet; run swarm integrate run-2 first'); };
  const a = await scopeLoop({ deps: sync.deps });
  assert.equal(a.status, 'failed');
  assert.match(a.reason, /not integrated yet/);
  assert.ok(a.summary);
  const cap = fake({ tickets: [tk('T-1', 'ready')], review: () => 'Run: swarm run .swarm/security-reviews/x.json' });
  cap.deps.review = async () => { throw Object.assign(new Error('project-cap: this project has spent $5.00'), { code: 'project-cap' }); };
  const b = await scopeLoop({ deps: cap.deps });
  assert.equal(b.status, 'cap');
  const record = fake({ tickets: [tk('T-1', 'ready')], review: () => 'Run: swarm run .swarm/acceptance-reviews/x.json' });
  record.deps.record = async () => { throw new Error('acceptance review refused'); };
  assert.equal((await scopeLoop({ deps: record.deps })).status, 'failed');
  assert.equal(record.calls.filter(c => c[0] === 'review').length, 1, 'a refused record does not re-run paid reviews');
});

test('a cap is recognised by its code, and the stop marker between steps ends the loop before a paid review', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready')], fail: { run: () => ({ status: 'failed', stage: 'run', runId: null, reason: 'the run could not start', code: 'spend-cap' }) } });
  assert.equal((await scopeLoop({ deps: f.deps })).status, 'cap');
  const g = fake({ tickets: [tk('T-1', 'ready')], review: () => 'Run: swarm run .swarm/security-reviews/x.json' });
  let sinceSync = false;
  const realSync = g.deps.sync;
  g.deps.sync = async (...a) => { const r = await realSync(...a); sinceSync = a[1].integrated; return r; };
  g.deps.stopped = async () => (sinceSync ? 'stopped: swarm stop --all ran at T' : null);
  const out = await scopeLoop({ deps: g.deps });
  assert.equal(out.status, 'stopped');
  assert.equal(g.calls.some(c => c[0] === 'review'), false, 'no paid review after the stop marker');
});

test('the review file is named from the wave run, not from the text the sync printed; max-waves and paused both exit 75', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready')], review: (runId, calls) => (calls.some(c => c[0] === 'review') ? 'done' : 'Run: swarm run .swarm/security-reviews/other-run.json') });
  f.deps.review = async (kind, file) => { f.calls.push(['review', kind, file]); return { runId: 'rv-1' }; };
  await scopeLoop({ deps: f.deps });
  const asked = f.calls.find(c => c[0] === 'review');
  assert.match(asked[2], /^\.swarm\/security-reviews\/run-\d+\.json$/);
  // Text that names a path outside the two review folders asks for nothing.
  const g = fake({ tickets: [tk('T-1', 'ready')], review: () => 'Run: swarm run .swarm/security-reviews/../../etc/x.json' });
  await scopeLoop({ deps: g.deps });
  assert.equal(g.calls.some(c => c[0] === 'review'), false);
  assert.equal(loopExitCode('max-waves'), 75);
  assert.equal(loopExitCode('paused'), 75);
  assert.equal(loopExitCode('no-progress'), 1);
});

test('the last allowed wave finishing every ticket is complete, not max-waves; an unexpected throw still gives a summary', async () => {
  const f = fake({ tickets: [tk('T-1', 'ready')] });
  const out = await scopeLoop({ deps: f.deps, maxWaves: 1 });
  assert.equal(out.status, 'complete');
  const g = fake({ tickets: [tk('T-1', 'ready')], fail: { run: () => ({ status: 'failed', stage: 'run', runId: null, reason: 'x' }) } });
  g.deps.revert = async () => { throw new Error('ledger is locked'); };
  const thrown = await scopeLoop({ deps: g.deps });
  assert.equal(thrown.status, 'failed');
  assert.match(thrown.reason, /ledger is locked/);
  assert.ok(thrown.summary, 'the summary is still given');
});
