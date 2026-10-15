// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPulled, createHostPool, defaultHostTransport, hashBytes, isSecretPath, remoteEnv, resolveHosts, sshArgv } from '../tools/executors.mjs';

const hosts = () => resolveHosts([
  { id: 'local', kind: 'local', capacity: 1, heartbeatMs: 1000 },
  { id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 20 },
]);

test('host records reject bad shapes and keep ssh, sandbox, and local apart', () => {
  assert.equal(resolveHosts(undefined), null);
  assert.throws(() => resolveHosts([]), { code: 'hosts-invalid' });
  assert.throws(() => resolveHosts([{ id: 'Dev', kind: 'local', capacity: 1 }]), { code: 'hosts-invalid' });
  assert.throws(() => resolveHosts([{ id: 'box', kind: 'ssh', capacity: 1, target: 'not a host' }]), { code: 'hosts-invalid' });
  assert.throws(() => resolveHosts([{ id: 'box', kind: 'sandbox', capacity: 1 }]), { code: 'hosts-invalid' });
  const sandbox = resolveHosts([{ id: 'box', kind: 'sandbox', capacity: 2, driver: ['swarm-sandbox', '--run'] }]);
  assert.deepEqual(sandbox[0].driver, ['swarm-sandbox', '--run']);
  assert.deepEqual(sshArgv(hosts()[1], 'true').slice(0, 6), ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'worker@dev2']);
  assert.throws(() => resolveHosts([{ id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, trusted: true }]), { code: 'hosts-invalid' });
  assert.equal(resolveHosts([{ id: 'box', kind: 'sandbox', capacity: 1, driver: ['box'], trusted: true }])[0].trusted, true);
});

test('remote shipment drops secret paths and secret environment variables', () => {
  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('nested/.env.local'), true);
  assert.equal(isSecretPath('.ssh/id_ed25519'), true);
  assert.equal(isSecretPath('src/app.js'), false);
  assert.deepEqual(remoteEnv({ PATH: '/bin', OPENAI_API_KEY: 'sk-secret', HOME: '/Users/bean', LANG: 'C' }), { PATH: '/bin', LANG: 'C' });
});

test('a pulled output must match its hash and cannot be a secret path', () => {
  const bytes = Buffer.from('output\n');
  checkPulled([{ path: 'out/0.txt', bytes, sha256: hashBytes(bytes) }]);
  assert.throws(() => checkPulled([{ path: 'out/0.txt', bytes, sha256: 'nope' }]), { code: 'host-pull-mismatch' });
  assert.throws(() => checkPulled([{ path: '.env', bytes, sha256: hashBytes(bytes) }]), { code: 'host-pull-mismatch' });
});

test('a dead ssh host frees its job so the waiting job can take the live host', async () => {
  let armed = false;
  const pool = createHostPool({
    hosts: hosts(),
    ping: async host => host.id !== 'dev2' || !armed,
  });
  const first = await pool.claim();
  const second = await pool.claim();
  assert.deepEqual([first.host.id, second.host.id], ['local', 'dev2']);
  let thirdHost = null;
  const third = pool.claim().then(placement => { thirdHost = placement.host.id; return placement; });
  armed = true;
  await new Promise(resolve => second.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(second.signal.reason.code, 'host-dead');
  second.release();
  first.release();
  const placement = await third;
  assert.equal(thirdHost, 'local');
  placement.release();
  pool.close();
});

test('the default ssh transport ships no secret env and checks the pulled hash', async () => {
  const body = Buffer.from('remote output\n');
  const pulled = JSON.stringify({ files: [{ path: 'out/0.txt', bytes: body.toString('utf8'), sha256: hashBytes(body) }] });
  let seenEnv = null;
  let sent = '';
  const transport = defaultHostTransport({
    spawnImpl: (_command, args, options) => {
      seenEnv = options.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = { write(chunk) { sent += Buffer.from(chunk).toString('utf8'); }, end() {} };
      child.kill = () => {};
      process.nextTick(() => {
        if (args.at(-1) === 'swarm-remote-exec') child.stdout.emit('data', Buffer.from(pulled));
        child.emit('exit', 0);
      });
      return child;
    },
  });
  const host = hosts()[1];
  assert.equal(await transport.ping(host), true);
  const result = await transport.run({ host, jobId: 'abc12345', files: [{ path: '.env', bytes: Buffer.from('SECRET=1') }, { path: 'input.txt', bytes: Buffer.from('hi') }], outputs: ['out/0.txt'], env: { PATH: '/bin', OPENAI_API_KEY: 'sk-secret' } });
  assert.equal(seenEnv.OPENAI_API_KEY, undefined);
  assert.equal(seenEnv.PATH, '/bin');
  assert.match(sent, /"id":"abc12345"/);
  assert.equal(result.files[0].bytes.toString(), 'remote output\n');
});

test('a sensitive job skips an untrusted sandbox and can use ssh or a trusted sandbox', async () => {
  const pool = createHostPool({
    hosts: resolveHosts([
      { id: 'box', kind: 'sandbox', capacity: 1, driver: ['box'], heartbeatMs: 1000 },
      { id: 'safe', kind: 'sandbox', capacity: 1, driver: ['box'], trusted: true, heartbeatMs: 1000 },
      { id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 1000 },
    ]),
    ping: async () => true,
  });
  const first = await pool.claim({ sensitive: true });
  const second = await pool.claim({ sensitive: true });
  assert.deepEqual([first.host.id, second.host.id], ['safe', 'dev2']);
  const third = await pool.claim({ sensitive: false });
  assert.equal(third.host.id, 'box');
  first.release(); second.release(); third.release();
  pool.close();
  const blocked = createHostPool({
    hosts: resolveHosts([{ id: 'box', kind: 'sandbox', capacity: 1, driver: ['box'], heartbeatMs: 1000 }]),
    ping: async () => true,
  });
  await assert.rejects(blocked.claim({ sensitive: true }), { code: 'host-untrusted' });
  const open = await blocked.claim({ sensitive: false });
  assert.equal(open.host.id, 'box');
  open.release();
  blocked.close();
});

test('one missed heartbeat does not move a job', async () => {
  let failed = false;
  const pool = createHostPool({
    hosts: hosts(),
    ping: async host => {
      if (host.id !== 'dev2' || failed) return true;
      failed = true;
      return false;
    },
  });
  const placement = await pool.claim();
  assert.equal(placement.host.id, 'local');
  const remote = await pool.claim();
  assert.equal(remote.host.id, 'dev2');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no heartbeat')), 2000);
    const poll = () => { if (failed) { clearTimeout(timer); resolve(); } else setTimeout(poll, 10); };
    poll();
  });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(remote.signal.aborted, false);
  assert.equal(pool.snapshot().find(entry => entry.id === 'dev2').dead, false);
  remote.release();
  placement.release();
  pool.close();
});

