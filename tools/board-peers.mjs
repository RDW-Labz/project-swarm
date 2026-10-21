// SPDX-License-Identifier: Apache-2.0
// Tailnet-only peer boards: save peer links, fetch their read-only board data, and merge it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PEERS_VERSION = 1;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;

export const peersFile = (env = process.env, home = os.homedir()) => env.SWARM_PEERS_FILE || path.join(home, '.project-swarm', 'peers.json');

export function validPeerUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.hostname.endsWith('.ts.net');
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function validPeerName(value) { return typeof value === 'string' && NAME_RE.test(value); }
export function validPeerToken(value) { return typeof value === 'string' && TOKEN_RE.test(value); }

async function readPeers(env = process.env, home = os.homedir()) {
  try {
    const data = JSON.parse(await fs.readFile(peersFile(env, home), 'utf8'));
    if (!data || typeof data !== 'object' || data.version !== PEERS_VERSION || !Array.isArray(data.peers)) return [];
    return data.peers.filter(peer => peer && typeof peer === 'object'
      && validPeerName(peer.name) && validPeerUrl(peer.url) && validPeerToken(peer.token))
      .map(peer => ({ name: peer.name, url: peer.url, token: peer.token }));
  } catch {
    return [];
  }
}

export async function listPeers(env = process.env, home = os.homedir()) {
  return readPeers(env, home);
}

export function publicPeers(list) {
  return (Array.isArray(list) ? list : []).map(({ name, url }) => ({ name, url }));
}

