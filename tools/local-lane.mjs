// SPDX-License-Identifier: Apache-2.0
// OpenAI-compatible chat-completions workers on operator-owned hardware. Keys live in the macOS
// Keychain (or a named env var on Linux), never in config, manifests, logs, or worker prompts.
import { execFileSync } from 'node:child_process';
import { loadLocalConfig } from './local-config.mjs';

export const LOCAL_MODEL_PREFIX = 'local:';
export const LOCAL_DOCTOR_TIMEOUT_MS = 5000;
export const DEFAULT_AGENCY_CONCURRENCY = 1;
export const AGENCY_JOB_TYPES = Object.freeze(['diagnose', 'test', 'docs']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const NAME_RE = /^[a-z][a-z0-9][a-z0-9._-]{0,39}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const FORBIDDEN_ENDPOINT_KEYS = /^(apiKey|api_key|key|token|password|secret|bearer)$/i;
const ENDPOINT_KEYS = new Set(['name', 'baseUrl', 'model', 'slots', 'keychain', 'linuxEnv']);

class LocalLaneError extends Error {}
const fail = message => { throw new LocalLaneError(message); };

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function chatUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function modelsUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

function validateBaseUrl(raw, field) {
  if (typeof raw !== 'string' || !raw) fail(`lanes-invalid: local.${field} must be a URL string`);
  let url;
  try { url = new URL(raw); } catch { fail(`lanes-invalid: local.${field} must be a valid URL`); }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.username || url.password || url.search || url.hash) fail(`lanes-invalid: local.${field} must not contain credentials, query, or hash`);
  if (url.pathname !== '/' && url.pathname !== '/v1') fail(`lanes-invalid: local.${field} path must be / or /v1`);
  if (!loopback && url.protocol !== 'https:') fail(`lanes-invalid: local.${field} must be https (http only for loopback)`);
  if (!['http:', 'https:'].includes(url.protocol)) fail(`lanes-invalid: local.${field} must be http or https`);
  return url.origin + (url.pathname === '/v1' ? '/v1' : '');
}

function validateKeychain(raw, endpointName) {
  if (!object(raw)) fail(`lanes-invalid: local.endpoints.${endpointName}.keychain must be an object`);
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_ENDPOINT_KEYS.test(key) || key === 'apiKey') fail(`lanes-invalid: local.endpoints.${endpointName} must not contain a key in config`);
    if (!['service', 'account', 'linuxEnv'].includes(key)) fail(`lanes-invalid: local.endpoints.${endpointName}.keychain.${key} is unknown`);
  }
  const service = raw.service;
  const account = raw.account;
  if (typeof service !== 'string' || !service || service.length > 80) fail(`lanes-invalid: local.endpoints.${endpointName}.keychain.service is required`);
  if (typeof account !== 'string' || !account || account.length > 80) fail(`lanes-invalid: local.endpoints.${endpointName}.keychain.account is required`);
  const linuxEnv = raw.linuxEnv;
  if (linuxEnv !== undefined && (typeof linuxEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,64}$/.test(linuxEnv))) {
    fail(`lanes-invalid: local.endpoints.${endpointName}.keychain.linuxEnv must be an env var name`);
  }
  return { service, account, linuxEnv: linuxEnv ?? null };
}

