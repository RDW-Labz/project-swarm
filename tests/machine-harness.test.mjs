// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireBrainLock, addMachine, emptyRegistry, failoverOrder, machinesFile, nextBrain,
  readRegistry, releaseBrainLock, removeMachine, setBrain, writeRegistry,
} from '../tools/machine-registry.mjs';
import { parseFreeDiskKb, parsePmsetBattery, parsePmsetTherm, parseRemoteProbe, parseSleepSettings, measuredOnly } from '../tools/machine-probe.mjs';
import { buildLaneCommand, detectLaneOutcome, laneLoginHint, WORKER_LANE_NAMES } from '../tools/lane-plugins.mjs';
import {
  claimWorkerItem, diskGuard, enqueueManifest, listWorkerItems, nextWorkerItem, releaseExpiredWorkerItems, reportWorkerItem, workerQueueFile,
} from '../tools/worker-queue.mjs';
import { createSshTransport, executeItem, ghostGate, ghostState, slotsForMachine, workerPaths } from '../tools/worker-runner.mjs';
import { buildMachineView, registryHintText } from '../tools/machine-view.mjs';
import { snapshotProjectState, restoreProjectState } from '../tools/state-sync.mjs';
import { runBench } from '../tools/worker-bench.mjs';
import { ensureWorkerKey, failoverDecision, listMachines, parseTarget, doctorLines, runBrainMove, runMachineAdd, runWorkerCommand, updateSshConfigForMachine } from '../tools/machine-commands.mjs';

const tmp = async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'machine-harness-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const machine = (name, extra = {}) => ({ name, role: 'worker', host: `${name}.local`, user: 'prime', os: 'macos', ramGb: 16, cores: 8, slots: 4, lanes: ['claude', 'codex'], health: 'ok', freeDiskGb: 90, ...extra });

test('registry adds, updates, moves the brain and removes machines', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'machines.json');
  await addMachine(machine('mini', { role: 'brain' }), { file, brain: true });
  await addMachine(machine('bean'), { file });
  let registry = await readRegistry({ file });
  assert.equal(registry.brain, 'mini');
  assert.deepEqual(failoverOrder(registry).slice(0, 3), ['mini', 'bean']);
  await setBrain('bean', { file });
  registry = await readRegistry({ file });
  assert.equal(registry.brain, 'bean');
  assert.equal(registry.machines.mini.role, 'worker');
  assert.equal(registry.machines.bean.role, 'brain');
  const removed = await removeMachine('bean', { file });
  assert.equal(removed.removed, true);
  registry = await readRegistry({ file });
  assert.equal(registry.brain, 'mini');
});

test('brain lock is exclusive and stale locks are reclaimed', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'brain.lock');
  await acquireBrainLock({ file, machine: 'mini', now: 1000, staleMs: 50 });
  await assert.rejects(() => acquireBrainLock({ file, machine: 'mini', now: 1020, staleMs: 50 }), { code: 'brain-locked' });
  const reclaimed = await acquireBrainLock({ file, machine: 'bean', now: 2000, staleMs: 50 });
  assert.equal(reclaimed.acquired, true);
  assert.equal(await releaseBrainLock({ file, machine: 'mini' }), false);
  assert.equal(await releaseBrainLock({ file, machine: 'bean' }), true);
});

test('failover follows the registry order and ignores a live brain', () => {
  const registry = { version: 1, brain: 'mini', order: ['mini', 'bean', 'ghost'], machines: { mini: machine('mini', { role: 'brain' }), bean: machine('bean'), ghost: machine('ghost') } };
  assert.equal(nextBrain(registry), 'bean');
  assert.deepEqual(failoverDecision({ registry, heartbeats: { mini: 1000 }, now: 1200, silentMs: 500 }), { action: 'none', brain: 'mini' });
  assert.deepEqual(failoverDecision({ registry, heartbeats: { mini: 1000 }, now: 2000, silentMs: 500 }), { action: 'move', from: 'mini', to: 'bean', reason: 'brain mini silent for 1s' });
});

