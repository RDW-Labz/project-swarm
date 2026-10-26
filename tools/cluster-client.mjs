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
  const registry = await readNodeRegistry({ env, home });
  const secret = registry?.nodes?.[nodeId]?.secret;
  if (typeof secret !== 'string' || !secret) {
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

/**
 * Signed HTTP call to the remote cluster-ledger API. Never touches local lease files.
 * @param {string} pathname - e.g. CLUSTER_LEDGER_CLAIM_PATH
 * @param {{ method?: string, body?: object, env?, home?, fetch?, now?: number }} options
 */
export async function clusterLedgerRemoteFetch(
  pathname,
  { method = 'GET', body, env = process.env, home = env.HOME || os.homedir(), fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {},
) {
  const host = resolveClusterCanonicalHost({ env, home });
  if (!host) {
    throw Object.assign(new Error('cluster-client: clusterCanonicalHost is not configured'), { code: 'cluster-host-missing' });
  }
  const port = resolveClusterLedgerPort({ env, home });
  const { nodeId, secret } = await resolveNodeSigningSecret({ env, home });

  const hasBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const bodyStr = hasBody ? JSON.stringify(body) : '';
  const auth = clusterLedgerAuthHeaders(secret, method, pathname, bodyStr, { now });
  const url = `http://${host}:${port}${pathname}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        [CLUSTER_LEDGER_NODE_HEADER]: nodeId,
        ...auth,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? bodyStr : undefined,
    });
  } catch (error) {
    throw requestFailedError(error);
  }

  const text = await res.text();
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

export async function remoteClusterClaim(ticketId, { leaseTtlMs, env, home, fetch, now } = {}) {
  const body = { ticketId };
  if (leaseTtlMs !== undefined) body.leaseTtlMs = leaseTtlMs;
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_CLAIM_PATH, {
    method: 'POST',
    body,
    env,
    home,
    fetch,
    now,
  });
}

export async function remoteClusterRenew(ticketId, fencingToken, { leaseTtlMs, env, home, fetch, now } = {}) {
  const body = { ticketId, fencingToken };
  if (leaseTtlMs !== undefined) body.leaseTtlMs = leaseTtlMs;
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_RENEW_PATH, {
    method: 'POST',
    body,
    env,
    home,
    fetch,
    now,
  });
}

export async function remoteClusterRelease(ticketId, fencingToken, { env, home, fetch, now } = {}) {
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_RELEASE_PATH, {
    method: 'POST',
    body: { ticketId, fencingToken },
    env,
    home,
    fetch,
    now,
  });
}

export async function remoteClusterRead({ env, home, fetch, now } = {}) {
  return clusterLedgerRemoteFetch(CLUSTER_LEDGER_READ_PATH, {
    method: 'GET',
    env,
    home,
    fetch,
    now,
  });
}