export function validateLocalLaneBlock(raw) {
  if (raw === undefined) return { endpoints: [], agencyConcurrency: DEFAULT_AGENCY_CONCURRENCY };
  if (!object(raw)) fail('lanes-invalid: local must be an object');
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_ENDPOINT_KEYS.test(key)) fail(`lanes-invalid: local must not contain ${key} in config`);
    if (!['endpoints', 'agencyConcurrency'].includes(key)) fail(`lanes-invalid: local.${key} is unknown`);
  }
  let agencyConcurrency = raw.agencyConcurrency ?? DEFAULT_AGENCY_CONCURRENCY;
  if (!Number.isInteger(agencyConcurrency) || agencyConcurrency < 1 || agencyConcurrency > 64) {
    fail('lanes-invalid: local.agencyConcurrency must be an integer 1–64');
  }
  const endpoints = raw.endpoints === undefined ? [] : raw.endpoints;
  if (!Array.isArray(endpoints)) fail('lanes-invalid: local.endpoints must be an array');
  const out = [];
  const seen = new Set();
  for (const item of endpoints) {
    if (!object(item)) fail('lanes-invalid: local.endpoints[] must be objects');
    for (const key of Object.keys(item)) {
      if (FORBIDDEN_ENDPOINT_KEYS.test(key)) fail(`lanes-invalid: local.endpoints must not contain ${key} in config`);
      if (!ENDPOINT_KEYS.has(key)) fail(`lanes-invalid: local.endpoints.${key} is unknown`);
    }
    const name = item.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) fail('lanes-invalid: local.endpoints.name must be 2–40 lowercase alnum._-');
    if (seen.has(name)) fail(`lanes-invalid: local.endpoints duplicate name ${name}`);
    seen.add(name);
    const baseUrl = validateBaseUrl(item.baseUrl, `endpoints.${name}.baseUrl`);
    if (typeof item.model !== 'string' || !MODEL_RE.test(item.model)) fail(`lanes-invalid: local.endpoints.${name}.model is invalid`);
    const slots = item.slots ?? 1;
    if (!Number.isInteger(slots) || slots < 1 || slots > 64) fail(`lanes-invalid: local.endpoints.${name}.slots must be 1–64`);
    const keychain = validateKeychain(item.keychain ?? {}, name);
    const linuxEnv = item.linuxEnv ?? keychain.linuxEnv;
    if (linuxEnv !== undefined && linuxEnv !== null && (typeof linuxEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,64}$/.test(linuxEnv))) {
      fail(`lanes-invalid: local.endpoints.${name}.linuxEnv must be an env var name`);
    }
    out.push({
      name,
      baseUrl,
      model: item.model,
      slots,
      keychain: { service: keychain.service, account: keychain.account },
      linuxEnv: linuxEnv ?? null,
      chatUrl: chatUrl(baseUrl),
      modelsUrl: modelsUrl(baseUrl),
      routableModel: `${LOCAL_MODEL_PREFIX}${name}`,
    });
  }
  return { endpoints: out, agencyConcurrency };
}

export function loadLocalLaneConfig(env = process.env) {
  const config = loadLocalConfig({ env });
  return validateLocalLaneBlock(config?.lanes?.local);
}

export function localLaneConcurrency(endpoints) {
  return endpoints.reduce((sum, ep) => sum + ep.slots, 0) || 1;
}

export function parseLocalModel(model) {
  if (typeof model !== 'string' || !model.startsWith(LOCAL_MODEL_PREFIX)) return null;
  const name = model.slice(LOCAL_MODEL_PREFIX.length);
  return name.length ? name : null;
}

export function resolveLocalEndpoint({ endpoints, model, health = () => true }) {
  const byName = parseLocalModel(model);
  if (byName) {
    const ep = endpoints.find(item => item.name === byName);
    if (!ep) fail(`local-endpoint-missing: no endpoint named ${byName}`);
    if (!health(ep.name)) fail(`local-endpoint-unhealthy: ${byName}`);
    return ep;
  }
  const healthy = endpoints.filter(ep => health(ep.name));
  if (!healthy.length) fail('local-endpoint-unhealthy: no healthy endpoint');
  return healthy[0];
}

