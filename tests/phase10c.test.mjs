// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, validateManifest } from '../tools/swarm.mjs';
import { liftHumanJobs, readStore, validateHumanJob } from '../tools/human-jobs.mjs';
import { runInboxCommand } from '../tools/inbox-commands.mjs';
import { autopilotStep } from '../tools/autopilot.mjs';
import { readJournal } from '../tools/journal.mjs';

const exec = promisify(execFile);
const env = { SWARM_CONFIG: process.env.SWARM_CONFIG };
const reply = n => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `o${n}\n` }] }) } }), { headers: { 'content-type': 'application/json' } });
const job = (id, extra = {}) => ({ id, agent: 'ollama', model: 'm', prompt: `Write out/${id}.txt`, context: ['input.txt'], outputs: [`out/${id}.txt`], timeoutMs: 5000, ...extra });
const human = (id, extra = {}) => ({ id, type: 'human', title: `Do ${id}`, steps: ['open the console', 'paste the key'], ...extra });
const fetchImpl = async (url, options) => reply(/out\/([\w-]+)\.txt/.exec(options.body)[1]);

async function repo(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-p10c-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  env.SWARM_SPEND_DIR = path.join(root, '.swarm/spend');
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'f']);
  return root;
}

test('human jobs are shape-checked and lifted out with their blocked jobs', () => {
  assert.throws(() => validateHumanJob({ id: 'h', type: 'human', title: '', steps: ['a'] }), /title/);
  assert.throws(() => validateHumanJob({ id: 'h', type: 'human', title: 't', steps: [] }), /steps/);
  assert.throws(() => validateHumanJob({ id: 'h', type: 'human', title: 't', steps: ['a'], agent: 'codex' }), /may not set agent/);
  const m = { version: 1, jobs: [job('a'), human('key'), job('b', { after: ['key'] }), job('c', { after: ['b', 'a'] }), job('d')] };
  validateManifest(structuredClone(m));
  const lifted = liftHumanJobs(m);
  assert.deepEqual(lifted.run.jobs.map(j => j.id), ['a', 'd']);
  assert.deepEqual(lifted.deferred.jobs.map(j => [j.id, j.after]), [['b', undefined], ['c', ['b']]]);
  assert.equal(lifted.humans[0].unblocks, 2);
  assert.deepEqual(lifted.edges, { b: ['key'], c: ['b', 'a'] });
  assert.equal(liftHumanJobs({ version: 1, jobs: [job('a')] }).deferred, null);
});

test('a run finishes everything that does not depend on a human job; the inbox lists it; done + autopilot start the rest', async t => {
  const root = await repo(t);
  const m = { version: 1, concurrency: 4, jobs: [job('a'), human('key'), job('b', { after: ['key'] }), job('d')] };
  const state = await runManifest(root, m, { env, fetchImpl, id: 'run-h1' });
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs.map(j => [j.id, j.status]), [['a', 'complete'], ['d', 'complete']]);
  assert.deepEqual(state.humanJobs, ['key']);

  const listed = await runInboxCommand(root, 'inbox', []);
  assert.equal(listed.exitCode, 0);
  assert.match(listed.stdout, /run-h1:key/);
  assert.match(listed.stdout, /unblocks 1/);
  assert.match(listed.stdout, /swarm done run-h1:key/);
  assert.equal(JSON.parse((await runInboxCommand(root, 'inbox', ['--json'])).stdout)[0].unblocks, 1);

  const started = [];
  const deps = {
    loadRuns: async () => [{ id: 'run-h1', status: 'complete', integrated: false }],
    readJournal: r => readJournal(r),
    appendEvent: async () => {},
    readPlan: async () => null,
    checkout: async () => ({ branch: 'swarm/x', dirty: false }),
    integrate: async () => ({ files: 2 }),
    resume: async () => {}, retryFailed: async () => ({}), startWave: async () => ({}),
    humanGroups: async r => (await readStore(r)).groups.map(g => ({ id: g.id, humans: g.humans, started: Boolean(g.started), hasDeferred: Boolean(g.deferred), runless: false })),
    startDeferred: async (r, group) => { started.push(group.id); return { run: 'run-h2', status: 'complete' }; },
  };
  // the human job is not done yet: nothing starts
  await autopilotStep(root, deps, { now: () => Date.now(), memory: new Set() });
  assert.deepEqual(started, []);

  assert.equal((await runInboxCommand(root, 'done', ['run-h1:nope'])).exitCode, 1);
  const done = await runInboxCommand(root, 'done', ['run-h1:key']);
  assert.equal(done.exitCode, 0);
  assert.equal((await runInboxCommand(root, 'done', ['run-h1:key'])).exitCode, 1, 'already done');
  assert.match((await runInboxCommand(root, 'inbox', [])).stdout, /Nothing needs you/);

  // done, but integration of the run that held it fails: nothing starts
  const realIntegrate = deps.integrate;
  deps.integrate = async () => { throw new Error('conflict'); };
  await autopilotStep(root, deps, { now: () => Date.now(), memory: new Set() });
  assert.deepEqual(started, []);
  deps.integrate = realIntegrate;
  const memory = new Set();
  const step = await autopilotStep(root, deps, { now: () => Date.now(), memory });
  assert.deepEqual(started, ['run-h1']);
  assert.ok(step.actions.some(a => a.action === 'start-deferred' && a.ok));
  await autopilotStep(root, deps, { now: () => Date.now(), memory });
  assert.deepEqual(started, ['run-h1'], 'never started twice');
});

