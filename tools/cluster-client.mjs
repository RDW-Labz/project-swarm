// SPDX-License-Identifier: Apache-2.0
// Follower-side HTTP client for the canonical machine's cluster-ledger API (claim / renew / release / read).
import os from 'node:os';
import {
  CLUSTER_LEDGER_NODE_HEADER,
  clusterLedgerAuthHeaders,
  readNodeRegistry,
  resolveClusterLedgerPort,
} from './cluster-ledger-api.mjs';
import { loadLocalConfig } from './local-config.mjs';
import { getNodeId } from './node-identity.mjs';

export const CLUSTER_LEDGER_CLAIM_PATH = '/api/cluster/ledger/claim';
export const CLUSTER_LEDGER_RENEW_PATH = '/api/cluster/ledger/renew';
export const CLUSTER_LEDGER_RELEASE_PATH = '/api/cluster/ledger/release';
export const CLUSTER_LEDGER_READ_PATH = '/api/cluster/ledger/read';

const DEFAULT_CLUSTER_REQUEST_TIMEOUT_MS = 15_000;

/** Hostname, IPv4 literal, or bracketed IPv6 — no userinfo, port, or path fragments. */
const CLUSTER_CANONICAL_HOST_RE =
  /^(?:\[(?:[0-9a-fA-F:]+)\]|(?:\d{1,3}(?:\.\d{1,3}){3})|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*)$/;

const NODE_SECRET_HEX_RE = /^[0-9a-fA-F]{32,}$/;
const NODE_SECRET_BASE64URL_RE = /^[A-Za-z0-9_-]{32,}$/;

function isStrongNodeSecret(secret) {
  return NODE_SECRET_HEX_RE.test(secret) || NODE_SECRET_BASE64URL_RE.test(secret);
}

function hostnameMatchesConfigured(urlHostname, configuredHost) {
  if (configuredHost.startsWith('[') && configuredHost.endsWith(']')) {
    return urlHostname === configuredHost.slice(1, -1);
  }
  return urlHostname === configuredHost;
}

/**
 * @param {string} host
 * @returns {string} validated host string
 */
export function assertClusterCanonicalHost(host) {
  if (typeof host !== 'string' || !CLUSTER_CANONICAL_HOST_RE.test(host)) {
    throw Object.assign(new Error('cluster-client: clusterCanonicalHost is not a valid host'), {
      code: 'cluster-host-invalid',
    });
  }
  return host;
}

/**
 * @param {string} configuredHost
 * @param {number} port
 * @param {string} pathname
 */
function buildClusterLedgerUrl(configuredHost, port, pathname) {
  const host = assertClusterCanonicalHost(configuredHost);
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    throw Object.assign(new Error('cluster-client: invalid cluster ledger path'), { code: 'cluster-host-invalid' });
  }
  const url = new URL(pathname, `http://${host}:${port}`);
  if (!hostnameMatchesConfigured(url.hostname, host)) {
    throw Object.assign(new Error('cluster-client: cluster ledger URL host mismatch'), { code: 'cluster-host-invalid' });
  }
  if (url.pathname !== pathname) {
    throw Object.assign(new Error('cluster-client: cluster ledger URL path mismatch'), { code: 'cluster-host-invalid' });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('cluster-client: cluster ledger URL must not include credentials or fragments'), {
      code: 'cluster-host-invalid',
    });
  }
  return url;
}

/**
 * Hostname or tailnet DNS name of the canonical machine running the cluster-ledger listener (`clusterCanonicalHost` in SWARM_CONFIG).
 */
export function resolveClusterCanonicalHost({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const config = loadLocalConfig({ env, home });
  const host = config.clusterCanonicalHost;
  if (typeof host !== 'string') return undefined;
  const trimmed = host.trim();
  return trimmed || undefined;
}

/** True when this follower is configured to dial a remote canonical cluster ledger (`clusterCanonicalHost` set). */
export function followerRemoteClusterConfigured({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  return resolveClusterCanonicalHost({ env, home }) !== undefined;
}

async function resolveNodeSigningSecret({ env, home }) {
  const nodeId = await getNodeId({ env, home });
  let registry;
  try {
    registry = await readNodeRegistry({ env, home });
  } catch {
    throw Object.assign(new Error('cluster-client: node registry is invalid or unreadable'), {
      code: 'cluster-registry-invalid',
    });
  }
  const secret = registry?.nodes?.[nodeId]?.secret;
  if (typeof secret !== 'string' || !secret || !isStrongNodeSecret(secret)) {
    throw Object.assign(new Error('cluster-client: local node is missing from nodes registry or has no secret'), {
      code: 'cluster-node-unregistered',
    });
  }
  return { nodeId, secret };
}

function requestFailedError(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return Object.assign(new Error(`cluster-client: request failed: ${message}`), {
    code: 'cluster-request-failed',
    cause,
  });
}

function isAbortError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'AbortError') return true;
  if (error.code === 'ABORT_ERR') return true;
  return false;
}

