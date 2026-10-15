// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBrainLink } from '../tools/brain-link.mjs';

const KEY = 'sk-test-KEY-0123456789abcdef';
const CONFIG = { sshTarget: 'dev2@10.0.0.1', sshKey: '/home/u/.ssh/k', remotePort: 8000, keyCommand: 'cat ~/key', readyTimeoutMs: 20000 };
const CHAT_OK = { model: 'qwen', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
const MSGS = [{ role: 'user', content: 'hi' }];

function okJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeSpawn() {
  const listeners = {};
  const child = {
    killed: [],
    on(event, fn) { (listeners[event] ??= []).push(fn); return child; },
    once(event, fn) { return child.on(event, fn); },
    kill(signal) { child.killed.push(signal); if (signal === 'SIGTERM') child.exit(null); return true; },
    exit(code) { for (const fn of listeners.exit ?? []) fn(code, null); },
  };
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  return { spawn, child, calls };
}

function fakeExec(stdout = KEY + '\n') {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    if (typeof cb === 'function') cb(null, stdout, '');
    return Promise.resolve({ stdout, stderr: '' });
  };
  return { execFile, calls };
}

function fakeFetch({ health = () => ({ loaded: true }), chat = () => okJson(CHAT_OK) } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return String(url).endsWith('/health') ? okJson(health()) : chat(opts);
  };
  return { fetchImpl, calls };
}

function rig(over = {}) {
  let clock = 0;
  const sp = fakeSpawn();
  const ex = fakeExec(over.stdout);
  const f = fakeFetch(over.fetch);
  const deps = {
    spawn: sp.spawn,
    execFile: over.execFile ?? ex.execFile,
    fetchImpl: f.fetchImpl,
    freePort: async () => 45123,
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  return { deps, sp, ex, f };
}

async function assertCode(promise, code, step) {
  await assert.rejects(promise, err => {
    assert.equal(err.code, code);
    assert.ok(!String(err.message).includes(KEY));
    if (step) assert.match(err.message, step);
    return true;
  });
}

test('opens the tunnel and returns text, model and usage', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  const res = await link.chat(MSGS, { maxTokens: 50, temperature: 0.1 });
  assert.equal(res.text, 'hello');
  assert.equal(res.model, 'qwen');
  assert.deepEqual(res.usage, { inTokens: 7, outTokens: 3 });
  assert.equal(link.status().up, true);
  const body = JSON.parse(r.f.calls.find(c => c.url.endsWith('/v1/chat/completions')).opts.body);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 50);
  link.close();
});

test('tunnel is spawned without a shell and with the required ssh options', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  const t = r.sp.calls[0];
  const line = t.args.join(' ');
  assert.equal(t.cmd, 'ssh');
  assert.ok(!t.opts?.shell);
  assert.ok(line.includes('-N'));
  assert.ok(line.includes('127.0.0.1:45123:127.0.0.1:8000'));
  assert.ok(line.includes(CONFIG.sshTarget));
  for (const o of ['ExitOnForwardFailure=yes', 'ServerAliveInterval=10', 'ServerAliveCountMax=3']) assert.ok(line.includes(o));
  link.close();
});

test('the key command runs over ssh with batch and identity options', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  const line = r.ex.calls[0].args.join(' ');
  for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'ConnectTimeout=10']) assert.ok(line.includes(o));
  assert.ok(line.includes('cat ~/key'));
  link.close();
});

test('health polling waits until loaded is not false', async () => {
  let n = 0;
  const r = rig({ fetch: { health: () => ({ loaded: ++n >= 3 }) } });
  const link = await openBrainLink(CONFIG, r.deps);
  assert.equal(link.status().up, true);
  assert.ok(n >= 3);
  link.close();
});

test('health that never loads throws brain-unavailable naming the step', async () => {
  const r = rig({ fetch: { health: () => ({ loaded: false }) } });
  await assertCode(openBrainLink(CONFIG, r.deps), 'brain-unavailable', /health/);
});

test('key failure names the key step and does not leak', async () => {
  const r = rig({ execFile: () => { throw new Error('Permission denied (publickey)'); } });
  await assertCode(openBrainLink(CONFIG, r.deps), 'brain-unavailable', /key/);
});

test('tunnel exit after the link was up marks it down and chat fails at once', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  r.sp.child.exit(255);
  assert.equal(link.status().up, false);
  const before = r.f.calls.length;
  await assertCode(link.chat(MSGS), 'brain-unavailable');
  assert.equal(r.f.calls.length, before);
});

test('non-OK status hides the body and the key', async () => {
  const r = rig({ fetch: { chat: () => okJson({ error: KEY }, 503) } });
  const link = await openBrainLink(CONFIG, r.deps);
  await assertCode(link.chat(MSGS), 'brain-unavailable', /503/);
  link.close();
});

test('bad response shape throws brain-unavailable', async () => {
  const r = rig({ fetch: { chat: () => okJson({ choices: [] }) } });
  const link = await openBrainLink(CONFIG, r.deps);
  await assertCode(link.chat(MSGS), 'brain-unavailable');
  link.close();
});

test('usage falls back to characters divided by four', async () => {
  const body = { model: 'qwen', choices: [{ message: { content: 'abcdefgh' } }] };
  const r = rig({ fetch: { chat: () => okJson(body) } });
  const link = await openBrainLink(CONFIG, r.deps);
  const res = await link.chat([{ role: 'user', content: 'x'.repeat(40) }]);
  assert.deepEqual(res.usage, { inTokens: 10, outTokens: 2 });
  link.close();
});

test('invalid messages are refused before sending; 60000 characters is accepted', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  const bad = [
    [],
    Array(21).fill(MSGS[0]),
    [{ role: 'tool', content: 'x' }],
    [{ role: 'user', content: 'x'.repeat(60001) }],
    [{ role: 'user', content: 5 }],
  ];
  for (const m of bad) await assert.rejects(link.chat(m), err => err.message === 'brain-request-invalid');
  assert.equal(r.f.calls.filter(c => c.url.endsWith('/v1/chat/completions')).length, 0);
  const res = await link.chat([{ role: 'user', content: 'x'.repeat(60000) }]);
  assert.equal(res.text, 'hello');
  link.close();
});

test('close is idempotent and sends SIGTERM to the tunnel once', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  link.close();
  link.close();
  assert.equal(r.sp.child.killed.filter(s => s === 'SIGTERM').length, 1);
  assert.equal(link.status().up, false);
});

test('the key stays out of status, tunnel args and errors; it goes only in the auth header', async () => {
  const r = rig();
  const link = await openBrainLink(CONFIG, r.deps);
  await link.chat(MSGS);
  assert.ok(!JSON.stringify(link.status()).includes(KEY));
  assert.ok(!r.sp.calls[0].args.join(' ').includes(KEY));
  const h = r.f.calls.find(c => c.url.endsWith('/v1/chat/completions')).opts.headers;
  const auth = h instanceof Headers ? h.get('authorization') : (h.Authorization ?? h.authorization);
  assert.equal(auth, 'Bearer ' + KEY);
  link.close();
});