test('a manifest of only human jobs and their dependents starts nothing and waits', async t => {
  const root = await repo(t);
  const state = await runManifest(root, { version: 1, jobs: [human('key'), job('b', { after: ['key'] })] }, { env, fetchImpl, id: 'run-h3' });
  assert.equal(state.status, 'paused');
  assert.deepEqual(state.pause.reasons, ['human']);
  assert.equal((await readStore(root)).groups[0].deferred.jobs[0].id, 'b');
});

test('decisions: record a default, confirm it, or change it into a backlog goal', async t => {
  const root = await repo(t);
  const rec = await runInboxCommand(root, 'decision', ['Use SQLite?', '--choice', 'yes', '--option', 'no', '--id', 'db']);
  assert.equal(rec.exitCode, 0);
  assert.match((await runInboxCommand(root, 'inbox', [])).stdout, /swarm decide db yes/);
  assert.equal((await runInboxCommand(root, 'decide', ['db', 'maybe'])).exitCode, 1);
  const changed = await runInboxCommand(root, 'decide', ['db', 'no']);
  assert.match(changed.stdout, /backlog: Change decision db to no/);
  assert.match((await runInboxCommand(root, 'backlog', [])).stdout, /Change decision db to no/);
  assert.match((await runInboxCommand(root, 'inbox', [])).stdout, /Nothing needs you/);
  await runInboxCommand(root, 'decision', ['Name?', '--choice', 'a', '--id', 'nm']);
  assert.doesNotMatch((await runInboxCommand(root, 'decide', ['nm', 'a'])).stdout, /backlog/);
});

test('backlog commands add, list and remove; bad input exits 1', async t => {
  const root = await repo(t);
  assert.match((await runInboxCommand(root, 'backlog', [])).stdout, /empty/);
  const added = await runInboxCommand(root, 'backlog', ['add', 'Build the thing', '--paths', 'src/,docs/', '--max-usd', '2']);
  assert.equal(added.exitCode, 0);
  const id = /queued: (\S+)/.exec(added.stdout)[1];
  assert.match((await runInboxCommand(root, 'backlog', [])).stdout, /Build the thing \(paths: src, docs\)/);
  assert.equal((await runInboxCommand(root, 'backlog', ['add', 'x', '--max-usd', '-1'])).exitCode, 1);
  assert.equal((await runInboxCommand(root, 'backlog', ['remove', 'nope'])).exitCode, 1);
  assert.equal((await runInboxCommand(root, 'backlog', ['remove', id])).exitCode, 0);
  assert.equal((await runInboxCommand(root, 'inbox', ['--bogus'])).exitCode, 1);
});

const stepDeps = extra => ({
  loadRuns: async () => [{ id: 'r1', status: 'paused', pause: { reasons: ['human'] } }],
  readJournal: async () => [], appendEvent: async () => {}, readPlan: async () => null,
  checkout: async () => ({ branch: 'swarm/x', dirty: false }),
  integrate: async () => ({}), resume: async () => {}, retryFailed: async () => ({}), startWave: async () => ({}),
  ...extra,
});

test('autopilot waits on a human-paused run and starts one backlog goal while everything is waiting', async t => {
  const calls = [];
  const deps = stepDeps({ nextBacklog: async () => ({ id: 'g1', goal: 'next' }), startBacklog: async (r, item) => { calls.push(item.id); return { run: 'r9', status: 'running' }; }, notify: async () => { calls.push('notify'); } });
  const memory = new Set();
  const step = await autopilotStep('/x', deps, { now: () => 1, memory });
  assert.deepEqual(step.actions.map(a => a.action), ['start-backlog']);
  assert.deepEqual(calls, ['g1', 'notify']);
  await autopilotStep('/x', deps, { now: () => 1, memory });
  assert.deepEqual(calls.filter(c => c === 'g1'), ['g1'], 'once');
  // a running run, or an unsafe checkout, means no backlog start
  for (const extra of [{ loadRuns: async () => [{ id: 'r1', status: 'paused', pause: { reasons: ['human'] } }, { id: 'r2', status: 'running' }] }, { checkout: async () => ({ branch: 'main', dirty: false }) }]) {
    const quiet = await autopilotStep('/x', stepDeps({ nextBacklog: async () => ({ id: 'g2' }), startBacklog: async () => assert.fail('must not start'), ...extra }), { now: () => 1, memory: new Set() });
    assert.deepEqual(quiet.actions, []);
  }
  const failing = await autopilotStep('/x', stepDeps({ nextBacklog: async () => ({ id: 'g3', goal: 'x' }), startBacklog: async () => { throw new Error('boom'); } }), { now: () => 1, memory: new Set() });
  assert.equal(failing.actions[0].ok, false);
});

