// SPDX-License-Identifier: Apache-2.0
// Tailnet-authenticated HTTP API for cluster ledger leases (claim / renew / release / read).
// Separate process and port from the Swarm Watch board (tools/watch-server.mjs).
//
// Listener: starts only when the canonical machine config sets `remoteClusterMode: true`
// (tools/local-config.mjs / SWARM_CONFIG), off by default. Port: env SWARM_CLUSTER_LEDGER_PORT
// or config `clusterLedgerPort`, default 9448. Binds 127.0.0.1; expose with tailscale serve separately.
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { claim, renew, release, readLeases } from './ledger-lease.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { parseNodeId } from './node-identity.mjs';
import { isTailnetAddress } from './remote.mjs';

export const DEFAULT_CLUSTER_LEDGER_PORT = 9448;
export const CLUSTER_LEDGER_NODE_HEADER = 'x-swarm-node-id';
export const CLUSTER_LEDGER_TIMESTAMP_HEADER = 'x-swarm-timestamp';
export const CLUSTER_LEDGER_SIGNATURE_HEADER = 'x-swarm-signature';

const MAX_BODY_BYTES = 16 * 1024;
/** Reject request signatures whose timestamp is more than this many ms from server time (replay limit). */
const MAX_AUTH_TIMESTAMP_SKEW_MS = 60_000;

const GENERIC_UNAUTHORIZED = { status: 401, body: { error: 'unauthorized', message: 'request could not be authorized' } };

/**
 * Canonical string for node HMAC auth: method, path, millisecond timestamp, and raw body bytes.
 * Delimiters are newlines so method/path/body cannot collide across fields.
 * Client: HMAC-SHA256(nodeSecret, canonical) as lowercase hex in x-swarm-signature with x-swarm-timestamp.
 */
export function clusterLedgerCanonicalString(method, path, timestampMs, body = '') {
  const bodyStr = body ?? '';
  return `${method}\n${path}\n${String(timestampMs)}\n${bodyStr}`;
}

export function clusterLedgerHmac(secret, method, path, timestampMs, body = '') {
  return createHmac('sha256', secret).update(clusterLedgerCanonicalString(method, path, timestampMs, body)).digest('hex');
}

export function clusterLedgerAuthHeaders(secret, method, path, body, { now = Date.now() } = {}) {
  const bodyStr = typeof body === 'string' ? body : (body == null ? '' : JSON.stringify(body));
  const timestamp = String(now);
  return {
    [CLUSTER_LEDGER_TIMESTAMP_HEADER]: timestamp,
    [CLUSTER_LEDGER_SIGNATURE_HEADER]: clusterLedgerHmac(secret, method, path, timestamp, bodyStr),
  };
}

function verifyNodeHmac(secret, method, path, timestampHeader, signatureHeader, body) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof timestampHeader !== 'string' || !timestampHeader.trim()) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader.trim()) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return false;
  if (Math.abs(Date.now() - ts) > MAX_AUTH_TIMESTAMP_SKEW_MS) return false;
  const expected = clusterLedgerHmac(secret, method, path, timestampHeader, body ?? '');
  if (expected.length !== signatureHeader.length) return false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signatureHeader, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function nodesRegistryFile(env = process.env, home = env.HOME || os.homedir()) {
  const install = env.SWARM_HOME || path.join(home, '.project-swarm');
  return env.SWARM_NODES_REGISTRY_FILE || path.join(install, 'nodes', 'registry.json');
}

