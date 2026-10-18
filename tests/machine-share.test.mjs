// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLanes, LaneScheduler, claimLaneSlots, releaseLaneSlots, machineConcurrency, machineAllowance, withLaneStore, clearMachineDemand } from '../tools/lanes.mjs';
import { workersHeld, boardSnapshot } from '../tools/board-data.mjs';
import { createBoardApi } from '../tools/watch-cli.mjs';
import { projectId } from '../tools/projects.mjs';

const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'share-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const claim = (dir, project, count, max = 4, agent = 'anthropic') => claimLaneSlots({ dir, agent, concurrency: 64, count, runId: `run-${project}`, machine: { max, project } });
const held = async dir => { const s = JSON.parse(await fs.readFile(path.join(dir, 'lanes.json'), 'utf8')); const by = {}; for (const slots of Object.values(s.slots)) for (const slot of slots) by[slot.project] = (by[slot.project] ?? 0) + 1; return by; };

test('machineConcurrency: no limit by default, a whole number 1 to 2048, anything else is an error (never "no limit")', () => {
  assert.equal(machineConcurrency({}), null);
  assert.equal(machineConcurrency({ machineConcurrency: 12 }), 12);
  for (const bad of [0, -1, 1.5, '8', null, 5000, NaN]) assert.throws(() => machineConcurrency({ machineConcurrency: bad }), /machineConcurrency must be a whole number from 1 to 2048/, String(bad));
});

test('a lone project may use the whole machine limit (idle capacity is not wasted)', async t => {
  const dir = await tmp(t);
  assert.equal((await claim(dir, 'A', 10)).granted.length, 4);
  assert.deepEqual(await held(dir), { A: 4 });
});

test('two projects at once share the limit fairly: each gets its half, neither can starve the other, and freed workers go to whoever is under its share', async t => {
  const dir = await tmp(t);
  // A takes everything while B is not there.
  const a1 = await claim(dir, 'A', 10);
  assert.equal(a1.granted.length, 4);
  // B arrives and asks: nothing is free, but it is now waiting (its share is reserved).
  const b1 = await claim(dir, 'B', 10);
  assert.equal(b1.granted.length, 0);
  assert.equal(b1.reason, 'machine-full');
  // A frees two workers and asks again at once: B's reserved half is not A's to take.
  await releaseLaneSlots({ dir, slots: a1.granted.slice(0, 2).map(slotId => ({ agent: 'anthropic', slotId })) });
  const a2 = await claim(dir, 'A', 10);
  assert.equal(a2.granted.length, 0, 'A already holds its half; the free workers are B\'s');
  const b2 = await claim(dir, 'B', 10);
  assert.equal(b2.granted.length, 2);
  assert.deepEqual(await held(dir), { A: 2, B: 2 });
  // B is done: its share is free to A again.
  await releaseLaneSlots({ dir, slots: b2.granted.map(slotId => ({ agent: 'anthropic', slotId })) });
  await clearMachineDemand({ dir, project: 'B', runId: 'run-B' });
  assert.equal((await claim(dir, 'A', 10)).granted.length, 2);
  assert.deepEqual(await held(dir), { A: 4 });
});

test('three projects: shares of the limit divided by the active ones, the total never above the limit, and nobody is starved', async t => {
  const dir = await tmp(t);
  const total = async () => Object.values(await held(dir)).reduce((sum, n) => sum + n, 0);
  const first = await claim(dir, 'A', 10, 6);
  assert.equal(first.granted.length, 6, 'a lone project may borrow it all');
  assert.equal((await claim(dir, 'B', 10, 6)).granted.length, 0);
  assert.equal((await claim(dir, 'C', 10, 6)).granted.length, 0);
  // A gives four workers back and immediately asks for more; B and C are waiting, so the four are theirs.
  await releaseLaneSlots({ dir, slots: first.granted.slice(0, 4).map(slotId => ({ agent: 'anthropic', slotId })) });
  assert.equal((await claim(dir, 'A', 10, 6)).granted.length, 0);
  assert.equal((await claim(dir, 'B', 10, 6)).granted.length, 2);
  assert.equal((await claim(dir, 'C', 10, 6)).granted.length, 2);
  assert.deepEqual(await held(dir), { A: 2, B: 2, C: 2 });
  assert.equal(await total(), 6, 'never above the machine limit');
  // a limit smaller than the number of projects: a project that holds nothing is still entitled to one
  const tiny = await tmp(t);
  assert.equal((await claim(tiny, 'A', 5, 1)).granted.length, 1);
  assert.equal((await claim(tiny, 'B', 5, 1)).granted.length, 0);
});

