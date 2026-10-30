// SPDX-License-Identifier: Apache-2.0
// machineConcurrency goes back to its old value when a guarded run ends: normal exit, failure, Ctrl-C, SIGTERM, a kill of the wrapper itself, and the next command after a power cut.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { apply, restore, restoreIfStale, runGuarded, markerPath, runWithConcurrency } from '../tools/concurrency-guard.mjs';

const SWARM = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, config = { machineConcurrency: 4, lanes: { anthropic: { model: 'm' } } }) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'guard-')));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  if (config !== null) await fsp.writeFile(file, JSON.stringify(config));
  const env = { ...process.env, HOME: dir, SWARM_CONFIG: file, SWARM_BOARD_FILE: path.join(dir, 'board.json'), SWARM_PROJECTS_FILE: path.join(dir, 'projects.json'), SWARM_HISTORY_FILE: path.join(dir, 'h.ndjson'), SWARM_LANES_DIR: path.join(dir, 'lanes'), SWARM_SPEND_DIR: path.join(dir, 'spend'), SWARM_PHONE_DIR: path.join(dir, 'phone') };
  return { dir, file, env, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; }

test('apply sets the value and writes the marker first; restore puts the old value back and keeps every other setting', async t => {
  const f = await fixture(t);
  const r = apply(f.file, 16);
  assert.deepEqual([r.previous, r.set], [4, 16]);
  assert.equal(f.read().machineConcurrency, 16);
  assert.equal(f.read().lanes.anthropic.model, 'm');
  assert.equal(JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8')).previous, 4);
  assert.deepEqual(restore(f.file), { restored: true, to: 4 });
  assert.equal(f.read().machineConcurrency, 4);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
  assert.deepEqual(restore(f.file), { restored: false, reason: 'no marker' }, 'idempotent');
});

test('an unset value is unset again afterwards (the key is removed, not left at some number)', async t => {
  const f = await fixture(t, { lanes: {} });
  apply(f.file, 64);
  assert.equal(f.read().machineConcurrency, 64);
  restore(f.file);
  assert.equal('machineConcurrency' in f.read(), false);
});

test('a value the owner changed meanwhile is never overwritten', async t => {
  const f = await fixture(t);
  apply(f.file, 16);
  fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), machineConcurrency: 8 }));
  assert.match(restore(f.file).reason, /changed meanwhile/);
  assert.equal(f.read().machineConcurrency, 8);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
});

test('bad input changes nothing: a value outside 1 to 2048, a missing or invalid config, a config that is not an object', async t => {
  const f = await fixture(t);
  for (const bad of [0, 2049, 1.5, -3, NaN, '16']) assert.throws(() => apply(f.file, bad), /Usage/, String(bad));
  assert.equal(f.read().machineConcurrency, 4);
  const none = await fixture(t, null);
  assert.throws(() => apply(none.file, 16), /missing or is not valid JSON/);
  assert.equal(fs.existsSync(markerPath(none.file)), false);
  fs.writeFileSync(none.file, '{ not json');
  assert.throws(() => apply(none.file, 16), /not valid JSON/);
  assert.equal(fs.readFileSync(none.file, 'utf8'), '{ not json');
  fs.writeFileSync(none.file, '[1]');
  assert.throws(() => apply(none.file, 16), /not a JSON object/);
});

test('a second guarded run is refused while the first is alive; a leftover marker of a dead process is restored first', async t => {
  const f = await fixture(t);
  apply(f.file, 16, { pid: process.pid });
  assert.throws(() => apply(f.file, 32), /another guarded run/);
  assert.equal(f.read().machineConcurrency, 16);
  restore(f.file);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;   // a pid that has exited
  fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), machineConcurrency: 16 }));
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: dead, at: 'x' }));
  assert.deepEqual(restoreIfStale(f.file), { restored: true, to: 4 });
  assert.equal(f.read().machineConcurrency, 4);
  const second = apply(f.file, 32);
  assert.equal(second.previous, 4);
  restore(f.file);
});

function fakeChild(behaviour) {
  const child = new EventEmitter();
  child.kill = signal => { child.killed = signal; setImmediate(() => child.emit('exit', null, signal)); };
  setImmediate(() => behaviour(child));
  return child;
}