export function resolveClusterLedgerPort({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const fromEnv = env.SWARM_CLUSTER_LEDGER_PORT;
  if (fromEnv !== undefined && fromEnv !== '') {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  const config = loadLocalConfig({ env, home });
  const fromConfig = config.clusterLedgerPort;
  if (fromConfig !== undefined) {
    const n = Number(fromConfig);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return DEFAULT_CLUSTER_LEDGER_PORT;
}

/** True only when remote cluster mode is explicitly enabled on this machine (off by default). */
export function remoteClusterModeEnabled({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const config = loadLocalConfig({ env, home });
  return config.remoteClusterMode === true;
}

export async function readNodeRegistry({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const file = nodesRegistryFile(env, home);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || typeof parsed.nodes !== 'object') {
      return { version: 1, nodes: {} };
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, nodes: {} };
    throw error;
  }
}

export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== want) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Tailnet verification for orchestrator-to-orchestrator calls (not owner/board-token auth).
 * Requires Tailscale Serve headers and rejects Funnel; optional host allowlist like remote board.
 */
export function tailnetNodeRequestVerified(req, remoteAddress, { hosts = [] } = {}) {
  if (headerValue(req?.headers, 'Tailscale-Funnel-Request') !== undefined) return false;
  const login = headerValue(req?.headers, 'Tailscale-User-Login');
  if (typeof login !== 'string' || !login.trim()) return false;

  const host = headerValue(req?.headers, 'Host');
  const localHost = typeof host === 'string' && (/^127\.0\.0\.1:\d+$/i.test(host) || /^localhost:\d+$/i.test(host));
  if (hosts.length && host && !localHost) {
    if (!hosts.map(h => String(h).toLowerCase()).includes(String(host).toLowerCase())) return false;
  }

  const ip = remoteAddress == null || remoteAddress === ''
    ? ''
    : String(remoteAddress).replace(/^::ffff:/, '');
  if (!ip) return false;
  const loopbackPeer = ip === '127.0.0.1' || ip === '::1';
  if (!localHost && !isTailnetAddress(ip) && !loopbackPeer) return false;
  return true;
}

export function authorizeClusterNode(req, remoteAddress, registry, { hosts = [], method = 'GET', path = '/', body = '' } = {}) {
  if (!tailnetNodeRequestVerified(req, remoteAddress, { hosts })) {
    return { ok: false, status: 401, body: { error: 'not-verified', message: 'tailnet node identity was not verified' } };
  }
  const nodeId = parseNodeId(headerValue(req?.headers, CLUSTER_LEDGER_NODE_HEADER) ?? '');
  if (!nodeId) {
    return { ok: false, status: 401, body: { error: 'missing-node-id', message: 'x-swarm-node-id must be a valid node uuid' } };
  }
  const nodeEntry = registry?.nodes?.[nodeId];
  const secret = nodeEntry?.secret;
  const timestampHeader = headerValue(req?.headers, CLUSTER_LEDGER_TIMESTAMP_HEADER);
  const signatureHeader = headerValue(req?.headers, CLUSTER_LEDGER_SIGNATURE_HEADER);
  if (
    !nodeEntry
    || typeof secret !== 'string'
    || !secret
    || !verifyNodeHmac(secret, method, path, timestampHeader, signatureHeader, body)
  ) {
    return { ok: false, ...GENERIC_UNAUTHORIZED };
  }
  return { ok: true, nodeId };
}

export async function readClusterLedger(root) {
  const store = await readLeases(root);
  return { version: store.version, leases: store.leases, maxTokenByTicket: store.maxTokenByTicket };
}

function leaseErrorStatus(code) {
  if (code === 'lease-held' || code === 'lease-stale-token' || code === 'lease-expired' || code === 'lease-missing') return 409;
  if (code === 'invalid-holder-id' || code === 'invalid-lease-ttl' || code === 'invalid-now') return 400;
  if (code === 'ticket-missing' || code === 'ledger-missing') return 404;
  return 500;
}

export async function handleClusterLedgerOperation(root, route, body, { now = Date.now() } = {}) {
  if (route === 'read') {
    return { status: 200, body: await readClusterLedger(root) };
  }
  if (route === 'claim') {
    const ticketId = body?.ticketId;
    const holderId = body?._callerNodeId;
    if (typeof ticketId !== 'string' || !ticketId) {
      return { status: 400, body: { error: 'bad-request', message: 'ticketId is required' } };
    }
    if (typeof holderId !== 'string' || !holderId) {
      return { status: 401, body: { error: 'missing-node-id', message: 'caller node id is required' } };
    }
    const opts = { now };
    if (body?.leaseTtlMs !== undefined) opts.leaseTtlMs = body.leaseTtlMs;
    try {
      const result = await claim(root, ticketId, holderId, opts);
      return { status: 200, body: result };
    } catch (error) {
      return { status: leaseErrorStatus(error.code), body: { error: error.code ?? 'error', message: error.message } };
    }
  }
  if (route === 'renew') {
    const ticketId = body?.ticketId;
    const fencingToken = body?.fencingToken;
    const callerNodeId = body?._callerNodeId;
    if (typeof ticketId !== 'string' || !ticketId) {
      return { status: 400, body: { error: 'bad-request', message: 'ticketId is required' } };
    }
    if (!Number.isInteger(fencingToken)) {
      return { status: 400, body: { error: 'bad-request', message: 'fencingToken must be an integer' } };
    }
    const holderDenied = await assertLeaseHolder(root, ticketId, callerNodeId);
    if (holderDenied) return holderDenied;
    const opts = { now };
    if (body?.leaseTtlMs !== undefined) opts.leaseTtlMs = body.leaseTtlMs;
    try {
      const result = await renew(root, ticketId, fencingToken, opts);
      return { status: 200, body: result };
    } catch (error) {
      return { status: leaseErrorStatus(error.code), body: { error: error.code ?? 'error', message: error.message } };
    }
  }
  if (route === 'release') {
    const ticketId = body?.ticketId;
    const fencingToken = body?.fencingToken;
    const callerNodeId = body?._callerNodeId;
    if (typeof ticketId !== 'string' || !ticketId) {
      return { status: 400, body: { error: 'bad-request', message: 'ticketId is required' } };
    }
    if (!Number.isInteger(fencingToken)) {
      return { status: 400, body: { error: 'bad-request', message: 'fencingToken must be an integer' } };
    }
    const holderDenied = await assertLeaseHolder(root, ticketId, callerNodeId);
    if (holderDenied) return holderDenied;
    try {
      const result = await release(root, ticketId, fencingToken, { now });
      return { status: 200, body: result };
    } catch (error) {
      return { status: leaseErrorStatus(error.code), body: { error: error.code ?? 'error', message: error.message } };
    }
  }
  return { status: 404, body: { error: 'not-found' } };
}

async function assertLeaseHolder(root, ticketId, callerNodeId) {
  const store = await readLeases(root);
  const lease = store.leases[ticketId];
  if (!lease || lease.holderId !== callerNodeId) {
    return { status: 403, body: { error: 'forbidden', message: 'only the lease holder may renew or release this lease' } };
  }
  return null;
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return { error: 'too-large' };
    chunks.push(chunk);
  }
  if (!chunks.length) return { value: {}, raw: '' };
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    return { error: 'invalid-json' };
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function createClusterLedgerServer({
  root,
  registry,
  hosts = [],
  readRegistry = async () => registry,
} = {}) {
  if (!root) throw new Error('cluster-ledger-api: root is required');
  const server = http.createServer(async (req, res) => {
    try {
      const remoteAddress = req.socket?.remoteAddress;
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = u.pathname.replace(/\/+$/, '') || '/';
      const routeMap = {
        '/api/cluster/ledger/claim': 'claim',
        '/api/cluster/ledger/renew': 'renew',
        '/api/cluster/ledger/release': 'release',
        '/api/cluster/ledger/read': 'read',
      };
      const route = routeMap[pathname];
      if (!route) {
        sendJson(res, 404, { error: 'not-found' });
        return;
      }

      let bodyRaw = '';
      let parsedBody = {};
      if (route === 'read') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method-not-allowed' });
          return;
        }
      } else {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method-not-allowed' });
          return;
        }
        const bodyRead = await readJsonBody(req);
        if (bodyRead.error === 'too-large') {
          sendJson(res, 413, { error: 'payload-too-large' });
          return;
        }
        if (bodyRead.error === 'invalid-json') {
          sendJson(res, 400, { error: 'invalid-json' });
          return;
        }
        bodyRaw = bodyRead.raw ?? '';
        parsedBody = bodyRead.value ?? {};
      }

      const reg = registry ?? await readRegistry();
      const auth = authorizeClusterNode(req, remoteAddress, reg, { hosts, method: req.method ?? 'GET', path: pathname, body: bodyRaw });
      if (!auth.ok) {
        sendJson(res, auth.status, auth.body);
        return;
      }

      if (route === 'read') {
        const out = await handleClusterLedgerOperation(root, 'read');
        if (req.method === 'HEAD') {
          res.writeHead(out.status);
          res.end();
          return;
        }
        sendJson(res, out.status, out.body);
        return;
      }

      const body = { ...parsedBody, _callerNodeId: auth.nodeId };
      const out = await handleClusterLedgerOperation(root, route, body);
      sendJson(res, out.status, out.body);
    } catch (error) {
      console.error('cluster-ledger-api: request failed', error);
      sendJson(res, 503, { error: 'unavailable', message: 'cluster ledger temporarily unavailable' });
    }
  });
  return server;
}