test('without a machine limit nothing changes (the lane limits alone apply), and the lane limit still holds under a machine limit', async t => {
  const dir = await tmp(t);
  const free = await claimLaneSlots({ dir, agent: 'codex', concurrency: 64, count: 9, runId: 'r' });
  assert.equal(free.granted.length, 9);
  const dir2 = await tmp(t);
  const capped = await claimLaneSlots({ dir: dir2, agent: 'codex', concurrency: 2, count: 9, runId: 'r', machine: { max: 100, project: 'A' } });
  assert.equal(capped.granted.length, 2, 'the lane limit is separate and still applies');
});

test('machineAllowance: a dead process\'s or an expired waiting entry reserves nothing', () => {
  const time = 1_000_000;
  const slot = id => ({ id, pid: process.pid, host: os.hostname(), runId: 'r', project: 'A' });
  const entry = extra => ({ project: 'B', runId: 'rb', agent: 'anthropic', count: 5, pid: 999999, host: os.hostname(), since: time - 100, at: time - 100, ...extra });
  const store = demand => ({ slots: { anthropic: [slot('a'), slot('b')] }, pauses: {}, demand: { k: demand } });
  assert.equal(machineAllowance({ store: store(entry()), project: 'A', count: 2, max: 4, isAlive: () => false, time }).allowed, 2, 'B\'s process is gone');
  assert.equal(machineAllowance({ store: store(entry()), project: 'A', count: 2, max: 4, isAlive: () => true, time }).allowed, 0, 'B is alive and waiting: its share is kept for it');
  assert.equal(machineAllowance({ store: store(entry({ at: time - 6000 })), project: 'A', count: 2, max: 4, isAlive: () => true, time }).allowed, 2, 'a run that stopped asking stops reserving (5 s)');
  assert.equal(machineAllowance({ store: { slots: store(entry()).slots, pauses: {}, demand: [] }, project: 'A', count: 2, max: 4, isAlive: () => true, time }).allowed, 2, 'a malformed waiting list is ignored');
});

test('more projects than workers: a freed worker goes to the project that has waited longest, not back to the one that freed it', async t => {
  const dir = await tmp(t);
  const a = await claim(dir, 'A', 1, 2), b = await claim(dir, 'B', 1, 2);
  assert.deepEqual([a.granted.length, b.granted.length], [1, 1]);
  assert.equal((await claim(dir, 'C', 1, 2)).granted.length, 0, 'C waits (since now)');
  await releaseLaneSlots({ dir, slots: a.granted.map(slotId => ({ agent: 'anthropic', slotId })) });
  assert.equal((await claim(dir, 'A', 1, 2)).granted.length, 0, 'A freed it and asks again: C has waited longer');
  assert.equal((await claim(dir, 'C', 1, 2)).granted.length, 1);
  assert.deepEqual(await held(dir), { B: 1, C: 1 });
});

test('waiting entries are per run and lane: a sibling run of the same project is neither overwritten nor cleared by another\'s close', async t => {
  const dir = await tmp(t);
  await claim(dir, 'A', 10, 2);                        // A takes both
  await claimLaneSlots({ dir, agent: 'anthropic', concurrency: 64, count: 4, runId: 'run-B1', machine: { max: 2, project: 'B' } });
  await claimLaneSlots({ dir, agent: 'codex', concurrency: 64, count: 3, runId: 'run-B2', machine: { max: 2, project: 'B' } });
  const store = JSON.parse(await fs.readFile(path.join(dir, 'lanes.json'), 'utf8'));
  const ofB = Object.values(store.demand).filter(e => e.project === 'B');
  assert.equal(ofB.length, 2, 'one entry per run and lane');
  assert.deepEqual(ofB.map(e => e.count).sort(), [3, 4]);
  await clearMachineDemand({ dir, project: 'B', runId: 'run-B1' });
  const after = JSON.parse(await fs.readFile(path.join(dir, 'lanes.json'), 'utf8'));
  assert.deepEqual(Object.values(after.demand).filter(e => e.project === 'B').map(e => e.runId), ['run-B2'], 'only the closing run\'s entry is cleared');
});