test('runGuarded puts the value back after a normal exit, a failing command, and a command that cannot start', async t => {
  for (const [name, behaviour, code] of [['exit 0', c => c.emit('exit', 0, null), 0], ['exit 3', c => c.emit('exit', 3, null), 3], ['no start', c => c.emit('error', new Error('ENOENT')), 127]]) {
    const f = await fixture(t);
    let during = null;
    const result = await runGuarded({ value: 16, args: ['version'], env: f.env, configFile: f.file, startWatcher: false, spawnImpl: () => { during = f.read().machineConcurrency; return fakeChild(behaviour); } });
    assert.equal(during, 16, `${name}: raised while the command ran`);
    assert.equal(result.code, code, name);
    assert.equal(f.read().machineConcurrency, 4, `${name}: back to 4`);
    assert.equal(fs.existsSync(markerPath(f.file)), false);
  }
});

test('runGuarded records the child process start time and command line with its pid', async t => {
  const f = await fixture(t);
  const child = fakeChild(() => {});
  child.pid = 123457;
  const seen = [];
  const running = runGuarded({
    value: 16, args: ['watch'], env: f.env, configFile: f.file, startWatcher: false,
    spawnImpl: () => child,
    procStart: () => 'recorded start',
    procIdentity: pid => { seen.push(pid); return { start: 'recorded start', command: 'recorded command' }; },
  });
  const marker = JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8'));
  child.emit('exit', 0, null);
  assert.equal((await running).code, 0);
  assert.equal(marker.childPid, child.pid);
  assert.equal(marker.childProcStart, 'recorded start');
  assert.equal(marker.childCommand, 'recorded command');
  assert.deepEqual(seen, [child.pid]);
  assert.equal(f.read().machineConcurrency, 4);
});

test('runGuarded restores when the wrapper itself is told to stop (SIGTERM forwarded to the command)', async t => {
  const f = await fixture(t);
  let childAttached;
  const childAttachedP = new Promise(resolve => { childAttached = resolve; });
  const child = fakeChild(() => {});
  const running = runGuarded({ value: 16, args: ['watch', '--all'], env: f.env, configFile: f.file, startWatcher: false, spawnImpl: () => { childAttached(); return child; } });
  await childAttachedP;
  assert.equal(f.read().machineConcurrency, 16);
  process.emit('SIGTERM');
  const result = await running;
  assert.equal(child.killed, 'SIGTERM');
  assert.equal(result.code, 143);
  assert.equal(f.read().machineConcurrency, 4);
});

test('usage: a missing --, no command, a value outside 1 to 2048, or wrapping itself is refused and changes nothing', async t => {
  const f = await fixture(t);
  for (const argv of [[], ['16'], ['16', '--'], ['0', '--', 'version'], ['3000', '--', 'version'], ['x', '--', 'version'], ['16', 'version'], ['16', '--', 'with-concurrency', '8', '--', 'version']]) {
    const r = await runWithConcurrency(argv, { env: f.env });
    assert.equal(r.exitCode, 2, JSON.stringify(argv));
    assert.equal(f.read().machineConcurrency, 4);
  }
});

// ---- as real processes ----
function start(f, args) {
  const child = spawn(process.execPath, [SWARM, 'with-concurrency', ...args], { env: f.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  return { child, output: () => out, exited: new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal }))) };
}
const killGroup = (p, signal = 'SIGKILL') => { try { process.kill(-p.child.pid, signal); } catch { /* gone */ } };