test('a returning host kills orphaned job ids before it is used again', async () => {
  let up = true;
  let finishKill = null;
  let started = null;
  const killStarted = new Promise(resolve => { started = resolve; });
  const pool = createHostPool({
    hosts: resolveHosts([{ id: 'dev2', kind: 'ssh', target: 'worker@dev2', capacity: 1, heartbeatMs: 20 }]),
    ping: async () => up,
    kill: async (_host, ids) => {
      assert.deepEqual(ids, ['abc12345']);
      started();
      await new Promise(resolve => { finishKill = resolve; });
      return { costUsd: 0.4 };
    },
  });
  const first = await pool.claim();
  first.bind('abc12345');
  up = false;
  await new Promise(resolve => first.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(first.signal.reason.code, 'host-dead');
  first.release();
  up = true;
  await killStarted;
  let placed = false;
  const second = pool.claim().then(placement => { placed = true; return placement; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(placed, false);
  finishKill();
  const placement = await second;
  assert.equal(placement.host.id, 'dev2');
  assert.equal(pool.orphanSpend(), 0.4);
  placement.release();
  pool.close();
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('closing the ssh session leaves no remote process', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-remote-exec-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobsDir = path.join(root, 'jobs');
  const pidFile = path.join(root, 'pids.json');
  const remoteExec = fileURLToPath(new URL('../tools/remote-exec.mjs', import.meta.url));
  const child = spawn(process.execPath, [remoteExec], {
    env: { ...process.env, SWARM_REMOTE_JOBS: jobsDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pids = [];
  t.after(() => { child.kill('SIGKILL'); for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } });
  const script = `const fs=require('fs');const {spawn}=require('child_process');const grand=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({worker:process.pid,grand:grand.pid}));setInterval(()=>{},1000);`;
  child.stdin.write(`${JSON.stringify({ id: 'abc12345', command: process.execPath, args: ['-e', script], costUsd: 0.2 })}\n`);
  const recorded = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('remote job did not start')), 4000);
    const poll = () => fs.readFile(pidFile, 'utf8').then(text => { clearTimeout(timer); resolve(JSON.parse(text)); }).catch(() => setTimeout(poll, 20));
    poll();
  });
  pids.push(recorded.worker, recorded.grand);
  child.kill('SIGHUP');
  child.stdin.destroy();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('remote process still running')), 4000);
    const poll = () => {
      if (!alive(recorded.worker) && !alive(recorded.grand)) { clearTimeout(timer); resolve(); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
  const { stdout } = await new Promise((resolve, reject) => {
    const killer = spawn(process.execPath, [remoteExec, '--kill', 'abc12345'], {
      env: { ...process.env, SWARM_REMOTE_JOBS: jobsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    killer.stdout.on('data', chunk => { out += chunk; });
    killer.on('error', reject);
    killer.on('exit', code => code === 0 ? resolve({ stdout: out }) : reject(new Error(`kill exit ${code}`)));
  });
  assert.deepEqual(JSON.parse(stdout), { costUsd: 0.2 });
  await assert.rejects(fs.access(path.join(jobsDir, 'abc12345.json')));
});