test('probe parsers keep only measured values', () => {
  assert.equal(parseFreeDiskKb('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 10 700 2% /\n'), 700);
  assert.deepEqual(parsePmsetBattery('Now drawing from \'AC Power\'\n -InternalBattery-0 80%; charging;'), { onCharger: true, batteryPercent: 80 });
  assert.deepEqual(parsePmsetTherm('CPU_Speed_Limit = 100\nCPU_Scheduler_Limit = 90'), { cpuSpeedLimit: 100, cpuSchedulerLimit: 90, throttled: true });
  assert.deepEqual(parseSleepSettings('disablesleep 1\n sleep 0'), { disablesleep: true, sleepMinutes: 0 });
  assert.deepEqual(parseRemoteProbe('host=bean\nramGb=16\nlanes=claude\nlane=codex\nfileVault=false\nrunner=running\n'), { host: 'bean', ramGb: 16, lanes: ['codex'], fileVault: false, runner: 'running' });
  assert.deepEqual(measuredOnly({ a: 1, b: undefined, c: [], d: '' }), { a: 1 });
});

test('worker lane plugins build the right commands and detect limits', () => {
  assert.deepEqual(WORKER_LANE_NAMES, ['claude', 'codex', 'gemini', 'opencode', 'cursor']);
  assert.deepEqual(buildLaneCommand({ lane: 'claude', prompt: 'do it' }), { command: 'claude', args: ['-p', 'do it'] });
  assert.deepEqual(buildLaneCommand({ lane: 'codex', prompt: 'do it' }), { command: 'codex', args: ['exec', 'do it'] });
  assert.deepEqual(buildLaneCommand({ lane: 'gemini', prompt: 'do it' }), { command: 'gemini', args: ['-p', 'do it'] });
  assert.deepEqual(buildLaneCommand({ lane: 'opencode', prompt: 'do it', model: 'deepseek/deepseek-chat' }), { command: 'opencode', args: ['run', '-m', 'deepseek/deepseek-chat', 'do it'] });
  assert.deepEqual(buildLaneCommand({ lane: 'cursor', prompt: 'do it' }), { command: 'cursor-agent', args: ['-p', 'do it'] });
  assert.equal(detectLaneOutcome({ lane: 'claude', exitCode: 1, stderr: 'You have hit your usage limit; resets soon' }).state, 'rate-limited');
  assert.equal(detectLaneOutcome({ lane: 'codex', exitCode: 1, stderr: 'not logged in' }).state, 'logged-out');
  assert.equal(detectLaneOutcome({ lane: 'gemini', exitCode: 0 }).state, 'ok');
  assert.match(laneLoginHint('opencode'), /auth login/);
});

test('worker queue is idempotent, leases expire, and reports close items', async t => {
  const dir = await tmp(t);
  const file = workerQueueFile({ env: {}, home: dir });
  const manifestPath = path.join(dir, 'batch.json');
  const manifest = { version: 1, jobs: [{ id: 'build-a', agent: 'claude', prompt: 'build a' }, { id: 'build-b', agent: 'codex', prompt: 'build b' }] };
  const first = await enqueueManifest({ manifestPath, manifest, project: 'demo', file, now: () => 1000 });
  const ids = first.added.sort();
  assert.equal(ids.length, 2);
  assert.ok(ids.some(id => id.includes('build-a-')) && ids.some(id => id.includes('build-b-')));
  const again = await enqueueManifest({ manifestPath, manifest, project: 'demo', file, now: () => 2000 });
  assert.equal(again.total, 0);
  const next = await nextWorkerItem({ lanes: ['claude'], file, now: () => 3000 });
  assert.equal(next.id, ids[0]);
  await claimWorkerItem(next.id, 'bean/1', { file, now: () => 3000, leaseMs: 1000 });
  await assert.rejects(() => claimWorkerItem(next.id, 'bean/2', { file, now: () => 3100 }), { code: 'worker-lease-held' });
  const released = await releaseExpiredWorkerItems({ file, now: () => 5000 });
  assert.deepEqual(released.released, [next.id]);
  const claimed = await claimWorkerItem(next.id, 'air8/1', { file, now: () => 5000, leaseMs: 5000 });
  assert.equal(claimed.lease.holder, 'air8/1');
  const report = await reportWorkerItem(next.id, 'air8/1', { status: 'done', report: { status: 'pass' }, file, now: () => 6000 });
  assert.equal(report.status, 'done');
});

