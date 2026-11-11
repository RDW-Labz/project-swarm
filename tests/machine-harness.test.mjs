// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireBrainLock, addMachine, emptyRegistry, failoverOrder, machinesFile, nextBrain,
  readRegistry, releaseBrainLock, removeMachine, setBrain, withoutStaleMeasurements, writeRegistry,
} from '../tools/machine-registry.mjs';
import { parseFreeDiskKb, parsePmsetBattery, parsePmsetTherm, parseRemoteProbe, parseSleepSettings, measuredOnly } from '../tools/machine-probe.mjs';
import { buildLaneCommand, detectLaneOutcome, laneLoginHint, WORKER_LANE_NAMES } from '../tools/lane-plugins.mjs';
import {
  brainDiskState, claimWorkerItem, diskGuard, enqueueManifest, listWorkerItems, nextWorkerItem, releaseExpiredWorkerItems, reportWorkerItem, workerQueueFile,
} from '../tools/worker-queue.mjs';
import { createSshTransport, executeItem, laptopGate, laptopState, slotsForMachine, tuneSlots, workerPaths } from '../tools/worker-runner.mjs';
import { buildMachineView, registryHintText } from '../tools/machine-view.mjs';
import { snapshotProjectState, restoreProjectState } from '../tools/state-sync.mjs';
import { runBench } from '../tools/worker-bench.mjs';
import { ensureWorkerKey, failoverDecision, listMachines, parseTarget, doctorLines, readBootstrapScript, runBootstrap, runBrainMove, runMachineAdd, runWorkerCommand, updateSshConfigForMachine } from '../tools/machine-commands.mjs';

const tmp = async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'machine-harness-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const machine = (name, extra = {}) => ({ name, role: 'worker', host: `${name}.local`, user: 'owner', os: 'macos', ramGb: 16, cores: 8, slots: 4, lanes: ['claude', 'codex'], health: 'ok', freeDiskGb: 90, measuredAt: new Date().toISOString(), ...extra });

test('registry adds, updates, moves the brain and removes machines', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'machines.json');
  await addMachine(machine('brain', { role: 'brain' }), { file, brain: true });
  await addMachine(machine('laptop1'), { file });
  let registry = await readRegistry({ file });
  assert.equal(registry.brain, 'brain');
  assert.deepEqual(failoverOrder(registry).slice(0, 3), ['brain', 'laptop1']);
  await setBrain('laptop1', { file });
  registry = await readRegistry({ file });
  assert.equal(registry.brain, 'laptop1');
  assert.equal(registry.machines.brain.role, 'worker');
  assert.equal(registry.machines.laptop1.role, 'brain');
  const removed = await removeMachine('laptop1', { file });
  assert.equal(removed.removed, true);
  registry = await readRegistry({ file });
  assert.equal(registry.brain, 'brain');
});

test('brain lock is exclusive and stale locks are reclaimed', async t => {
  const dir = await tmp(t);
  const file = path.join(dir, 'brain.lock');
  await acquireBrainLock({ file, machine: 'brain', now: 1000, staleMs: 50 });
  await assert.rejects(() => acquireBrainLock({ file, machine: 'brain', now: 1020, staleMs: 50 }), { code: 'brain-locked' });
  const reclaimed = await acquireBrainLock({ file, machine: 'laptop1', now: 2000, staleMs: 50 });
  assert.equal(reclaimed.acquired, true);
  assert.equal(await releaseBrainLock({ file, machine: 'brain' }), false);
  assert.equal(await releaseBrainLock({ file, machine: 'laptop1' }), true);
});

test('failover follows the registry order and ignores a live brain', () => {
  const registry = { version: 1, brain: 'brain', order: ['brain', 'laptop1', 'laptop2'], machines: { brain: machine('brain', { role: 'brain' }), laptop1: machine('laptop1'), laptop2: machine('laptop2') } };
  assert.equal(nextBrain(registry), 'laptop1');
  assert.deepEqual(failoverDecision({ registry, heartbeats: { brain: 1000 }, now: 1200, silentMs: 500 }), { action: 'none', brain: 'brain' });
  assert.deepEqual(failoverDecision({ registry, heartbeats: { brain: 1000 }, now: 2000, silentMs: 500 }), { action: 'move', from: 'brain', to: 'laptop1', reason: 'brain brain silent for 1s' });
});

