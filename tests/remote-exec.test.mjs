// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultHostTransport, hashBytes, resolveHosts } from '../tools/executors.mjs';

const script = new URL('../tools/remote-exec.mjs', import.meta.url);
const id = 'abcdef0123456789';
const encode = text => Buffer.from(text).toString('base64');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-exec-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function launch(t, request = {}, argv = []) {
  const dir = fixture(t);
  const child = spawn(process.execPath, [script.pathname, ...argv], {
    env: { ...process.env, SWARM_REMOTE_JOBS: dir, TMPDIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  if (!argv.length) child.stdin.write(JSON.stringify({ id, command: process.execPath, args: ['-e', ''], files: [], outputs: [], ...request }) + '\n');
  return { child, done, dir };
}

test('real command receives workspace files and stdin, returns bytes, digest and skips missing output', { timeout: 10000 }, async t => {
  const { done } = launch(t, {
    args: ['-e', `const fs = require('fs'); const input = fs.readFileSync(0, 'utf8'); fs.writeFileSync('out', fs.readFileSync('nested/in', 'utf8') + input); console.log(JSON.stringify({cwd:process.cwd(), mode:fs.statSync('.').mode & 511}));`],
    files: [{ path: 'nested/in', bytes: encode('hello ') }], stdin: 'world 🐈', outputs: ['out', 'missing'],
  });
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const response = JSON.parse(result.stdout);
  assert.equal(response.id, id);
  assert.equal(response.exitCode, 0);
  assert.deepEqual(response.files, [{ path: 'out', bytes: encode('hello world 🐈'), sha256: hashBytes(Buffer.from('hello world 🐈')) }]);
  const info = JSON.parse(Buffer.from(response.stdout, 'base64'));
  assert.equal(info.mode, 0o700);
  assert.equal(fs.existsSync(info.cwd), false);
});

test('nonzero exit is a job result', { timeout: 10000 }, async t => {
  const result = await launch(t, { args: ['-e', 'process.stdout.write("failed"); process.exitCode = 7;'] }).done;
  assert.equal(result.code, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.exitCode, 7);
  assert.equal(Buffer.from(response.stdout, 'base64').toString(), 'failed');
});

test('only allowlisted environment travels and HOME is the workspace', { timeout: 10000 }, async t => {
  const env = { PATH: '/example/bin', LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C', TERM: 'dumb', TZ: 'UTC', SWARM_PORT_BASE: '1234', HOME: '/forbidden', TOKEN: 'secret' };
  const result = await launch(t, { args: ['-e', 'console.log(JSON.stringify({env:process.env,cwd:process.cwd()}))'], env }).done;
  assert.equal(result.code, 0);
  const info = JSON.parse(Buffer.from(JSON.parse(result.stdout).stdout, 'base64'));
  assert.equal(info.env.HOME, info.cwd);
  // macOS adds this value inside the launched process, independently of spawn's env.
  const { HOME, __CF_USER_TEXT_ENCODING, ...rest } = info.env;
  const { HOME: ignored, TOKEN, ...expected } = env;
  assert.deepEqual(rest, expected);
});

for (const bad of ['/tmp/absolute', '../escape', 'a/../b', 'a\\..\\b', '.env', '.env.local', 'a/.ENV', '.git/config', '.swarm/state', '.ssh/key', '.aws/config', '.gnupg/key']) {
  for (const field of ['files', 'outputs']) {
    test(`refuses ${field} path ${bad}`, { timeout: 10000 }, async t => {
      const result = await launch(t, { [field]: field === 'files' ? [{ path: bad, bytes: encode('bad') }] : [bad] }).done;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
    });
  }
}

for (const command of ['node', '/bin/node\0', '/bin/node\n', '/bin/node\r']) {
  test(`refuses invalid command ${JSON.stringify(command)}`, { timeout: 10000 }, async t => {
    const result = await launch(t, { command }).done;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
  });
}

for (const parent of [false, true]) {
  test(`refuses ${parent ? 'parent' : 'file'} symlink in outputs`, { timeout: 10000 }, async t => {
    const result = await launch(t, {
      args: ['-e', parent ? `require('fs').symlinkSync(process.env.HOME, 'link')` : `require('fs').writeFileSync('target','data'); require('fs').symlinkSync('target','link')`],
      outputs: [parent ? 'link/missing' : 'link'],
    }).done;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
  });
}

test('stdout is capped at 4 MiB while the pipe continues draining', { timeout: 10000 }, async t => {
  const result = await launch(t, { args: ['-e', `process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 65));`] }).done;
  assert.equal(result.code, 0);
  const bytes = Buffer.from(JSON.parse(result.stdout).stdout, 'base64');
  assert.equal(bytes.length, 4 * 1024 * 1024);
  assert.equal(bytes.equals(Buffer.alloc(bytes.length, 65)), true);
});

async function waitRecord(dir) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { const record = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`))); if (record.pid) return record; } catch {}
    await delay(10);
  }
  throw new Error('job record not written');
}

async function assertDead(pid) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await delay(10);
  }
  assert.fail(`pid ${pid} survived`);
}

for (const signal of ['stdin', 'SIGHUP', 'SIGTERM']) {
  test(`kills the process group on ${signal}`, { timeout: 10000 }, async t => {
    const { child, done, dir } = launch(t, { args: ['-e', 'setInterval(() => {}, 1000)'], costUsd: 0.25 });
    const record = await waitRecord(dir);
    if (signal === 'stdin') child.stdin.end(); else child.kill(signal);
    const result = await done;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    await assertDead(record.pid);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`))), { costUsd: 0.25 });
  });
}