test('ghost rules, slots and disk guard are enforced before work is taken', () => {
  assert.deepEqual(ghostGate({ role: 'remote+worker', onCharger: false, lidOpen: true, brainReachable: true }), { ok: false, reason: 'ghost-on-battery' });
  assert.deepEqual(ghostGate({ role: 'remote+worker', onCharger: true, lidOpen: false, brainReachable: true }), { ok: false, reason: 'ghost-lid-closed' });
  assert.deepEqual(ghostGate({ role: 'remote+worker', onCharger: true, lidOpen: true, brainReachable: true }), { ok: true, reason: 'ghost-ready' });
  assert.equal(ghostState({ role: 'remote+worker', onCharger: false, lidOpen: true, brainReachable: true }), 'away');
  assert.equal(ghostState({ role: 'remote+worker', onCharger: true, lidOpen: true, brainReachable: true, running: 1 }), 'working');
  assert.equal(slotsForMachine({ slots: 4, role: 'remote+worker', onCharger: false }), 0);
  assert.equal(slotsForMachine({ slots: 4, role: 'remote+worker', onCharger: true, userActive: true }), 1);
  assert.equal(diskGuard(19).ok, false);
  assert.equal(diskGuard(20).ok, true);
});

test('executeItem writes the manifest in an isolated worktree and reports the lane outcome', async t => {
  const dir = await tmp(t);
  const worktree = path.join(dir, 'worktree');
  await fs.mkdir(worktree, { recursive: true });
  const item = { id: 'batch.json:build-a', project: 'demo', job: 'build-a', lane: 'claude', model: null, manifestData: { version: 1, jobs: [{ id: 'build-a', agent: 'claude', prompt: 'build a' }] } };
  const paths = workerPaths(dir);
  const result = await executeItem({
    item, holder: 'bean/1', paths, runner: '/runner/swarm.mjs',
    ensure: async () => ({}),
    prepare: async () => ({ dir: worktree, branch: 'worker/bean/batch' }),
    latest: async () => ({ run: 'run-1', status: 'complete', jobs: 1, complete: 1, failed: 0, summary: { files: ['a.js'] } }),
    run: async (_command, _args, options) => {
      assert.equal(options.cwd, worktree);
      const manifest = JSON.parse(await fs.readFile(path.join(worktree, '.swarm-worker-manifest.json'), 'utf8'));
      assert.equal(manifest.jobs[0].id, 'build-a');
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.status, 'pass');
});

test('machine view keeps measured fields and hides the rest', () => {
  const registry = { version: 1, brain: 'mini', order: ['mini', 'ghost'], machines: { mini: machine('mini', { role: 'brain', freeDiskGb: 120 }), ghost: machine('ghost', { role: 'remote+worker', onCharger: false, lidOpen: true, freeDiskGb: undefined }) } };
  const view = buildMachineView({ registry, now: () => 1000 });
  assert.equal(view.brain, 'mini');
  assert.equal(view.machines[0].brain, true);
  assert.equal(view.machines[1].state, 'away');
  assert.equal('freeDiskGb' in view.machines[1], false);
  assert.match(registryHintText(view), /mini brain/);
  const docked = { ...registry, machines: { ...registry.machines, ghost: machine('ghost', { role: 'remote+worker', onCharger: true, lidOpen: true }) } };
  assert.equal(buildMachineView({ registry: docked, runningByMachine: { ghost: 1 }, now: () => 1000 }).machines[1].state, 'working');
});

test('machine list and doctor only print measured facts', async () => {
  const registry = { version: 1, brain: 'mini', order: ['mini'], machines: { mini: machine('mini', { role: 'brain', fileVault: true, runner: 'stopped' }) } };
  const text = await listMachines({ registry });
  assert.match(text, /mini/);
  assert.match(text, /macos/);
  const lines = doctorLines(registry.machines.mini);
  assert.ok(lines.some(line => /FileVault is on/.test(line)));
  assert.ok(lines.some(line => /worker runner stopped/.test(line)));
  assert.deepEqual(parseTarget('braden@bean.local'), { user: 'braden', host: 'bean' });
  assert.equal(parseTarget('not-a-target'), null);
});

test('writeRegistry refuses a corrupt brain pointer', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'machines.json');
  await assert.rejects(() => writeRegistry({ version: 1, brain: 'missing', order: [], machines: {} }, { file }), { code: 'machines-corrupt' });
  assert.deepEqual(emptyRegistry().machines, {});
});