test('a notifier that throws never stops autopilot', async () => {
  const step = await autopilotStep('/x', stepDeps({ notify: async () => { throw new Error('osascript'); } }), { now: () => 1, memory: new Set() });
  assert.ok(Array.isArray(step.actions));
});

test('review fixes: deferred starts are gated and blocked on failure; double validation; ids; claims', async t => {
  // validating a manifest twice does not trip over the fields validateManifest fills in
  const m = { version: 1, jobs: [job('a'), human('key'), job('b', { after: ['key'] })] };
  validateManifest(m);
  validateManifest(m);

  const group = { id: 'g1', humans: [{ id: 'k', done: true }], started: false, hasDeferred: true, runless: true };
  const base = { loadRuns: async () => [], readJournal: async () => [], appendEvent: async () => {}, readPlan: async () => null, integrate: async () => ({}), resume: async () => {}, retryFailed: async () => ({}), startWave: async () => ({}), humanGroups: async () => [group] };
  const blockedOn = [];
  const writes = [];
  const run = extra => autopilotStep('/x', { ...base, appendEvent: async (_r, e) => { writes.push(e); }, ...extra }, { now: () => 1, memory: new Set() });
  // dirty tree or main: nothing starts
  for (const checkout of [{ branch: 'main', dirty: false }, { branch: 'swarm/x', dirty: true }]) {
    const step = await run({ checkout: async () => checkout, startDeferred: async () => assert.fail('must not start') });
    assert.deepEqual(step.actions, []);
  }
  // a running run: nothing starts
  assert.deepEqual((await run({ loadRuns: async () => [{ id: 'r', status: 'running' }], checkout: async () => ({ branch: 'swarm/x', dirty: false }), startDeferred: async () => assert.fail('must not start') })).actions, []);
  // a failing start becomes a blocker, never silent
  const failed = await run({ checkout: async () => ({ branch: 'swarm/x', dirty: false }), startDeferred: async () => { throw new Error('boom'); } });
  assert.equal(failed.actions[0].ok, false);
  assert.ok(writes.some(e => e.kind === 'blocker' && e.id === 'deferred-g1'), blockedOn.join());

  // a run paused on a spend cap is not idle time for the backlog
  const capped = await autopilotStep('/x', stepDeps({ loadRuns: async () => [{ id: 'r1', status: 'paused', pause: { reasons: ['run-cap'] } }], nextBacklog: async () => ({ id: 'g' }), startBacklog: async () => assert.fail('must not start') }), { now: () => 1, memory: new Set() });
  assert.deepEqual(capped.actions, []);
  // an open human task counts as waiting even when no run is paused
  const open = await autopilotStep('/x', stepDeps({ loadRuns: async () => [], humanGroups: async () => [{ id: 'h', humans: [{ done: false }], started: false }], nextBacklog: async () => ({ id: 'g4', goal: 'x' }), startBacklog: async () => ({ run: 'r5' }) }), { now: () => 1, memory: new Set() });
  assert.deepEqual(open.actions.map(a => a.action), ['start-backlog']);
});

test('decision ids are validated and unique; a second start of a group is refused; inbox close commands name other projects', async t => {
  const root = await repo(t);
  assert.equal((await runInboxCommand(root, 'decision', ['Q?', '--choice', 'a', '--id', '../x'])).exitCode, 1);
  assert.equal((await runInboxCommand(root, 'decision', ['Q?', '--choice', 'a', '--id', 'dd'])).exitCode, 0);
  assert.equal((await runInboxCommand(root, 'decision', ['Q?', '--choice', 'a', '--id', 'dd'])).exitCode, 1);
  const { formatInbox } = await import('../tools/inbox.mjs');
  const text = formatInbox([{ id: 'x:y', kind: 'human', project: '/other', title: 't', steps: [], unblocks: 1, since: new Date().toISOString() }], { now: Date.now(), root });
  assert.match(text, /swarm --root \/other done x:y/);
  const { addGroup, updateGroup } = await import('../tools/human-jobs.mjs');
  await addGroup(root, { id: 'gg', humans: [], deferred: null });
  await updateGroup(root, 'gg', g => { g.started = { run: null }; });
  await assert.rejects(updateGroup(root, 'gg', g => { if (g.started) throw new Error('human-group-not-startable'); }), /not-startable/);
});