test('--kill kills recorded job and reports cost', { timeout: 10000 }, async t => {
  const { done, dir } = launch(t, { args: ['-e', 'setInterval(() => {}, 1000)'], costUsd: 0.75 });
  const record = await waitRecord(dir);
  const killer = spawn(process.execPath, [script.pathname, '--kill', id], { env: { ...process.env, SWARM_REMOTE_JOBS: dir } });
  let output = '';
  killer.stdout.on('data', chunk => { output += chunk; });
  assert.equal((await once(killer, 'close'))[0], 0);
  assert.deepEqual(JSON.parse(output), { costUsd: 0.75 });
  await done;
  await assertDead(record.pid);
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), false);
});

function fakeTransport(response, inspect) {
  return defaultHostTransport({ spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', input => {
      inspect?.(JSON.parse(input), { command, args, options });
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify(response) + '\n');
        child.emit('exit', 0);
      });
    });
    return child;
  } });
}

test('transport sends the complete request and decodes and checks the response', async () => {
  const bytes = Buffer.from([0, 255, 128, 10]);
  const response = { id, exitCode: 9, stdout: encode('output'), files: [{ path: 'out', bytes: bytes.toString('base64'), sha256: hashBytes(bytes) }] };
  const transport = fakeTransport(response, request => {
    assert.deepEqual(request, { id, command: '/opt/hermes', args: ['run'], stdin: 'message', keepHome: false, env: { LANG: 'C' }, files: [{ path: 'in', bytes: encode('input') }], outputs: ['out'] });
  });
  const result = await transport.run({ host: { kind: 'ssh', target: 'worker' }, jobId: id, command: '/opt/hermes', args: ['run'], stdin: 'message', env: { LANG: 'C', SECRET: 'hidden' }, files: [{ path: 'in', bytes: Buffer.from('input') }], outputs: ['out'] });
  assert.deepEqual(result, { exitCode: 9, stdout: Buffer.from('output'), files: [{ path: 'out', bytes, sha256: hashBytes(bytes) }] });
});

for (const response of [
  { id: '01234567', files: [] },
  { id, files: [{ path: 'out', bytes: encode('bad'), sha256: hashBytes(Buffer.from('good')) }] },
]) {
  test('transport refuses mismatched id or sha256', async () => {
    await assert.rejects(fakeTransport(response).run({ host: { kind: 'ssh', target: 'worker' }, jobId: id, command: '/opt/hermes' }), { code: 'host-pull-mismatch' });
  });
}

test('host commands preserve absolute agent paths and reject invalid mappings', () => {
  const host = { id: 'worker', kind: 'ssh', target: 'worker', capacity: 1, commands: { hermes: '/opt/hermes', qwen: '/opt/qwen' } };
  const [resolved] = resolveHosts([host]);
  assert.deepEqual(resolved.commands, host.commands);
  assert.notEqual(resolved.commands, host.commands);
  for (const commands of [null, [], 'bad', { hermes: 'hermes' }, { hermes: '/bin/x\n' }, { hermes: '/bin/x\0' }, { hermes: 1 }]) {
    assert.throws(() => resolveHosts([{ ...host, commands }]), { code: 'hosts-invalid' });
  }
});

for (const badId of ['1234567', 'a'.repeat(33), 'ABCD1234', 12345678]) {
  test(`refuses invalid id ${badId}`, { timeout: 10000 }, async t => {
    const result = await launch(t, { id: badId }).done;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
  });
}