test('a lane pause, a full lane and a closed run do not leave a share reserved for ever (the entry is only for what the machine, not the lane, holds back)', async t => {
  const dir = await tmp(t);
  // The lane's own limit is 1; the job waits for the LANE, not for the machine: nothing is reserved.
  await claimLaneSlots({ dir, agent: 'codex', concurrency: 1, count: 1, runId: 'r1', machine: { max: 4, project: 'A' } });
  await claimLaneSlots({ dir, agent: 'codex', concurrency: 1, count: 3, runId: 'r1', machine: { max: 4, project: 'A' } });
  const store = JSON.parse(await fs.readFile(path.join(dir, 'lanes.json'), 'utf8'));
  assert.deepEqual(store.demand ?? {}, {}, 'lane-limited jobs are not a claim on the machine');
});

test('two schedulers (two projects) with the same machine limit never run more than the limit together, and both make progress', async t => {
  const dir = await tmp(t);
  const lanes = resolveLanes({ manifest: { lanes: { anthropic: { concurrency: 64 } } } });
  const make = project => new LaneScheduler({ lanes, globalConcurrency: 16, shared: { dir, runId: `run-${project}`, machine: { max: 4, project } } });
  const A = make('A'), B = make('B');
  t.after(async () => { await A.close(); await B.close(); });
  let running = 0, peak = 0;
  const done = { A: 0, B: 0 };
  const worker = async (scheduler, project) => {
    const release = await scheduler.acquire('anthropic');
    running += 1; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 30));
    running -= 1; done[project] += 1;
    await release();
  };
  await Promise.all([...Array.from({ length: 10 }, () => worker(A, 'A')), ...Array.from({ length: 10 }, () => worker(B, 'B'))]);
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.deepEqual(done, { A: 10, B: 10 });
});

test('which project holds which workers: from the shared store, by project and lane, live processes only', async t => {
  const dir = await tmp(t);
  await claim(dir, 'proj-a', 3, 10, 'anthropic');
  await claim(dir, 'proj-a', 1, 10, 'codex');
  await claim(dir, 'proj-b', 2, 10, 'cursor');
  await claim(dir, 'proj-b', 4, 10, 'cursor');   // waits (demand recorded) only when it cannot take them; here it can
  const held = await workersHeld({ dir, max: 10 });
  assert.equal(held.total, 10);
  assert.deepEqual(held.byProject['proj-a'], { total: 4, byLane: { 'Anthropic API': 3, Codex: 1 } });
  assert.deepEqual(held.byProject['proj-b'], { total: 6, byLane: { Cursor: 6 } });
  assert.equal(held.free, 0);
  // a slot of a dead process is not counted
  const gone = await workersHeld({ dir, max: 10, isAlive: () => false });
  assert.equal(gone.total, 0);
  // demand is shown while a project waits
  await claim(dir, 'proj-c', 3, 10);
  const waiting = await workersHeld({ dir, max: 10 });
  assert.equal(waiting.demand['proj-c'], 3);
  assert.deepEqual(await workersHeld({ dir: path.join(dir, 'nowhere') }), { max: null, total: 0, free: null, byProject: {}, demand: {} });
});

test('the board shows the machine limit and who holds the workers, and the numbers of one project never include another\'s', async t => {
  const home = await tmp(t);
  const lanesDirPath = path.join(home, 'lanes');
  const A = path.join(home, 'app-a'), B = path.join(home, 'app-b');
  for (const r of [A, B]) await fs.mkdir(r);
  const [pa, pb] = [projectId(A), projectId(B)];
  await claim(lanesDirPath, pa, 2, 8, 'codex');
  await claim(lanesDirPath, pb, 1, 8, 'anthropic');
  const env = { SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_LANES_DIR: lanesDirPath, SWARM_CONFIG: path.join(home, 'config.json') };
  await fs.writeFile(env.SWARM_CONFIG, JSON.stringify({ machineConcurrency: 8 }));
  await fs.writeFile(env.SWARM_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ id: pa, root: A, name: 'app-a', addedAt: 'x', lastSeen: 'x' }, { id: pb, root: B, name: 'app-b', addedAt: 'x', lastSeen: 'x' }] }));
  const api = createBoardApi({ env, live: async () => [], cacheMs: 0 });
  const snap = await api.snapshot();
  assert.equal(snap.machine.workers.max, 8);
  assert.equal(snap.machine.workers.invalid, undefined);
  assert.equal(snap.machine.workers.total, 3);
  assert.deepEqual(snap.machine.workers.byProject[pa], { total: 2, byLane: { Codex: 2 } });
  assert.deepEqual(snap.machine.workers.byProject[pb], { total: 1, byLane: { 'Anthropic API': 1 } });
  const js = await fs.readFile(new URL('../tools/watch-assets/board.js', import.meta.url), 'utf8');
  assert.match(js, /Workers held/);
  assert.match(js, /shared fairly between active projects/);
});