async function writePeers(list, env = process.env, home = os.homedir()) {
  const file = peersFile(env, home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify({ version: PEERS_VERSION, peers: list })}\n`, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function addPeer(name, url, token, env = process.env, home = os.homedir()) {
  if (!validPeerName(name)) throw new Error('invalid-name');
  if (!validPeerUrl(url)) throw new Error('peer-url-not-tailnet');
  if (!validPeerToken(token)) throw new Error('invalid-token');
  const peers = await listPeers(env, home);
  const peer = { name, url, token };
  const index = peers.findIndex(existing => existing.name === name);
  if (index === -1) peers.push(peer);
  else peers[index] = peer;
  await writePeers(peers, env, home);
  return peer;
}

export async function removePeer(name, env = process.env, home = os.homedir()) {
  if (!validPeerName(name)) throw new Error('invalid-name');
  const peers = await listPeers(env, home);
  const remaining = peers.filter(peer => peer.name !== name);
  if (remaining.length === peers.length) throw new Error('peer-not-found');
  await writePeers(remaining, env, home);
  return { name, removed: true };
}

function shortError(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase();
  if (text.includes('redirect')) return 'redirect';
  return 'request-failed';
}

async function responseText(response) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error('body-too-large');
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  }
  if (typeof response?.text !== 'function') throw new Error('invalid-response');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('body-too-large');
  return text;
}

export async function fetchPeer(peer, { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const name = peer?.name;
  if (!peer || !validPeerName(name) || !validPeerUrl(peer.url) || !validPeerToken(peer.token)) {
    return { name: name ?? '', ok: false, error: 'invalid-peer' };
  }
  const controller = new AbortController();
  let timeout;
  let timedOut = false;
  const request = new URL('/api/board', peer.url);
  try {
    const fetchPromise = Promise.resolve().then(() => fetchImpl(request, {
      method: 'GET',
      headers: { 'x-watch-token': peer.token },
      signal: controller.signal,
      redirect: 'error',
    }));
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    const status = Number(response?.status);
    if (status >= 300 && status < 400) return { name, ok: false, error: 'redirect' };
    if (response?.ok === false || status >= 400) return { name, ok: false, error: `http-${Number.isFinite(status) ? status : 'error'}` };
    const text = await Promise.race([responseText(response), timeoutPromise]);
    let data;
    try { data = JSON.parse(text); } catch { return { name, ok: false, error: 'invalid-json' }; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.projects)) {
      return { name, ok: false, error: 'invalid-board' };
    }
    return {
      name,
      ok: true,
      at: data.at,
      machine: data.machine?.host ?? name,
      version: data.server?.version ?? null,
      projects: data.projects,
      orchestrators: data.machine?.orchestrator?.sessions ?? [],
    };
  } catch (error) {
    if (timedOut || error?.message === 'timeout') return { name, ok: false, error: 'timeout' };
    if (error?.message === 'body-too-large') return { name, ok: false, error: 'body-too-large' };
    return { name, ok: false, error: shortError(error) };
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

export function createPeerCache({ ttlMs = 10000, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const entries = new Map();
  const keyOf = peer => `${peer?.name}\u0000${peer?.url}\u0000${peer?.token}`;
  return {
    async all(peers) {
      const input = Array.isArray(peers) ? peers : [];
      return Promise.all(input.map(peer => {
        const key = keyOf(peer);
        const existing = entries.get(key);
        const current = now();
        if (existing?.result && current - existing.at < ttlMs) return existing.result;
        if (existing?.promise) return existing.promise;
        const at = current;
        const promise = fetchPeer(peer, { fetchImpl }).then(result => {
          entries.set(key, { at, result });
          return result;
        });
        entries.set(key, { at, promise });
        return promise;
      }));
    },
  };
}

function compareVersions(left, right) {
  const parse = value => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0), match[4] ?? ''] : null;
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) return left.localeCompare(right);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3]);
}

function tagCards(cards, machine, version, remote, newest) {
  return (Array.isArray(cards) ? cards : []).map(card => {
    const tagged = { ...(card && typeof card === 'object' ? card : { value: card }), machine, version };
    if (remote) tagged.remote = true;
    if (newest !== null && version !== newest) tagged.versionDrift = true;
    return tagged;
  });
}

export function mergeMachines(local, remotes) {
  const localMachine = {
    name: local?.name,
    version: local?.version ?? null,
    ok: true,
    projectCount: Array.isArray(local?.projects) ? local.projects.length : 0,
  };
  const remoteList = Array.isArray(remotes) ? remotes : [];
  const remoteMachines = remoteList.map(remote => ({
    name: remote?.machine ?? remote?.name,
    version: remote?.version ?? null,
    ok: remote?.ok === true,
    ...(remote?.ok === true ? {} : { error: remote?.error ?? 'unreachable' }),
    projectCount: remote?.ok === true && Array.isArray(remote?.projects) ? remote.projects.length : 0,
  }));
  const machines = [localMachine, ...remoteMachines];
  const versions = [...new Set(machines.filter(machine => machine.ok && typeof machine.version === 'string' && machine.version).map(machine => machine.version))].sort(compareVersions);
  const newest = versions.at(-1) ?? null;
  const localProjects = tagCards(local?.projects, local?.name, local?.version ?? null, false, newest);
  const localOrchestrators = tagCards(local?.orchestrators, local?.name, local?.version ?? null, false, newest);
  const projects = [...localProjects];
  const orchestrators = [...localOrchestrators];
  for (const remote of remoteList) {
    if (remote?.ok !== true) continue;
    projects.push(...tagCards(remote.projects, remote.machine ?? remote.name, remote.version ?? null, true, newest));
    orchestrators.push(...tagCards(remote.orchestrators, remote.machine ?? remote.name, remote.version ?? null, true, newest));
  }
  return { machines, projects, orchestrators, drift: { versions, drifted: versions.length > 1, newest } };
}

async function readStdin() {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.trim();
  } catch {
    return '';
  }
}

export async function cli(args, env = process.env, home = os.homedir()) {
  try {
    const [command, name, url] = args;
    if (command === 'add') {
      const token = await readStdin();
      const peer = await addPeer(name, url, token, env, home);
      return { exitCode: 0, output: { ok: true, peer: publicPeers([peer])[0] } };
    }
    if (command === 'remove') {
      const removed = await removePeer(name, env, home);
      return { exitCode: 0, output: { ok: true, ...removed } };
    }
    if (command === 'list') return { exitCode: 0, output: { ok: true, peers: publicPeers(await listPeers(env, home)) } };
    return { exitCode: 1, output: { ok: false, error: 'usage' } };
  } catch (error) {
    return { exitCode: 1, output: { ok: false, error: String(error?.message ?? 'error').split(/[\r\n]/, 1)[0] } };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await cli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}