test('machine add registers a prepped worker and is re-runnable', async t => {
  const dir = await tmp(t);
  const key = path.join(dir, 'swarm_ed25519');
  await fs.writeFile(key, 'private');
  await fs.writeFile(`${key}.pub`, 'public');
  const registryFile = path.join(dir, 'machines.json');
  await writeRegistry({ version: 1, brain: 'mini', order: ['mini'], machines: { mini: machine('mini', { role: 'brain' }) } }, { file: registryFile });
  const probe = 'host=bean\nos=macos\narch=arm64\nramGb=16\ncores=8\nfreeDiskGb=90\nlane=claude\nlane=codex\nremoteLogin=true\nscreenSharing=true\nrunner=running\nfileVault=false\n';
  const run = async (_command, _args, options = {}) => {
    const input = String(options.input ?? '');
    if (input.startsWith('export SWARM_MACHINE_NAME')) return { code: 0, stdout: 'MACHINE_SETUP_OK name=bean slots=4 lanes=["claude"]\n', stderr: '' };
    return { code: 0, stdout: probe, stderr: '' };
  };
  const runShell = async () => ({ code: 0, stdout: '', stderr: '' });
  const deps = { env: { HOME: dir }, home: dir, run, runShell, interactive: async () => 0, installRoot: process.cwd(), registryFile, now: () => 1000, brainLockFile: path.join(dir, 'brain.lock') };
  const result = await runMachineAdd(['prime@bean.local', '--name', 'bean'], deps);
  assert.equal(result.exitCode, 0, result.stdout);
  let registry = await readRegistry({ file: registryFile });
  assert.equal(registry.machines.bean.role, 'worker');
  assert.deepEqual(registry.machines.bean.lanes, ['claude', 'codex']);
  assert.equal(registry.machines.bean.slots, 4);
  const again = await runMachineAdd(['prime@bean.local', '--name', 'bean'], deps);
  assert.equal(again.exitCode, 0, again.stdout);
  registry = await readRegistry({ file: registryFile });
  assert.ok(registry.machines.bean.addedAt);
});

test('worker queue commands work without touching the brain', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'worker-queue.json');
  const manifest = path.join(dir, 'batch.json');
  await fs.writeFile(manifest, JSON.stringify({ version: 1, jobs: [{ id: 'tiny', agent: 'claude', prompt: 'do tiny' }] }));
  const added = await runWorkerCommand(['queue', 'add', manifest, '--project', 'demo'], { env: { HOME: dir }, home: dir, workerQueueFile: file, now: () => 1000 });
  assert.equal(added.exitCode, 0, added.stdout);
  const next = await runWorkerCommand(['next', '--lanes', 'claude', '--json'], { env: { HOME: dir }, home: dir, workerQueueFile: file, now: () => 2000 });
  assert.equal(next.exitCode, 0, next.stdout);
  const nextItem = JSON.parse(next.stdout);
  assert.equal(nextItem.lane, 'claude');
  const claimed = await runWorkerCommand(['claim', nextItem.id, '--holder', 'bean/1'], { env: { HOME: dir }, home: dir, workerQueueFile: file, now: () => 2000 });
  assert.equal(claimed.exitCode, 0, claimed.stdout);
  const report = await runWorkerCommand(['report', nextItem.id, '--holder', 'bean/1', '--report', Buffer.from(JSON.stringify({ status: 'pass' })).toString('base64')], { env: { HOME: dir }, home: dir, workerQueueFile: file, now: () => 3000 });
  assert.equal(report.exitCode, 0, report.stdout);
});

test('brain state snapshots and restores the shared queue, leases, plans and lessons', async t => {
  const dir = await tmp(t);
  const root = path.join(dir, 'project');
  const stateDir = path.join(dir, 'state');
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), '{"version":1,"tickets":[]}\n');
  await fs.writeFile(path.join(root, '.swarm', 'project', 'leases.json'), '{"version":1,"leases":{},"maxTokenByTicket":{}}\n');
  await fs.writeFile(path.join(root, 'coordination', 'TASK.md'), '- ticket\n');
  const snap = await snapshotProjectState(root, { stateDir, projectId: 'demo' });
  assert.ok(snap.copied.includes('.swarm/project/tickets.json'));
  assert.ok(snap.copied.includes('coordination/TASK.md'));
  await fs.rm(path.join(root, '.swarm'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'coordination'), { recursive: true, force: true });
  const restored = await restoreProjectState(root, { stateDir, projectId: 'demo' });
  assert.ok(restored.copied.includes('.swarm/project/tickets.json'));
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.swarm', 'project', 'tickets.json'), 'utf8')).version, 1);
});