test('two projects running at once (real runs) share a machine limit of 2, finish, and stay isolated: each run, output and state is its own project\'s', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { runManifest } = await import('../tools/swarm.mjs');
  const exec = promisify(execFile);
  const home = await tmp(t);
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ machineConcurrency: 2 }));
  const env = { ...process.env, SWARM_CONFIG: path.join(home, 'config.json'), SWARM_SPEND_DIR: path.join(home, 'spend'), SWARM_LANES_DIR: path.join(home, 'lanes') };
  const repo = async name => {
    const root = path.join(home, name); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'input.txt'), `${name}\n`); await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
    await exec('git', ['init', '-q', root]); await exec('git', ['-C', root, 'add', '.']); await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e.i', 'commit', '-qm', 'i']);
    return root;
  };
  const [one, two] = [await repo('one'), await repo('two')];
  let running = 0, peak = 0;
  const fetchFor = name => async (_url, request) => {
    const n = /out\/(\d+)\.txt/.exec(request.body)[1];
    running += 1; peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 60));
    running -= 1;
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 }, message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `${name}-${n}\\n` }] }) } }), { headers: { 'content-type': 'application/json' } });
  };
  const manifest = { version: 1, concurrency: 4, lanes: { ollama: { concurrency: 8 } }, jobs: Array.from({ length: 4 }, (_, n) => ({ id: `job-${n}`, agent: 'ollama', model: 'm', prompt: `Write out/${n}.txt`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 20000 })) };
  const run = (root, name) => runManifest(root, manifest, { root, env, liveDir: path.join(home, `live-${name}`), fetchImpl: fetchFor(name) });
  const [a, b] = await Promise.all([run(one, 'one'), run(two, 'two')]);
  assert.equal(a.status, 'complete', a.error);
  assert.equal(b.status, 'complete', b.error);
  assert.ok(peak <= 2, `at most 2 workers on the machine at once (saw ${peak})`);
  for (const [root, state, name] of [[one, a, 'one'], [two, b, 'two']]) {
    assert.equal(state.root, await fs.realpath(root), 'the run knows only its own project');
    for (const j of state.jobs) assert.ok((await fs.readFile(path.join(root, j.workspace, j.outputs[0]), 'utf8')).startsWith(name), `${name}'s output is ${name}'s`);
  }
  assert.ok(!(await fs.readdir(path.join(one, '.swarm/runs'))).includes(b.id), 'project one has no trace of project two\'s run');
  assert.ok(!(await fs.readdir(path.join(two, '.swarm/runs'))).includes(a.id));
  const store = JSON.parse(await fs.readFile(path.join(home, 'lanes', 'lanes.json'), 'utf8').catch(() => '{"slots":{}}'));
  assert.deepEqual(Object.values(store.slots).flat(), [], 'every worker slot was given back');
});

test('review fixes: an invalid limit is shown as such on the board, and a malformed waiting list never stops a run', async t => {
  const home = await tmp(t);
  const env = { SWARM_PROJECTS_FILE: path.join(home, 'projects.json'), SWARM_LANES_DIR: path.join(home, 'lanes'), SWARM_CONFIG: path.join(home, 'config.json') };
  await fs.writeFile(env.SWARM_CONFIG, JSON.stringify({ machineConcurrency: 'lots' }));
  const api = createBoardApi({ env, live: async () => [], cacheMs: 0 });
  assert.equal((await api.snapshot()).machine.workers.invalid, true);
  const dir = path.join(home, 'lanes'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'lanes.json'), JSON.stringify({ version: 1, slots: {}, pauses: {}, demand: ['junk'] }));
  assert.equal((await claim(dir, 'A', 2, 4)).granted.length, 2, 'the junk waiting list is reset, the claim goes through');
  await fs.writeFile(path.join(dir, 'lanes.json'), JSON.stringify({ version: 1, slots: {}, pauses: {}, demand: { x: { count: 'many' }, y: null } }));
  assert.equal((await claim(dir, 'A', 2, 4)).granted.length, 2);
});