export function readLocalCredential(endpoint, env = process.env, { platform = process.platform, exec = execFileSync, readKey } = {}) {
  const fromInjected = readKey?.(endpoint, env);
  if (typeof fromInjected === 'string' && fromInjected.length) return fromInjected;
  if (endpoint.linuxEnv && typeof env[endpoint.linuxEnv] === 'string' && env[endpoint.linuxEnv].length) {
    return env[endpoint.linuxEnv];
  }
  if (platform !== 'darwin' || env.SWARM_LOCAL_NO_KEYCHAIN === '1') return null;
  try {
    const out = exec('/usr/bin/security', ['find-generic-password', '-s', endpoint.keychain.service, '-a', endpoint.keychain.account, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const value = String(out).trim();
    return value.length ? value : null;
  } catch { return null; }
}

export function isAgencyLocalJob(job, { agencyCall = false } = {}) {
  if (!object(job)) return false;
  if (agencyCall) return AGENCY_JOB_TYPES.includes(job.type);
  return AGENCY_JOB_TYPES.includes(job.type);
}

export function countLocalSlots(store, { endpoint = null, agencyOnly = false } = {}) {
  const slots = store.slots?.local ?? [];
  return slots.filter(slot => {
    if (agencyOnly && !slot.localAgency) return false;
    if (endpoint !== null && slot.localEndpoint !== endpoint) return false;
    return true;
  }).length;
}

export function localSlotRoom(store, { endpoint, slotsLimit, agency, agencyConcurrency }) {
  const endpointInFlight = countLocalSlots(store, { endpoint });
  const endpointRoom = Math.max(0, slotsLimit - endpointInFlight);
  if (!agency) return endpointRoom;
  const agencyInFlight = countLocalSlots(store, { agencyOnly: true });
  const agencyRoom = Math.max(0, agencyConcurrency - agencyInFlight);
  return Math.min(endpointRoom, agencyRoom);
}

export function attachLocalSlotMeta(slot, { endpoint, agency }) {
  if (endpoint) slot.localEndpoint = endpoint;
  if (agency) slot.localAgency = true;
  return slot;
}

export function mapLocalUsage(usage) {
  if (!object(usage)) return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens);
  const output = Number(usage.completion_tokens ?? usage.output_tokens);
  const mapped = {};
  if (Number.isFinite(input) && input >= 0) mapped.input_tokens = input;
  if (Number.isFinite(output) && output >= 0) mapped.output_tokens = output;
  return Object.keys(mapped).length ? mapped : null;
}

export async function probeLocalEndpoint(endpoint, { fetchImpl = fetch, timeoutMs = LOCAL_DOCTOR_TIMEOUT_MS, now = Date.now } = {}) {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(timeoutMs, 1), LOCAL_DOCTOR_TIMEOUT_MS));
  try {
    const response = await fetchImpl(endpoint.modelsUrl, { method: 'GET', redirect: 'error', signal: controller.signal });
    await response.body?.cancel();
    const latencyMs = now() - started;
    return {
      name: endpoint.name,
      model: endpoint.model,
      slots: endpoint.slots,
      status: response.ok ? 'ok' : 'unreachable',
      reachable: response.ok,
      latencyMs,
      httpStatus: response.status,
    };
  } catch {
    return {
      name: endpoint.name,
      model: endpoint.model,
      slots: endpoint.slots,
      status: 'unreachable',
      reachable: false,
      latencyMs: now() - started,
      httpStatus: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function doctorLocal(env = process.env, { fetchImpl = fetch, timeoutMs = LOCAL_DOCTOR_TIMEOUT_MS, now = Date.now, healthCache } = {}) {
  const { endpoints, agencyConcurrency } = loadLocalLaneConfig(env);
  if (!endpoints.length) {
    return {
      agent: 'local',
      status: 'unconfigured',
      configured: false,
      liveVerified: false,
      reachable: null,
      authentication: 'Configure lanes.local.endpoints in machine config; store credentials with security add-generic-password -s project-swarm -a local.<name> -w',
      endpoints: [],
      agencyConcurrency,
      note: 'No endpoints configured by default.',
    };
  }
  const probes = await Promise.all(endpoints.map(ep => probeLocalEndpoint(ep, { fetchImpl, timeoutMs, now })));
  const healthy = probes.filter(item => item.reachable);
  if (healthCache) for (const item of probes) healthCache.set(item.name, item.reachable);
  const anyReachable = healthy.length > 0;
  return {
    agent: 'local',
    status: anyReachable ? 'reachable' : 'unreachable',
    configured: true,
    liveVerified: anyReachable,
    reachable: anyReachable,
    authentication: 'Bearer token from Keychain (macOS) or linuxEnv; never stored in config',
    agencyConcurrency,
    endpoints: probes,
    endpoint: probes[0]?.name ?? null,
    note: anyReachable ? 'GET /v1/models succeeded within 5s for at least one endpoint.' : 'No endpoint answered GET /v1/models within 5s.',
  };
}

export function localRouterHealth(endpoints, cache = new Map()) {
  return name => {
    if (cache.has(name)) return { state: cache.get(name) ? 'ok' : 'paused' };
    const ep = endpoints.find(item => item.name === name);
    if (!ep) return { state: 'paused' };
    return { state: 'ok' };
  };
}

export function redactCredential(text, credential) {
  if (typeof text !== 'string' || typeof credential !== 'string' || !credential) return text;
  return text.split(credential).join('[redacted]');
}

export { LocalLaneError };