test('benchmark harness runs the same batch with 1 and N workers without double claims', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'bench-queue.json');
  const manifestPath = path.join(dir, 'bench.json');
  const manifest = { version: 1, jobs: Array.from({ length: 4 }, (_, index) => ({ id: `job-${index}`, agent: 'claude', prompt: `do ${index}` })) };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const serial = await runBench({ manifestPath, manifest, workers: 1, workMs: 10, file, paths: workerPaths(dir), now: () => Date.now() });
  const parallel = await runBench({ manifestPath, manifest, workers: 4, workMs: 10, file, paths: workerPaths(dir), now: () => Date.now() });
  assert.equal(serial.jobs, 4);
  assert.equal(serial.claimed, 4);
  assert.equal(serial.pass, 4);
  assert.equal(parallel.claimed, 4);
  assert.equal(parallel.pass, 4);
  assert.equal(parallel.fail, 0);
});

test('a silent worker returns its item and a rate limit cools that lane on that machine', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'queue.json');
  const lanesFile = path.join(dir, 'lanes.json');
  const manifestPath = path.join(dir, 'batch.json');
  const manifest = { version: 1, jobs: [{ id: 'a', agent: 'claude', prompt: 'a' }, { id: 'b', agent: 'codex', prompt: 'b' }] };
  await enqueueManifest({ manifestPath, manifest, project: 'demo', file, now: () => 1000 });
  const first = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'bean', file, lanesFile, now: () => 2000 });
  await claimWorkerItem(first.id, 'bean/1', { file, now: () => 2000, leaseMs: 1000 });
  const retried = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'air8', file, lanesFile, now: () => 5000 });
  assert.equal(retried.id, first.id, 'an expired lease is claimable by another machine');
  await claimWorkerItem(retried.id, 'air8/1', { file, now: () => 5000 });
  await reportWorkerItem(retried.id, 'air8/1', { status: 'requeue', report: { status: 'rate-limited', lane: retried.lane }, file, lanesFile, now: () => 6000 });
  const after = await listWorkerItems({ file, now: () => 6000 });
  assert.equal(after.find(item => item.id === retried.id).status, 'queued');
  const next = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'air8', file, lanesFile, now: () => 6000 });
  assert.notEqual(next.id, retried.id, 'the rate-limited lane is skipped for that machine');
  assert.equal(next.lane, 'codex');
  const other = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'bean', file, lanesFile, now: () => 6000 });
  assert.equal(other.id, retried.id, 'another machine can still take the lane');
});