/**
 * Signed HTTP call to the remote cluster-ledger API. Never touches local lease files.
 * @param {string} pathname - e.g. CLUSTER_LEDGER_CLAIM_PATH
 * @param {{ method?: string, body?: object, env?, home?, fetch?, now?: number, timeoutMs?: number }} options
 */
export async function clusterLedgerRemoteFetch(
  pathname,
  {
    method = 'GET',
    body,
    env = process.env,
    home = env.HOME || os.homedir(),
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now(),
    timeoutMs = DEFAULT_CLUSTER_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const host = resolveClusterCanonicalHost({ env, home });
  if (!host) {
    throw Object.assign(new Error('cluster-client: clusterCanonicalHost is not configured'), { code: 'cluster-host-missing' });
  }
  const port = resolveClusterLedgerPort({ env, home });
  const { nodeId, secret } = await resolveNodeSigningSecret({ env, home });

  const url = buildClusterLedgerUrl(host, port, pathname);

  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const bodyStr = hasBody ? JSON.stringify(body) : '';
  const auth = clusterLedgerAuthHeaders(secret, method, pathname, bodyStr, { now });

  const signal = AbortSignal.timeout(timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal,
      headers: {
        [CLUSTER_LEDGER_NODE_HEADER]: nodeId,
        ...auth,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? bodyStr : undefined,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw Object.assign(new Error('cluster-client: cluster ledger request timed out'), {
        code: 'cluster-request-timeout',
      });
    }
    throw requestFailedError(error);
  }

  let text;
  try {
    text = await res.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw Object.assign(new Error('cluster-client: cluster ledger request timed out'), {
        code: 'cluster-request-timeout',
      });
    }
    throw requestFailedError(error);
  }

  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw Object.assign(new Error('cluster-client: response was not valid JSON'), {
      code: 'cluster-response-invalid',
      status: res.status,
    });
  }

  if (!res.ok) {
    throw Object.assign(new Error(json?.message ?? `cluster-client: HTTP ${res.status}`), {
      code: json?.error ?? 'cluster-http-error',
      status: res.status,
      body: json,
    });
  }

  if (json === null || typeof json !== 'object') {
    throw Object.assign(new Error('cluster-client: unexpected response shape'), { code: 'cluster-response-invalid', status: res.status });
  }

  return json;
}

export async function remoteClusterClaim(ticketId, { leaseTtlMs, env, home, fetch, now, timeoutMs } = {}) {
  const body = { ticketId };
  if (leaseTtlMs !== undefined) body.leaseTtlMs = leaseTtlMs;
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_CLAIM_PATH, {
    method: 'POST',
    body,
    env,
    home,
    fetch,
    now,
    timeoutMs,
  });
}

export async function remoteClusterRenew(ticketId, fencingToken, { leaseTtlMs, env, home, fetch, now, timeoutMs } = {}) {
  const body = { ticketId, fencingToken };
  if (leaseTtlMs !== undefined) body.leaseTtlMs = leaseTtlMs;
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_RENEW_PATH, {
    method: 'POST',
    body,
    env,
    home,
    fetch,
    now,
    timeoutMs,
  });
}

export async function remoteClusterRelease(ticketId, fencingToken, { env, home, fetch, now, timeoutMs } = {}) {
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_RELEASE_PATH, {
    method: 'POST',
    body: { ticketId, fencingToken },
    env,
    home,
    fetch,
    now,
    timeoutMs,
  });
}

export async function remoteClusterRead({ env, home, fetch, now, timeoutMs } = {}) {
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_READ_PATH, {
    method: 'GET',
    env,
    home,
    fetch,
    now,
    timeoutMs,
  });
}