test('remote-exec is self-contained and its helper copies match the ones in executors.mjs', async () => {
  const source = fs.readFileSync(new URL('../tools/remote-exec.mjs', import.meta.url), 'utf8');
  assert.equal(/from '\.\.?\//.test(source), false, 'remote-exec must not import project files');
  const mine = await import('../tools/remote-exec.mjs');
  const theirs = await import('../tools/executors.mjs');
  for (const path of ['a.txt', '.env', '.ENV.local', 'x/.git/config', 'dir/.ssh', 'ok/../.aws/c', '.gnupg', 'envfile', '.environment', 'a\\.swarm\\b']) assert.equal(mine.isSecretPath(path), theirs.isSecretPath(path), path);
  const env = { PATH: '/bin', LANG: 'C', HOME: '/h', OPENAI_API_KEY: 'k', TZ: 'UTC', SWARM_PORT_BASE: '1', LC_ALL: 'C', TERM: 'x', LC_CTYPE: 'C' };
  assert.deepEqual(mine.remoteEnv(env), theirs.remoteEnv(env));
  assert.equal(mine.hashBytes(Buffer.from('abc')), theirs.hashBytes(Buffer.from('abc')));
});


// --- hardening found by the Phase 10b security review ---------------------------------------------
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const scriptPath = fileURLToPath(script);

// stdin stays open after the request line: closing it is how a caller says "the connection dropped".
function runRequest(request, { dir, env = {}, wait = 8000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, SWARM_REMOTE_JOBS: dir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), wait);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
const jobDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rexec-jobs-'));
const idOf = () => Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16);

test('the default job folder is private to the user and a planted or foreign folder is refused', async () => {
  const dir = jobDir();
  fs.chmodSync(dir, 0o755);
  const ok = await runRequest({ id: idOf(), command: process.execPath, args: ['-e', '0'], stdin: '', files: [], outputs: [] }, { dir });
  assert.equal(ok.status, 0);
  assert.equal(fs.statSync(dir).mode & 0o077, 0, 'permissions tightened to 0700');
  const planted = path.join(os.tmpdir(), `swarm-rexec-link-${process.pid}`);
  fs.symlinkSync(dir, planted);
  const refused = await runRequest({ id: idOf(), command: process.execPath, args: ['-e', '0'], stdin: '', files: [], outputs: [] }, { dir: planted });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  fs.rmSync(planted);
});

test('outputs: a FIFO is skipped; a symlink output, an oversize file or too many outputs refuse the job', async () => {
  const dir = jobDir();
  const sh = '/bin/sh';
  const done = await runRequest({ id: idOf(), command: sh, args: ['-c', 'mkfifo pipe; echo ok > file.txt'], stdin: '', files: [], outputs: ['pipe', 'file.txt'] }, { dir });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout).files.map(file => file.path), ['file.txt']);
  const link = await runRequest({ id: idOf(), command: sh, args: ['-c', 'ln -s /etc/hostname link'], stdin: '', files: [], outputs: ['link'] }, { dir });
  assert.equal(link.status, 1, 'a symlink output could point anywhere, so the job is refused');
  assert.equal(link.stdout, '');
  const big = await runRequest({ id: idOf(), command: sh, args: ['-c', 'head -c 34000000 /dev/zero > big.bin'], stdin: '', files: [], outputs: ['big.bin'] }, { dir, wait: 30000 });
  assert.equal(big.status, 1, 'a 34 MB output is over the 32 MiB limit');
  assert.equal(big.stdout, '');
  const many = await runRequest({ id: idOf(), command: sh, args: ['-c', 'true'], stdin: '', files: [], outputs: Array.from({ length: 65 }, (_, n) => `f${n}`) }, { dir });
  assert.equal(many.status, 1);
  assert.equal(many.stdout, '');
});

test('a background process left behind is killed when the job ends, and the job still finishes', async () => {
  const dir = jobDir();
  const marker = path.join(dir, 'grandchild-alive');
  const started = Date.now();
  // The shell exits at once; its background child keeps stdout open and would touch the marker later.
  const done = await runRequest({ id: idOf(), command: '/bin/sh', args: ['-c', `(sleep 3; touch ${marker}) & echo started`], stdin: '', files: [], outputs: [] }, { dir, wait: 20000 });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(Buffer.from(JSON.parse(done.stdout).stdout, 'base64').toString(), 'started\n');
  assert.ok(Date.now() - started < 4500, 'the job did not wait for the stray process');
  const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  wait(3500);
  assert.equal(fs.existsSync(marker), false, 'the stray process was killed before it could act');
});

test('keepHome keeps the account HOME for a CLI that needs its own config; otherwise HOME is the workspace', async () => {
  const dir = jobDir();
  const probe = ['-e', "process.stdout.write(process.env.HOME)"];
  const own = JSON.parse((await runRequest({ id: idOf(), command: process.execPath, args: probe, stdin: '', files: [], outputs: [], keepHome: true }, { dir, env: { HOME: '/home/someone' } })).stdout);
  assert.equal(Buffer.from(own.stdout, 'base64').toString(), '/home/someone');
  const scratch = JSON.parse((await runRequest({ id: idOf(), command: process.execPath, args: probe, stdin: '', files: [], outputs: [] }, { dir, env: { HOME: '/home/someone' } })).stdout);
  assert.match(Buffer.from(scratch.stdout, 'base64').toString(), /swarm-remote-exec-/);
});