test('probe parsers keep only measured values', () => {
  assert.equal(parseFreeDiskKb('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 1000 10 700 2% /\n'), 700);
  assert.deepEqual(parsePmsetBattery('Now drawing from \'AC Power\'\n -InternalBattery-0 80%; charging;'), { onCharger: true, batteryPercent: 80 });
  assert.deepEqual(parsePmsetTherm('CPU_Speed_Limit = 100\nCPU_Scheduler_Limit = 90'), { cpuSpeedLimit: 100, cpuSchedulerLimit: 90, throttled: true });
  assert.deepEqual(parseSleepSettings('disablesleep 1\n sleep 0'), { disablesleep: true, sleepMinutes: 0 });
  assert.deepEqual(parseSleepSettings('SleepDisabled\t\t1\nBattery Power:\n sleep 1\nAC Power:\n sleep 0\n disksleep 0\n'), { disablesleep: true, sleepMinutes: 0, disksleepMinutes: 0 });
  assert.deepEqual(parseRemoteProbe('host=laptop1\nramGb=16\nlanes=claude\nlane=codex\nfileVault=false\nrunner=running\n'), { host: 'laptop1', ramGb: 16, lanes: ['codex'], fileVault: false, runner: 'running' });
  assert.equal(parseRemoteProbe('cpuSpeedLimit=75\n').throttled, true);
  assert.equal(parseRemoteProbe('cpuSpeedLimit=100\ncpuSchedulerLimit=100\n').throttled, false);
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
  await claimWorkerItem(next.id, 'laptop1/1', { file, now: () => 3000, leaseMs: 1000 });
  await assert.rejects(() => claimWorkerItem(next.id, 'laptop1/2', { file, now: () => 3100 }), { code: 'worker-lease-held' });
  const released = await releaseExpiredWorkerItems({ file, now: () => 5000 });
  assert.deepEqual(released.released, [next.id]);
  const claimed = await claimWorkerItem(next.id, 'worker2/1', { file, now: () => 5000, leaseMs: 5000 });
  assert.equal(claimed.lease.holder, 'worker2/1');
  const report = await reportWorkerItem(next.id, 'worker2/1', { status: 'done', report: { status: 'pass' }, file, now: () => 6000 });
  assert.equal(report.status, 'done');
});

test('laptop (remote+worker) rules, slots and disk guard are enforced before work is taken', () => {
  assert.deepEqual(laptopGate({ role: 'remote+worker', onCharger: false, lidOpen: true, brainReachable: true }), { ok: false, reason: 'laptop-on-battery' });
  assert.deepEqual(laptopGate({ role: 'remote+worker', onCharger: true, lidOpen: false, brainReachable: true }), { ok: false, reason: 'laptop-lid-closed' });
  assert.deepEqual(laptopGate({ role: 'remote+worker', onCharger: true, lidOpen: true, brainReachable: true }), { ok: true, reason: 'laptop-ready' });
  assert.equal(laptopState({ role: 'remote+worker', onCharger: false, lidOpen: true, brainReachable: true }), 'away');
  assert.equal(laptopState({ role: 'remote+worker', onCharger: true, lidOpen: true, brainReachable: true, running: 1 }), 'working');
  assert.equal(slotsForMachine({ slots: 4, role: 'remote+worker', onCharger: false }), 0);
  assert.equal(slotsForMachine({ slots: 4, role: 'remote+worker', onCharger: true, userActive: true }), 1);
  assert.equal(diskGuard(19).ok, false);
  assert.equal(diskGuard(20).ok, true);
  assert.equal(brainDiskState(49).state, 'warn');
  assert.equal(brainDiskState(30).state, 'warn');
  assert.equal(brainDiskState(29).state, 'clean');
  assert.equal(brainDiskState(50).state, 'ok');
});

test('an Intel laptop backs off when it throttles and recovers a slot when it cools', () => {
  assert.equal(tuneSlots({ current: 6, ceiling: 6 }), 6);
  assert.equal(tuneSlots({ current: 6, ceiling: 6, cpuSpeedLimit: 80 }), 3);
  assert.equal(tuneSlots({ current: 3, ceiling: 6, cpuSpeedLimit: 80 }), 1);
  assert.equal(tuneSlots({ current: 1, ceiling: 6, cpuSpeedLimit: 100 }), 2);
  assert.equal(tuneSlots({ current: 5, ceiling: 6, memoryPressure: 'hard' }), 2);
  assert.equal(tuneSlots({ current: 6, ceiling: 6, role: 'remote+worker', onCharger: false }), 0);
  assert.equal(tuneSlots({ current: 6, ceiling: 6, role: 'remote+worker', onCharger: true, userActive: true }), 1);
});