test('process: a normal command raises the value while it runs and puts it back; the exit code and a note are passed on', async t => {
  const f = await fixture(t);
  const r = spawnSync(process.execPath, [SWARM, 'with-concurrency', '16', '--', 'version'], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /machineConcurrency was 4, set to 16 for this command, and is back to 4/);
  assert.equal(f.read().machineConcurrency, 4);
  const bad = spawnSync(process.execPath, [SWARM, 'with-concurrency', '16', '--', 'validate', 'nope.json'], { env: f.env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.equal(f.read().machineConcurrency, 4, 'back to 4 after a failing command too');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`process: ${signal} to a running guarded command (Ctrl-C) puts the value back`, async t => {
    const f = await fixture(t);
    const p = start(f, ['16', '--', 'watch', '--all']);
    t.after(() => killGroup(p));
    assert.ok(await until(() => { try { return f.read().machineConcurrency === 16; } catch { return false; } }), 'raised while it runs');
    process.kill(p.child.pid, signal);
    const ended = await Promise.race([p.exited, sleep(20000).then(() => null)]);
    assert.ok(ended, `the wrapper ended after ${signal}: ${p.output()}`);
    assert.equal(f.read().machineConcurrency, 4);
    assert.equal(fs.existsSync(markerPath(f.file)), false);
  });
}

test('process: the wrapper killed outright (SIGKILL, a crash) is restored by the watcher within seconds', async t => {
  const f = await fixture(t);
  const p = start(f, ['16', '--', 'watch', '--all']);
  t.after(() => killGroup(p));
  assert.ok(await until(() => { try { return f.read().machineConcurrency === 16 && fs.existsSync(markerPath(f.file)); } catch { return false; } }));
  await sleep(500);   // the watcher is up
  const childPid = await (async () => { for (let i = 0; i < 100; i += 1) { try { const c = JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8')).childPid; if (c) return c; } catch { /* not yet */ } await sleep(50); } return null; })();
  assert.ok(childPid, 'the marker names the command\'s pid');
  const marker = JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8'));
  for (const field of ['childProcStart', 'childCommand']) assert.ok(Object.hasOwn(marker, field), `the marker records ${field}, including an unreadable identity`);
  process.kill(p.child.pid, 'SIGKILL');
  await p.exited;
  assert.ok(await until(() => { try { return f.read().machineConcurrency === 4; } catch { return false; } }, 30000), 'restored by the watcher');
  assert.ok(await until(() => !fs.existsSync(markerPath(f.file)), 15000));
  assert.ok(await until(() => { try { process.kill(childPid, 0); return false; } catch { return true; } }, 15000), 'the orphaned command was stopped before the value went back');
});

test('process: after a power cut (a leftover marker, its owner gone) the next swarm command puts the value back', async t => {
  const f = await fixture(t, { machineConcurrency: 16, lanes: {} });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: dead, at: 'x' }));
  const r = spawnSync(process.execPath, [SWARM, 'version'], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.read().machineConcurrency, 4);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
});

test('a Ctrl-C in the moment between raising the value and the command starting is passed on, and the value still goes back', async t => {
  const f = await fixture(t);
  let child;
  // apply() has written 16 by the time spawnImpl runs; the signal arrives right there, before the wrapper holds the child.
  const running = runGuarded({ value: 16, args: ['watch', '--all'], env: f.env, configFile: f.file, startWatcher: false, spawnImpl: () => { child = fakeChild(() => {}); process.emit('SIGINT'); return child; } });
  const result = await running;
  assert.equal(child.killed, 'SIGINT');
  assert.equal(result.code, 130);
  assert.equal(f.read().machineConcurrency, 4);
});

test('Ctrl-C: a command that ends on its own after the terminal signal gets no second signal; one that keeps running gets exactly one', async t => {
  const f = await fixture(t);
  let endsAttached;
  const endsAttachedP = new Promise(resolve => { endsAttached = resolve; });
  const ends = fakeChild(() => {});
  const kills = [];
  ends.kill = sig => kills.push(sig);
  const first = runGuarded({ value: 16, args: ['watch'], env: f.env, configFile: f.file, startWatcher: false, spawnImpl: () => { endsAttached(); return ends; } });
  await endsAttachedP;
  process.emit('SIGINT');
  setImmediate(() => ends.emit('exit', 130, null));   // the terminal's own SIGINT ended it
  assert.equal((await first).code, 130);
  const sigAt = Date.now();
  assert.ok(await until(() => kills.length === 0 && Date.now() - sigAt > 250, 5000), `no forwarded signal; kills=${JSON.stringify(kills)}`);
  const f2 = await fixture(t);
  let staysAttached;
  const staysAttachedP = new Promise(resolve => { staysAttached = resolve; });
  const stays = fakeChild(() => {});
  const second = runGuarded({ value: 16, args: ['watch'], env: f2.env, configFile: f2.file, startWatcher: false, spawnImpl: () => { staysAttached(); return stays; } });
  await staysAttachedP;
  process.emit('SIGINT');
  const keep = setTimeout(() => {}, 5000);
  assert.equal((await second).code, 130);
  clearTimeout(keep);
  assert.equal(stays.killed, 'SIGINT');
});

const GUARD = fileURLToPath(new URL('../tools/concurrency-guard.mjs', import.meta.url));

test('restoreIfStale: a stale marker naming this process as childPid exits before running and leaves the marker', async t => {
  const f = await fixture(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { restoreIfStale, markerPath } from ${JSON.stringify(GUARD)};
    const configFile = process.argv[1];
    const dead = Number(process.argv[2]);
    fs.writeFileSync(configFile, JSON.stringify({ machineConcurrency: 16, lanes: { anthropic: { model: 'm' } } }));
    const childProcStart = 'recorded start';
    fs.writeFileSync(markerPath(configFile), JSON.stringify({ previous: 4, set: 16, pid: dead, childPid: process.pid, childProcStart, childCommand: 'recorded command', at: new Date().toISOString() }));
    restoreIfStale(configFile, { procStart: () => childProcStart, procIdentity: () => ({ start: childProcStart, command: 'recorded command' }) });
    console.log('ran command');
  `, f.file, String(dead)], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 143, r.stderr);
  assert.match(r.stderr, /concurrency-guard/);
  assert.match(r.stderr, /this process is the orphaned command of a dead guarded run/);
  assert.match(r.stderr, /command was NOT run/);
  assert.match(r.stderr, /machineConcurrency is still raised/);
  assert.match(r.stderr, /restored by the watcher or the next command/);
  assert.doesNotMatch(r.stdout, /ran command/);
  assert.equal(f.read().machineConcurrency, 16);
  assert.equal(fs.existsSync(markerPath(f.file)), true);
});

test('restoreIfStale: a stale marker with a live orphaned child sends SIGTERM once and does not restore', async t => {
  const f = await fixture(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const holder = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(143));setInterval(()=>{},1<<30);'], { stdio: 'ignore' });
  t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } });
  assert.ok(await until(() => { try { process.kill(holder.pid, 0); return true; } catch { return false; } }, 5000));
  fs.writeFileSync(f.file, JSON.stringify({ ...f.read(), machineConcurrency: 16 }));
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: dead, childPid: holder.pid, childProcStart: 'recorded start', childCommand: 'recorded command', at: new Date().toISOString() }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { restoreIfStale } from ${JSON.stringify(GUARD)};
    console.log(JSON.stringify(restoreIfStale(process.argv[1], { procStart: () => 'recorded start', procIdentity: () => ({ start: 'recorded start', command: 'recorded command' }) })));
  `, f.file], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { restored: false, reason: 'orphaned command still running' });
  assert.equal(f.read().machineConcurrency, 16);
  assert.equal(fs.existsSync(markerPath(f.file)), true);
  assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8')).termSentAt));
  assert.ok(await until(() => { try { process.kill(holder.pid, 0); return false; } catch { return true; } }, 5000), 'orphan received SIGTERM');
});

for (const childPid of [123456, process.pid]) {
  test(`restoreIfStale: a pre-boot marker restores without probing, signalling, or exiting for child ${childPid}`, async t => {
    const f = await fixture(t, { machineConcurrency: 16 });
    const at = new Date(Date.now() - os.uptime() * 1000 - 60_000).toISOString();
    fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: process.pid, childPid, childProcStart: 'same', childCommand: 'same command', at }));
    const calls = [];
    const result = restoreIfStale(f.file, {
      isAlive: pid => { calls.push(['alive', pid]); return true; },
      procStart: pid => { calls.push(['start', pid]); return 'same'; },
      procIdentity: pid => { calls.push(['identity', pid]); return { start: 'same', command: 'same command' }; },
      kill: (...args) => calls.push(['kill', ...args]),
      exit: code => calls.push(['exit', code]),
    });
    assert.deepEqual(result, { restored: true, to: 4 });
    assert.deepEqual(calls, []);
    assert.equal(f.read().machineConcurrency, 4);
    assert.equal(fs.existsSync(markerPath(f.file)), false);
  });
}