test('a brain move pauses new leases, moves the pointer and resumes', async t => {
  const dir = await tmp(t);
  const registryFile = path.join(dir, 'machines.json');
  const pointerFile = path.join(dir, 'brain.json');
  const lockFile = path.join(dir, 'brain.lock');
  const projectsFile = path.join(dir, 'projects.json');
  const queueFile = path.join(dir, 'state', 'worker-queue.json');
  const pauseFile = path.join(dir, 'state', 'worker-queue.paused');
  await fs.writeFile(projectsFile, '{"version":1,"projects":[]}\n');
  await writeRegistry({ version: 1, brain: 'mini', order: ['mini', 'bean'], machines: { mini: machine('mini', { role: 'brain' }), bean: machine('bean') } }, { file: registryFile });
  const manifestPath = path.join(dir, 'batch.json');
  await enqueueManifest({ manifestPath, manifest: { version: 1, jobs: [{ id: 'one', agent: 'claude', prompt: 'one' }] }, project: 'demo', file: queueFile, now: () => 1000 });
  const result = await runBrainMove(['bean'], {
    env: { HOME: dir, SWARM_PROJECTS_FILE: projectsFile, SWARM_WORKER_QUEUE_FILE: queueFile, SWARM_WORKER_PAUSE_FILE: pauseFile },
    home: dir, now: () => 2000, registryFile, brainPointerFile: pointerFile, brainLockFile: lockFile,
    syncState: false, startBrain: false, stopSource: false, runShell: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.exitCode, 0, result.stdout);
  const registry = await readRegistry({ file: registryFile });
  assert.equal(registry.brain, 'bean');
  assert.equal(JSON.parse(await fs.readFile(pointerFile, 'utf8')).machine, 'bean');
  assert.equal(await fs.stat(pauseFile).then(() => true, () => false), true, 'the old brain stays paused after a move');
});

test('worker keys are forced to the queue RPC and ssh config uses the IP', async t => {
  const dir = await tmp(t);
  const run = async (_command, _args, options = {}) => {
    if (String(options.input ?? '').includes('swarm_ed25519.pub')) return { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeWorker ghost@10.10.7.73\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await ensureWorkerKey({ target: { user: 'ghost', host: '10.10.7.73' }, key: path.join(dir, 'brain_key'), name: 'ghost', run, home: dir, runner: '/brain/current/tools/swarm.mjs', node: '/usr/bin/node' });
  assert.match(result.forced, /command="\/usr\/bin\/node \/brain\/current\/tools\/swarm.mjs worker-rpc",no-pty/);
  const auth = await fs.readFile(path.join(dir, '.ssh', 'authorized_keys'), 'utf8');
  assert.equal(auth.trim().split('\n').length, 1);
  assert.match(auth, /worker-rpc/);
  assert.doesNotMatch(auth, /^ssh-ed25519 .*ghost@10\.10\.7\.73$/m);
  await updateSshConfigForMachine({ name: 'ghost', host: '10.10.7.73', user: 'ghost', key: '/brain/.ssh/swarm_ed25519', home: dir });
  const config = await fs.readFile(path.join(dir, '.ssh', 'config'), 'utf8');
  assert.match(config, /Host ghost\n  HostName 10\.10\.7\.73/);
});

test('the worker transport tries the last known IP then the fallback list and sends RPC JSON', async () => {
  const calls = [];
  const run = async (_command, args, options = {}) => {
    calls.push({ args, input: options.input });
    if (calls.length === 1) return { code: 1, stdout: '', stderr: 'unreachable' };
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
  };
  const brain = { host: '10.10.10.169', user: 'prime', hosts: ['10.10.10.169', '100.104.42.88'], epoch: 2 };
  const transport = createSshTransport({ brain, key: '/k', run });
  const result = await transport.next({ lanes: ['claude'], machine: 'ghost' });
  assert.deepEqual(result, { ok: true });
  assert.equal(brain.host, '100.104.42.88');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], '-T');
  assert.ok(calls[0].args.includes('prime@10.10.10.169'));
  assert.ok(calls[1].args.includes('prime@100.104.42.88'));
  assert.equal(JSON.parse(calls[1].input).op, 'next');
  assert.equal(JSON.parse(calls[1].input).epoch, 2);
});

test('machine add stores the IP, not the remote .local name, and sets role both', async t => {
  const dir = await tmp(t);
  const key = path.join(dir, 'swarm_ed25519');
  await fs.writeFile(key, 'private');
  await fs.writeFile(`${key}.pub`, 'public');
  const registryFile = path.join(dir, 'machines.json');
  await writeRegistry({ version: 1, brain: 'mini', order: ['mini'], machines: { mini: machine('mini', { role: 'brain', host: '10.10.10.169', ip: '10.10.10.169' }) } }, { file: registryFile });
  const probe = 'host=ghost.local\nip=10.10.7.73\nos=macos\nramGb=16\ncores=8\nfreeDiskGb=90\nlane=claude\nremoteLogin=true\nscreenSharing=true\nrunner=running\nfileVault=false\n';
  const run = async (_command, _args, options = {}) => {
    if (String(options.input ?? '').startsWith('export SWARM_MACHINE_NAME')) return { code: 0, stdout: 'MACHINE_SETUP_OK name=ghost slots=4 lanes=["claude"]\n', stderr: '' };
    return { code: 0, stdout: probe, stderr: '' };
  };
  const runShell = async () => ({ code: 0, stdout: '', stderr: '' });
  const result = await runMachineAdd(['ghost@10.10.7.73', '--name', 'ghost', '--role', 'both'], { env: { HOME: dir }, home: dir, run, runShell, interactive: async () => 0, installRoot: process.cwd(), registryFile, now: () => 1000, brainLockFile: path.join(dir, 'brain.lock') });
  assert.equal(result.exitCode, 0, result.stdout);
  const registry = await readRegistry({ file: registryFile });
  assert.equal(registry.machines.ghost.host, '10.10.7.73');
  assert.equal(registry.machines.ghost.ip, '10.10.7.73');
  assert.equal(registry.machines.ghost.role, 'remote+worker');
});