test('executeItem writes the manifest in an isolated worktree and reports the lane outcome', async t => {
  const dir = await tmp(t);
  const worktree = path.join(dir, 'worktree');
  await fs.mkdir(worktree, { recursive: true });
  const item = { id: 'batch.json:build-a', project: 'demo', job: 'build-a', lane: 'claude', model: null, manifestData: { version: 1, jobs: [{ id: 'build-a', agent: 'claude', prompt: 'build a' }] } };
  const paths = workerPaths(dir);
  const result = await executeItem({
    item, holder: 'laptop1/1', paths, runner: '/runner/swarm.mjs',
    ensure: async () => ({}),
    prepare: async () => ({ dir: worktree, branch: 'worker/laptop1/batch' }),
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
  const registry = { version: 1, brain: 'brain', order: ['brain', 'laptop2'], machines: { brain: machine('brain', { role: 'brain', freeDiskGb: 120 }), laptop2: machine('laptop2', { role: 'remote+worker', onCharger: false, lidOpen: true, freeDiskGb: undefined }) } };
  const view = buildMachineView({ registry, now: () => 1000 });
  assert.equal(view.brain, 'brain');
  assert.equal(view.machines[0].brain, true);
  assert.equal(view.machines[1].state, 'away');
  assert.equal('freeDiskGb' in view.machines[1], false);
  assert.match(registryHintText(view), /brain brain/);
  const docked = { ...registry, machines: { ...registry.machines, laptop2: machine('laptop2', { role: 'remote+worker', onCharger: true, lidOpen: true }) } };
  assert.equal(buildMachineView({ registry: docked, runningByMachine: { laptop2: 1 }, now: () => 1000 }).machines[1].state, 'working');
});

test('machine list and doctor only print measured facts', async () => {
  const registry = { version: 1, brain: 'brain', order: ['brain'], machines: { brain: machine('brain', { role: 'brain', fileVault: true, runner: 'stopped' }) } };
  const text = await listMachines({ registry });
  assert.match(text, /brain/);
  assert.match(text, /macos/);
  const lines = doctorLines(registry.machines.brain);
  assert.ok(lines.some(line => /FileVault is on/.test(line)));
  assert.ok(lines.some(line => /worker runner stopped/.test(line)));
  const laptop2 = doctorLines(machine('laptop2', { role: 'remote+worker', fileVault: true }));
  assert.ok(laptop2.some(line => /^WARN FileVault is on/.test(line)), 'FileVault is a warning on a carried laptop');
  assert.ok(!laptop2.some(line => /^FAIL FileVault/.test(line)));
  const laptopAwake = doctorLines(machine('laptop2', { role: 'remote+worker', disablesleep: true, sleepMinutes: 0, disksleepMinutes: 0 }));
  assert.ok(laptopAwake.some(line => /^FAIL sleep settings.*remote\+worker must sleep/.test(line)), 'a laptop must not disable sleep');
  const worker = doctorLines(machine('worker2', { role: 'worker', fileVault: true }));
  assert.ok(worker.some(line => /^FAIL FileVault/.test(line)), 'FileVault stays a failure on a full-time worker');
  const laptop1 = doctorLines(machine('laptop1', { role: 'worker', fileVault: true, fileVaultPolicy: 'warn' }));
  assert.ok(laptop1.some(line => /^WARN FileVault is on.*owner keeps FileVault on/.test(line)));
  assert.ok(!laptop1.some(line => /^FAIL FileVault/.test(line)));
  const worker1 = doctorLines(machine('worker1', { role: 'worker', disablesleep: true, sleepMinutes: 0, disksleepMinutes: 0, fileVault: true, fileVaultPolicy: 'warn' }));
  assert.ok(worker1.some(line => /^ok\s+sleep settings \(SleepDisabled=1, AC sleep=0, AC disksleep=0\)/.test(line)));
  assert.ok(worker1.some(line => /^WARN FileVault/.test(line)));
  const brain = doctorLines(machine('brain', { role: 'brain', freeDiskGb: 40 }));
  assert.ok(brain.some(line => /^WARN free disk 40 GB \(brain/.test(line)));
  assert.ok(!brain.some(line => /^FAIL free disk/.test(line)));
  assert.deepEqual(parseTarget('alice@laptop1.local'), { user: 'alice', host: 'laptop1' });
  assert.equal(parseTarget('not-a-target'), null);
});

test('stale measurements are hidden, never shown as current', () => {
  const now = 10_000_000;
  const old = machine('brain', { freeDiskGb: 23, health: 'ok', measuredAt: new Date(0).toISOString() });
  const hidden = withoutStaleMeasurements(old, { now });
  assert.equal(hidden.stale, true);
  assert.equal('freeDiskGb' in hidden, false);
  assert.equal('health' in hidden, false);
  const recent = withoutStaleMeasurements({ ...old, measuredAt: new Date(now - 1000).toISOString() }, { now });
  assert.equal(recent.stale, false);
  assert.equal(recent.freeDiskGb, 23);
  const view = buildMachineView({ registry: { version: 1, brain: 'brain', order: ['brain'], machines: { brain: old } }, now: () => now });
  assert.equal(view.machines[0].stale, true);
  assert.equal('freeDiskGb' in view.machines[0], false);
});

test('Intel bootstrap has no Homebrew requirement and uses an x64 Node under ~/.local', async () => {
  const script = await readBootstrapScript();
  assert.match(script, /darwin-x64/);
  assert.match(script, /x86_64/);
  assert.match(script, /\/usr\/bin\/jq/);
  assert.match(script, /~\/\.local\/node/);
  assert.match(script, /lane_skipped/);
  assert.match(script, /lane_runnable/);
  assert.match(script, /SleepDisabled/);
  assert.match(script, /if \[ "\$ARCH_NAME" = "x86_64" \]/);
  assert.match(script, /gh skipped on this worker/);
});

test('runBootstrap passes the IP and --slots 6 to the target', async () => {
  let input = '';
  const run = async (_command, _args, options = {}) => { input = String(options.input ?? ''); return { code: 0, stdout: 'MACHINE_SETUP_OK name=worker1 slots=6 lanes=[]\n', stderr: '' }; };
  await runBootstrap({ target: { user: 'workeruser', host: '192.0.2.70' }, key: '/k', name: 'worker1', role: 'worker', slots: 6, run });
  assert.match(input, /SWARM_MACHINE_HOST="192\.0\.2\.70"/);
  assert.match(input, /SWARM_MACHINE_SLOTS="6"/);
  assert.match(input, /SWARM_MACHINE_MODE="worker"/);
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
  await writeRegistry({ version: 1, brain: 'brain', order: ['brain'], machines: { brain: machine('brain', { role: 'brain' }) } }, { file: registryFile });
  const probe = 'host=laptop1\nos=macos\narch=arm64\nramGb=16\ncores=8\nfreeDiskGb=90\nlane=claude\nlane=codex\nremoteLogin=true\nscreenSharing=true\nrunner=running\nfileVault=false\n';
  const run = async (_command, _args, options = {}) => {
    const input = String(options.input ?? '');
    if (input.startsWith('export SWARM_MACHINE_NAME')) return { code: 0, stdout: 'MACHINE_SETUP_OK name=laptop1 slots=4 lanes=["claude"]\n', stderr: '' };
    return { code: 0, stdout: probe, stderr: '' };
  };
  const runShell = async () => ({ code: 0, stdout: '', stderr: '' });
  const deps = { env: { HOME: dir }, home: dir, run, runShell, interactive: async () => 0, installRoot: process.cwd(), registryFile, now: () => 1000, brainLockFile: path.join(dir, 'brain.lock'), machineConfig: { laptops: ['laptop1'] } };
  const result = await runMachineAdd(['owner@laptop1.local', '--name', 'laptop1'], deps);
  assert.equal(result.exitCode, 0, result.stdout);
  let registry = await readRegistry({ file: registryFile });
  assert.equal(registry.machines.laptop1.role, 'remote+worker', 'laptop1 is a carried laptop by default');
  assert.deepEqual(registry.machines.laptop1.lanes, ['claude', 'codex']);
  assert.equal(registry.machines.laptop1.slots, 4);
  const again = await runMachineAdd(['owner@laptop1.local', '--name', 'laptop1'], deps);
  assert.equal(again.exitCode, 0, again.stdout);
  registry = await readRegistry({ file: registryFile });
  assert.ok(registry.machines.laptop1.addedAt);
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
  const claimed = await runWorkerCommand(['claim', nextItem.id, '--holder', 'laptop1/1'], { env: { HOME: dir }, home: dir, workerQueueFile: file, now: () => 2000 });
  assert.equal(claimed.exitCode, 0, claimed.stdout);
  const report = await runWorkerCommand(['report', nextItem.id, '--holder', 'laptop1/1', '--report', Buffer.from(JSON.stringify({ status: 'pass' })).toString('base64')], { env: { HOME: dir }, home: dir, workerQueueFile: file, now: () => 3000 });
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
  const first = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'laptop1', file, lanesFile, now: () => 2000 });
  await claimWorkerItem(first.id, 'laptop1/1', { file, now: () => 2000, leaseMs: 1000 });
  const retried = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'worker2', file, lanesFile, now: () => 5000 });
  assert.equal(retried.id, first.id, 'an expired lease is claimable by another machine');
  await claimWorkerItem(retried.id, 'worker2/1', { file, now: () => 5000 });
  await reportWorkerItem(retried.id, 'worker2/1', { status: 'requeue', report: { status: 'rate-limited', lane: retried.lane }, file, lanesFile, now: () => 6000 });
  const after = await listWorkerItems({ file, now: () => 6000 });
  assert.equal(after.find(item => item.id === retried.id).status, 'queued');
  const next = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'worker2', file, lanesFile, now: () => 6000 });
  assert.notEqual(next.id, retried.id, 'the rate-limited lane is skipped for that machine');
  assert.equal(next.lane, 'codex');
  const other = await nextWorkerItem({ lanes: ['claude', 'codex'], machine: 'laptop1', file, lanesFile, now: () => 6000 });
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
  // The move must run on the current brain, so the fixture brain is this test host.
  await writeRegistry({ version: 1, brain: 'brain', order: ['brain', 'laptop1'], machines: { brain: machine('brain', { role: 'brain', host: os.hostname().replace(/\.local$/, '') }), laptop1: machine('laptop1') } }, { file: registryFile });
  const manifestPath = path.join(dir, 'batch.json');
  await enqueueManifest({ manifestPath, manifest: { version: 1, jobs: [{ id: 'one', agent: 'claude', prompt: 'one' }] }, project: 'demo', file: queueFile, now: () => 1000 });
  const result = await runBrainMove(['laptop1'], {
    env: { HOME: dir, SWARM_PROJECTS_FILE: projectsFile, SWARM_WORKER_QUEUE_FILE: queueFile, SWARM_WORKER_PAUSE_FILE: pauseFile },
    home: dir, now: () => 2000, registryFile, brainPointerFile: pointerFile, brainLockFile: lockFile,
    syncState: false, startBrain: false, stopSource: false, runShell: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.exitCode, 0, result.stdout);
  const registry = await readRegistry({ file: registryFile });
  assert.equal(registry.brain, 'laptop1');
  assert.equal(JSON.parse(await fs.readFile(pointerFile, 'utf8')).machine, 'laptop1');
  assert.equal(await fs.stat(pauseFile).then(() => true, () => false), true, 'the old brain stays paused after a move');
});