for (const currentStart of ['new process', null]) {
  test(`restoreIfStale: a mismatched or unreadable child start (${currentStart}) restores without signalling or exiting`, async t => {
    const f = await fixture(t, { machineConcurrency: 16 });
    fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid: process.pid, childProcStart: 'old process', childCommand: 'same command', at: new Date().toISOString() }));
    const calls = [];
    assert.deepEqual(restoreIfStale(f.file, {
      isAlive: pid => pid === process.pid,
      procStart: () => currentStart,
      procIdentity: () => ({ start: currentStart, command: 'same command' }),
      kill: (...args) => calls.push(['kill', ...args]),
      exit: code => calls.push(['exit', code]),
    }), { restored: true, to: 4 });
    assert.deepEqual(calls, []);
    assert.equal(f.read().machineConcurrency, 4);
    assert.equal(fs.existsSync(markerPath(f.file)), false);
  });
}

test('restoreIfStale: an EPERM-alive child restores without signalling or exiting', async t => {
  const f = await fixture(t, { machineConcurrency: 16 });
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid: process.pid, childProcStart: 'same', childCommand: 'same command', at: new Date().toISOString() }));
  const calls = [];
  assert.deepEqual(restoreIfStale(f.file, {
    isAlive: pid => pid === process.pid,
    procStart: () => 'same',
    procIdentity: () => ({ start: 'same', command: 'same command' }),
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      throw Object.assign(new Error('another user'), { code: 'EPERM' });
    },
    exit: code => calls.push(['exit', code]),
  }), { restored: true, to: 4 });
  assert.deepEqual(calls, [[process.pid, 0]]);
  assert.equal(f.read().machineConcurrency, 4);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
});