let activeListener = null;

/**
 * Start the cluster ledger HTTP listener when remoteClusterMode is on; otherwise no-op (no listener).
 * Returns { server, port } or null when mode is off.
 */
export async function startClusterLedgerListener({
  root,
  env = process.env,
  home = env.HOME || os.homedir(),
  host = '127.0.0.1',
  registry,
  hosts,
  readRegistry,
} = {}) {
  if (!remoteClusterModeEnabled({ env, home })) return null;
  if (activeListener?.server) await stopClusterLedgerListener();
  const port = resolveClusterLedgerPort({ env, home });
  const config = loadLocalConfig({ env, home });
  const hostAllow = hosts ?? (Array.isArray(config.clusterLedgerHosts) ? config.clusterLedgerHosts : []);
  const server = createClusterLedgerServer({
    root,
    registry,
    hosts: hostAllow,
    readRegistry: readRegistry ?? (async () => readNodeRegistry({ env, home })),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  activeListener = { server, port, host };
  return activeListener;
}

export async function stopClusterLedgerListener() {
  if (!activeListener?.server) return;
  const { server } = activeListener;
  activeListener = null;
  await new Promise(resolve => server.close(() => resolve()));
}

export function clusterLedgerListenerState() {
  return activeListener ? { ...activeListener } : null;
}
