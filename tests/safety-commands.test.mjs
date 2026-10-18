// SPDX-License-Identifier: Apache-2.0
// The safety group end to end: the commands, the stop marker that blocks new runs, the migration check in the merge queue, the profile block.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSafetyCommand, realStopDeps } from '../tools/safety-commands.mjs';
import { migrationQueueCheck } from '../tools/migration-queue.mjs';
import { validateProfile } from '../tools/init-profile.mjs';
import { readStopMarker } from '../tools/stop-all.mjs';
import { runAutopilot } from '../tools/autopilot.mjs';

const swarm = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const tmp = async t => { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'safety-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const put = async (root, file, text) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };

test('backup, list, verify, restore: state comes back and a restore can be undone', async t => {
  const root = await tmp(t);
  await put(root, '.swarm/project/tickets.json', '{"v":1}\n');
  await put(root, '.swarm/project/api-key.json', 'secret');
  const made = await runSafetyCommand(root, 'backup', ['--reason', 'test']);
  assert.equal(made.exitCode, 0);
  const id = /backup (\S+):/.exec(made.stdout)[1];
  assert.match((await runSafetyCommand(root, 'backup', ['list'])).stdout, new RegExp(id));
  assert.match((await runSafetyCommand(root, 'backup', ['verify', id])).stdout, /ok/);
  await put(root, '.swarm/project/tickets.json', '{"v":2}\n');
  assert.match((await runSafetyCommand(root, 'restore', [id])).stdout, /Rerun with --yes/);
  assert.equal(await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8'), '{"v":2}\n', 'a plan changes nothing');
  const restored = await runSafetyCommand(root, 'restore', [id, '--yes']);
  assert.equal(restored.exitCode, 0, restored.stdout);
  assert.equal(await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8'), '{"v":1}\n');
  const pre = /state before is backup (\S+)/.exec(restored.stdout)[1];
  await runSafetyCommand(root, 'restore', [pre, '--yes']);
  assert.equal(await fs.readFile(path.join(root, '.swarm/project/tickets.json'), 'utf8'), '{"v":2}\n', 'the restore is undone');
  const files = await fs.readdir(path.join(root, '.swarm/backups', id, 'files/.swarm/project'));
  assert.deepEqual(files, ['tickets.json'], 'secrets are never copied');
  assert.equal((await runSafetyCommand(root, 'restore', ['../x', '--yes'])).exitCode, 1);
  assert.equal((await runSafetyCommand(root, 'backup', ['--bogus'])).exitCode, 1);
});

test('swarm stop --all: marker first, exit 2 and a billing warning when the rented node is not confirmed stopped', async t => {
  const root = await tmp(t);
  const calls = [];
  const stop = {
    listRuns: async () => [], cancelRun: async () => {}, readAutopilotPid: async () => null, kill() {}, isAlive: () => false,
    gpuSession: async () => ({ id: 's' }), gpuDown: async () => { calls.push('down'); throw new Error('ssh down'); }, gpuStatus: async () => ({}),
    backup: async () => ({ id: 'b' }), sleep: async () => {}, pollMs: 1, waitMs: 1,
  };
  const res = await runSafetyCommand(root, 'stop', ['--all'], { stop });
  assert.equal(res.exitCode, 2);
  assert.match(res.stdout, /BILLING RISK/);
  assert.match(res.stdout, /terminate the rented instance/);
  assert.equal(calls.length, 3, 'gpu down is tried three times');
  assert.ok(await readStopMarker(root), 'the marker was written');
  assert.match((await runSafetyCommand(root, 'stop', ['--status'])).stdout, /stopped at/);
  assert.equal((await runSafetyCommand(root, 'stop', [])).exitCode, 1);
  assert.match((await runSafetyCommand(root, 'stop', ['--clear'])).stdout, /removed/);
  assert.equal(await readStopMarker(root), null);
});

test('a stop marker blocks run, go and autopilot but not help or stop', async t => {
  const root = await tmp(t);
  await put(root, '.swarm/stop.json', JSON.stringify({ at: new Date().toISOString(), reason: 'test' }));
  for (const args of [['run', 'x.json'], ['go', 'a goal'], ['autopilot'], ['resume', 'r1'], ['sweep'], ['scout'], ['ship', 'r1'], ['merge', '1'], ['integrate', 'r1'], ['gpu', 'up'], ['gpu', 'bakeoff'], ['run', 'x.json', '--commit-message', '--help']]) {
    const res = spawnSync(process.execPath, [swarm, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    assert.equal(res.status, 1, args.join(' '));
    assert.match(res.stderr, /"code":"stopped"/, args.join(' '));
  }
  const help = spawnSync(process.execPath, [swarm, 'run', '--help', '--root', root], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.equal(help.status, 0, 'help is never blocked');
  const status = spawnSync(process.execPath, [swarm, 'stop', '--status', '--root', root], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.equal(status.status, 0);
  assert.match(status.stdout, /stopped at/);
  const cleared = spawnSync(process.execPath, [swarm, 'stop', '--clear', '--root', root], { encoding: 'utf8', env: { ...process.env, HOME: root } });
  assert.match(cleared.stdout, /removed/);
});

test('realStopDeps: an unreachable rented node is a failure, never a verified stop', async t => {
  const root = await tmp(t);
  const deps = await realStopDeps(root, { env: { ...process.env, HOME: root } });
  assert.equal(await deps.readAutopilotPid(), null);
  assert.deepEqual(await deps.listRuns(), []);
  assert.equal(await deps.gpuSession(), null);
});

test('migrations command: check, approve bound to the file hash', async t => {
  const root = await tmp(t);
  await put(root, 'supabase/migrations/001_a.sql', 'create table a (id int);\n');
  await put(root, 'supabase/migrations/001_a.down.sql', 'drop table a;\n');
  await put(root, 'supabase/migrations/002_b.sql', 'alter table a drop column id;\n');
  await put(root, 'supabase/migrations/002_b.down.sql', 'alter table a add column id int;\n');
  const first = await runSafetyCommand(root, 'migrations', ['check']);
  assert.equal(first.exitCode, 1);
  assert.match(first.stdout, /needs-approval: migration supabase\/migrations\/002_b\.sql drops or rewrites data/);
  assert.equal((await runSafetyCommand(root, 'migrations', ['approve', 'supabase/migrations/nope.sql'])).exitCode, 1);
  assert.equal((await runSafetyCommand(root, 'migrations', ['approve', '../../etc/passwd'])).exitCode, 1);
  assert.equal((await runSafetyCommand(root, 'migrations', ['approve', 'supabase/migrations/002_b.sql', '--note', 'ok by owner'])).exitCode, 0);
  assert.equal((await runSafetyCommand(root, 'migrations', ['check'])).exitCode, 0);
  await put(root, 'supabase/migrations/002_b.sql', 'alter table a drop column id;\ndrop table b;\n');
  assert.equal((await runSafetyCommand(root, 'migrations', ['check'])).exitCode, 1, 'an edit after approval needs a new approval');
});

test('migrations check --yes runs up, seed, down, up with the project commands', async t => {
  const root = await tmp(t);
  await put(root, 'supabase/migrations/001_a.sql', 'create table a (id int);\n');
  await put(root, 'supabase/migrations/001_a.down.sql', 'drop table a;\n');
  await put(root, '.project-swarm.json', JSON.stringify({ profile: { migrations: { commands: { up: ['db', 'up'], down: ['db', 'down'], seed: ['db', 'seed'] } } } }));
  const seen = [];
  const res = await runSafetyCommand(root, 'migrations', ['check', '--yes'], { exec: async argv => { seen.push(argv.join(' ')); return { exitCode: 0, stdout: '', stderr: '' }; } });
  assert.equal(res.exitCode, 0, res.stdout);
  assert.deepEqual(seen, ['db up', 'db seed', 'db down', 'db up']);
});

test('merge queue check: opt-in block; no block means a note, not a refusal', async t => {
  const root = await tmp(t);
  await put(root, 'supabase/migrations/001_a.sql', 'drop table a;\n');
  const changes = [{ file: 'supabase/migrations/001_a.sql', bytes: Buffer.from('drop table a;\n') }];
  const none = await migrationQueueCheck({ root, changes, profile: {} });
  assert.deepEqual(none.blocks, []);
  assert.match(none.notes[0], /no migrations block/);
  const on = await migrationQueueCheck({ root, changes, profile: { migrations: {} } });
  assert.equal(on.blocks.length, 2, 'no down step and needs approval');
  assert.equal(on.needsApproval.length, 1);
  assert.deepEqual((await migrationQueueCheck({ root, changes: [{ file: 'src/a.ts', bytes: Buffer.from('x') }], profile: { migrations: {} } })).blocks, []);
  assert.deepEqual((await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/001_a.sql', bytes: null }], profile: { migrations: {} } })).blocks, [], 'a deleted migration is not checked');
  await put(root, 'supabase/migrations/002_ok.sql', 'create table b (id int);\n');
  await put(root, 'supabase/migrations/002_ok.down.sql', 'drop table b;\n');
  const failing = await migrationQueueCheck({ root, changes: [{ file: 'supabase/migrations/002_ok.sql', bytes: Buffer.from('x') }], profile: { migrations: { commands: { up: ['u'], down: ['d'] } } }, exec: async argv => ({ exitCode: argv[0] === 'd' ? 1 : 0, stdout: '', stderr: 'down failed' }) });
  assert.match(failing.blocks[0].message, /round trip failed at down/);
});

test('profile: the migrations block is validated and its scripts are protected', () => {
  const ok = validateProfile({ migrations: { down: 'section', commands: { up: ['node', 'scripts/up.mjs'], down: ['node', 'scripts/down.mjs'] } } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.profile.migrations.down, 'section');
  assert.ok(ok.profile.protectedPaths.includes('scripts/up.mjs'));
  const bad = validateProfile({ migrations: { dir: '../x', commands: { up: 'npm run up' } } });
  assert.ok(bad.errors.some(message => message.startsWith('profile.migrations:')));
});

test('a running autopilot loop stops at its next step when the marker appears', async t => {
  const root = await tmp(t);
  await put(root, '.swarm/stop.json', JSON.stringify({ at: new Date().toISOString(), reason: 'test' }));
  const results = await runAutopilot(root, {}, { once: false, maxSteps: 5, sleep: async () => {} });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'stopped');
});