test('restoreIfStale: SIGTERM is persisted and never repeated, including after 30 seconds', async t => {
  const f = await fixture(t, { machineConcurrency: 16 });
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid: 123457, childProcStart: 'same', childCommand: 'same command', at: new Date().toISOString() }));
  const calls = [];
  let now = Date.now();
  const sentAt = now;
  const deps = {
    isAlive: pid => pid === 123457,
    procStart: () => 'same',
    procIdentity: () => ({ start: 'same', command: 'same command' }),
    kill: (...args) => calls.push(args),
    now: () => now,
  };
  for (const elapsed of [0, 1000, 31_000]) {
    now = sentAt + elapsed;
    assert.deepEqual(restoreIfStale(f.file, deps), { restored: false, reason: 'orphaned command still running' });
    assert.equal(JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8')).termSentAt, sentAt);
    assert.equal(f.read().machineConcurrency, 16);
  }
  assert.deepEqual(calls.filter(([, signal]) => signal !== 0), [[123457, 'SIGTERM']]);
  deps.isAlive = () => false;
  assert.deepEqual(restoreIfStale(f.file, deps), { restored: true, to: 4 });
});

for (const childPid of [123457, process.pid]) {
  for (const command of ['different command', null, '']) {
    test(`restoreIfStale: matching start but mismatched or unreadable command (${command}) restores for child ${childPid}`, async t => {
      const f = await fixture(t, { machineConcurrency: 16 });
      fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid, childProcStart: 'same', childCommand: 'recorded command', at: new Date().toISOString() }));
      const calls = [];
      const result = restoreIfStale(f.file, {
        isAlive: pid => pid === childPid,
        procStart: () => 'same',
        procIdentity: () => ({ start: 'same', command }),
        kill: (...args) => calls.push(['kill', ...args]),
        exit: code => calls.push(['exit', code]),
      });
      assert.deepEqual(result, { restored: true, to: 4 });
      assert.deepEqual(calls, []);
      assert.equal(f.read().machineConcurrency, 4);
      assert.equal(fs.existsSync(markerPath(f.file)), false);
    });
  }
}

for (const field of ['childProcStart', 'childCommand']) {
  for (const value of [undefined, null, '', '   ']) {
    test(`restoreIfStale: missing or blank recorded ${field} (${JSON.stringify(value)}) restores safely`, async t => {
      const f = await fixture(t, { machineConcurrency: 16 });
      const marker = { previous: 4, set: 16, pid: 123456, childPid: process.pid, childProcStart: 'same', childCommand: 'same command', at: new Date().toISOString(), [field]: value };
      fs.writeFileSync(markerPath(f.file), JSON.stringify(marker));
      const calls = [];
      assert.deepEqual(restoreIfStale(f.file, {
        isAlive: pid => pid === process.pid,
        procStart: () => marker.childProcStart,
        procIdentity: () => ({ start: marker.childProcStart, command: marker.childCommand }),
        kill: (...args) => calls.push(['kill', ...args]),
        exit: code => calls.push(['exit', code]),
      }), { restored: true, to: 4 });
      assert.deepEqual(calls, []);
      assert.equal(f.read().machineConcurrency, 4);
      assert.equal(fs.existsSync(markerPath(f.file)), false);
    });
  }
}

