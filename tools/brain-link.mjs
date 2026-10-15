// SPDX-License-Identifier: Apache-2.0
import { spawn as realSpawn, execFile as realExecFile } from 'node:child_process';
import net from 'node:net';
import { sanitizeText } from './journal.mjs';

const ROLES = new Set(['system', 'user', 'assistant']);
const CHAT_TIMEOUT_MS = 180000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const unavailable = detail => fail('brain-unavailable', `brain-unavailable: ${detail}`);
const estimate = text => Math.ceil(String(text).length / 4);
const sleepReal = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePortReal() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function execFileReal(file, args, options) {
  return new Promise((resolve, reject) => {
    realExecFile(file, args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

function validMessages(messages) {
  return Array.isArray(messages) && messages.length >= 1 && messages.length <= 20
    && messages.every(m => m && ROLES.has(m.role) && typeof m.content === 'string' && m.content.length <= 60000);
}

export async function openBrainLink(config, deps = {}) {
  const spawn = deps.spawn ?? realSpawn;
  const execFile = deps.execFile ?? execFileReal;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const freePort = deps.freePort ?? freePortReal;
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? Date.now;
  const { sshTarget, sshKey, remotePort = 8000, keyCommand, readyTimeoutMs = 20000 } = config ?? {};
  if (!sshTarget || !sshKey || !keyCommand) throw unavailable('config');
  const sshBase = ['-i', sshKey, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10'];
  let key = null;
  let proc = null;
  let port = 0;
  let model = null;
  let up = false;
  let exited = false;
  let closed = false;
  const base = () => `http://127.0.0.1:${port}`;

  async function readKey() {
    // The link to dev2 can drop a connection attempt; three tries, a second apart, before giving up.
    let out, lastError = null;
    for (let attempt = 0; attempt < 3 && out === undefined; attempt += 1) {
      try { out = await execFile('ssh', [...sshBase, sshTarget, keyCommand], { timeout: 30000 }); }
      catch (error) { lastError = error; if (attempt < 2) await sleep(1000); }
    }
    if (out === undefined) throw unavailable('key');
    const stdout = typeof out === 'string' ? out : out?.stdout;
    key = String(stdout ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? null;
    if (!key) throw unavailable('key');
  }

  function startTunnel() {
    const args = ['-N', '-L', `127.0.0.1:${port}:127.0.0.1:${remotePort}`, ...sshBase,
      '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', sshTarget];
    proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const down = () => { exited = true; up = false; };
    proc.on('error', down);
    proc.on('exit', down);
  }

  async function healthOk() {
    try {
      const res = await fetchImpl(`${base()}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const body = await res.json();
      if (body?.loaded === false) return false;
      if (typeof body?.model === 'string') model = sanitizeText(body.model) || null;
      return true;
    } catch {
      return false;
    }
  }

  async function waitReady() {
    const deadline = now() + readyTimeoutMs;
    for (;;) {
      if (exited) throw unavailable('tunnel');
      if (await healthOk()) return;
      if (now() >= deadline) throw unavailable('health');
      await sleep(500);
    }
  }

  function closeNow() {
    if (closed) return;
    closed = true;
    up = false;
    const child = proc;
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }
  }

  async function chat(messages, { maxTokens = 600, signal, temperature = 0.2 } = {}) {
    if (!validMessages(messages)) throw fail('brain-request-invalid', 'brain-request-invalid');
    if (!up || closed) throw unavailable('tunnel');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(`${base()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: model ?? 'default', messages, max_tokens: maxTokens, temperature, stream: false }),
        signal: controller.signal,
      });
      if (!res.ok) throw unavailable(`HTTP ${res.status}`);
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw unavailable('bad response');
      const usage = json.usage ?? {};
      const inTokens = Number.isFinite(usage.prompt_tokens)
        ? usage.prompt_tokens
        : messages.reduce((sum, m) => sum + estimate(m.content), 0);
      const outTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : estimate(text);
      return { text, model: sanitizeText(String(json.model ?? model ?? '')) || null, usage: { inTokens, outTokens } };
    } catch (error) {
      if (error.code === 'brain-unavailable') throw error;
      throw unavailable(controller.signal.aborted ? 'timeout' : 'request failed');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  try {
    await readKey();
    port = await freePort();
    startTunnel();
    await waitReady();
    up = !exited && !closed;
  } catch (error) {
    closeNow();
    throw error;
  }

  return {
    chat,
    status: () => ({ up, model }),
    close: closeNow,
  };
}