test('worker keys are forced to the queue RPC and ssh config uses the IP', async t => {
  const dir = await tmp(t);
  const run = async (_command, _args, options = {}) => {
    if (String(options.input ?? '').includes('swarm_ed25519.pub')) return { code: 0, stdout: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeWorker laptop2@192.0.2.73\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeGit laptop2-git@192.0.2.73\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await ensureWorkerKey({ target: { user: 'laptop2', host: '192.0.2.73' }, key: path.join(dir, 'brain_key'), name: 'laptop2', run, home: dir, runner: '/brain/current/tools/swarm.mjs', node: '/usr/bin/node' });
  assert.match(result.forced, /command="\/usr\/bin\/node \/brain\/current\/tools\/swarm.mjs worker-rpc --machine laptop2",no-pty/);
  const auth = await fs.readFile(path.join(dir, '.ssh', 'authorized_keys'), 'utf8');
  assert.equal(auth.trim().split('\n').length, 2);
  assert.match(auth, /worker-rpc/);
  assert.match(auth, /git-mirror-shell/);
  assert.doesNotMatch(auth, /^ssh-ed25519 .*laptop2@192\.0\.2\.73$/m);
  await updateSshConfigForMachine({ name: 'laptop2', host: '192.0.2.73', user: 'laptop2', key: '/brain/.ssh/swarm_ed25519', home: dir });
  const config = await fs.readFile(path.join(dir, '.ssh', 'config'), 'utf8');
  assert.match(config, /Host laptop2\n  HostName 192\.0\.2\.73/);
});

test('the worker transport tries the last known IP then the fallback list and sends RPC JSON', async () => {
  const calls = [];
  const run = async (_command, args, options = {}) => {
    calls.push({ args, input: options.input });
    if (calls.length === 1) return { code: 1, stdout: '', stderr: 'unreachable' };
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
  };
  const brain = { host: '192.0.2.10', user: 'owner', hosts: ['192.0.2.10', '198.51.100.20'], epoch: 2 };
  const transport = createSshTransport({ brain, key: '/k', run });
  const result = await transport.next({ lanes: ['claude'], machine: 'laptop2' });
  assert.deepEqual(result, { ok: true });
  assert.equal(brain.host, '198.51.100.20');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[0], '-T');
  assert.ok(calls[0].args.includes('owner@192.0.2.10'));
  assert.ok(calls[1].args.includes('owner@198.51.100.20'));
  assert.equal(JSON.parse(calls[1].input).op, 'next');
  assert.equal(JSON.parse(calls[1].input).epoch, 2);
});

test('machine add stores the IP, not the remote .local name, and sets role both', async t => {
  const dir = await tmp(t);
  const key = path.join(dir, 'swarm_ed25519');
  await fs.writeFile(key, 'private');
  await fs.writeFile(`${key}.pub`, 'public');
  const registryFile = path.join(dir, 'machines.json');
  await writeRegistry({ version: 1, brain: 'brain', order: ['brain'], machines: { brain: machine('brain', { role: 'brain', host: '192.0.2.10', ip: '192.0.2.10' }) } }, { file: registryFile });
  const probe = 'host=laptop2.local\nip=192.0.2.73\nos=macos\nramGb=16\ncores=8\nfreeDiskGb=90\nlane=claude\nremoteLogin=true\nscreenSharing=true\nrunner=running\nfileVault=false\n';
  const run = async (_command, _args, options = {}) => {
    if (String(options.input ?? '').startsWith('export SWARM_MACHINE_NAME')) return { code: 0, stdout: 'MACHINE_SETUP_OK name=laptop2 slots=4 lanes=["claude"]\n', stderr: '' };
    return { code: 0, stdout: probe, stderr: '' };
  };
  const runShell = async () => ({ code: 0, stdout: '', stderr: '' });
  const result = await runMachineAdd(['laptop2@192.0.2.73', '--name', 'laptop2', '--role', 'both'], { env: { HOME: dir }, home: dir, run, runShell, interactive: async () => 0, installRoot: process.cwd(), registryFile, now: () => 1000, brainLockFile: path.join(dir, 'brain.lock') });
  assert.equal(result.exitCode, 0, result.stdout);
  const registry = await readRegistry({ file: registryFile });
  assert.equal(registry.machines.laptop2.host, '192.0.2.73');
  assert.equal(registry.machines.laptop2.ip, '192.0.2.73');
  assert.equal(registry.machines.laptop2.role, 'remote+worker');
});

test('fleet machine names and defaults come from the local machine config, not the repo', async t => {
  const { loadMachineLocalConfig, MACHINE_LOCAL_DEFAULTS } = await import('../tools/machine-local-config.mjs');
  const dir = await tmp(t);
  const file = path.join(dir, 'machines.local.json');
  assert.deepEqual({ ...loadMachineLocalConfig({ env: { SWARM_MACHINES_LOCAL: file } }) }, { ...MACHINE_LOCAL_DEFAULTS });
  await fs.writeFile(file, JSON.stringify({ brainName: 'hub', laptops: ['laptop1'], backupWorker: 'worker1' }));
  const config = loadMachineLocalConfig({ env: { SWARM_MACHINES_LOCAL: file } });
  assert.equal(config.brainName, 'hub');
  assert.deepEqual(config.laptops, ['laptop1']);
  assert.equal(config.backupWorker, 'worker1');
  assert.deepEqual(config.fileVaultWarn, []);
  assert.equal(loadMachineLocalConfig({ override: { brainName: 'x' } }).brainName, 'x');
  const example = JSON.parse(await fs.readFile(new URL('../config/machines.example.json', import.meta.url), 'utf8'));
  assert.ok(Object.keys(example).every(key => key in MACHINE_LOCAL_DEFAULTS));
});