test('restoreIfStale: an unreadable identity probe restores without signalling or exiting', async t => {
  const f = await fixture(t, { machineConcurrency: 16 });
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid: process.pid, childProcStart: 'same', childCommand: 'same command', at: new Date().toISOString() }));
  const calls = [];
  assert.deepEqual(restoreIfStale(f.file, {
    isAlive: pid => pid === process.pid,
    procStart: () => 'same',
    procIdentity: () => { throw new Error('cannot read process identity'); },
    kill: (...args) => calls.push(['kill', ...args]),
    exit: code => calls.push(['exit', code]),
  }), { restored: true, to: 4 });
  assert.deepEqual(calls, []);
  assert.equal(f.read().machineConcurrency, 4);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
});

test('restoreIfStale: an EPERM-alive owner restores and clears the marker without exiting', async t => {
  const f = await fixture(t, { machineConcurrency: 16 });
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid: process.pid, childProcStart: 'same', childCommand: 'same command', at: new Date().toISOString() }));
  const calls = [];
  assert.deepEqual(restoreIfStale(f.file, {
    isAlive: () => true,
    procStart: () => 'same',
    procIdentity: () => { calls.push(['identity']); return { start: 'same', command: 'same command' }; },
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      throw Object.assign(new Error('another user'), { code: 'EPERM' });
    },
    exit: code => calls.push(['exit', code]),
  }), { restored: true, to: 4 });
  assert.deepEqual(calls, [[123456, 0]]);
  assert.equal(f.read().machineConcurrency, 4);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
});

test('restoreIfStale: a safe stale marker restores and the command then runs without exiting', async t => {
  const f = await fixture(t, { machineConcurrency: 16 });
  fs.writeFileSync(markerPath(f.file), JSON.stringify({ previous: 4, set: 16, pid: 123456, childPid: process.pid, childProcStart: 'same', childCommand: 'old command', at: new Date().toISOString() }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { restoreIfStale } from ${JSON.stringify(GUARD)};
    const result = restoreIfStale(process.argv[1], {
      isAlive: pid => pid !== 123456,
      procStart: () => 'same',
      procIdentity: () => ({ start: 'same', command: 'new command' }),
      kill: () => { console.error('unexpected signal'); },
      exit: () => { console.error('unexpected exit'); process.exit(99); },
    });
    console.log(JSON.stringify(result));
    console.log('ran command');
  `, f.file], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n')[0]), { restored: true, to: 4 });
  assert.match(r.stdout, /ran command/);
  assert.equal(f.read().machineConcurrency, 4);
  assert.equal(fs.existsSync(markerPath(f.file)), false);
});

test('runGuarded: the default identity probe normalizes both ps fields', async t => {
  const f = await fixture(t);
  const child = fakeChild(() => {});
  child.pid = 123457;
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    calls.push([command, args]);
    return args[1] === 'lstart=' ? '  Fri Oct  30 12:00:00 2026\n' : '  node   swarm.mjs\twatch  \n';
  });
  syncBuiltinESMExports();
  try {
    const running = runGuarded({ value: 16, args: ['watch'], env: f.env, configFile: f.file, startWatcher: false, spawnImpl: () => child });
    const marker = JSON.parse(fs.readFileSync(markerPath(f.file), 'utf8'));
    child.emit('exit', 0, null);
    assert.equal((await running).code, 0);
    assert.equal(marker.childProcStart, 'Fri Oct 30 12:00:00 2026');
    assert.equal(marker.childCommand, 'node swarm.mjs watch');
    assert.deepEqual(calls, [
      ['ps', ['-o', 'lstart=', '-p', String(child.pid)]],
      ['ps', ['-o', 'command=', '-p', String(child.pid)]],
    ]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
