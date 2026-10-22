// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanSecretsDetailed } from './security-scan.mjs';
import { HTTPS_PORT, readRemote, realDeps } from './remote.mjs';

const HASH = /^[a-f0-9]{64}$/;
const MAX_EXPORT_BYTES = 512 * 1024;
const HOME_PATH = /(?:^|[^A-Za-z0-9])\/(?:Users|home)\/[^/\s]+\//;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
const PHONE = /(?:^|[^\d])(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}(?:$|[^\d])/;

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asString = value => typeof value === 'string' ? value : '';

function pushError(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

function piiKinds(text) {
  const kinds = [];
  if (EMAIL.test(text)) kinds.push('email');
  if (PHONE.test(text)) kinds.push('phone');
  if (IPV4.test(text)) kinds.push('ipv4');
  if (HOME_PATH.test(text)) kinds.push('home-path');
  return kinds;
}

async function assertSafePayload(text, scan) {
  const found = new Set();
  const scanResult = await scan([{ path: 'field-push.json', content: text }]);
  const secretFindings = Array.isArray(scanResult) ? scanResult : scanResult?.findings;
  if (Array.isArray(scanResult?.skipped) && scanResult.skipped.length > 0) throw pushError('field-push-unsafe', 'field-push-unsafe: scan-skipped');
  for (const kind of piiKinds(text)) found.add(kind);
  if (Array.isArray(secretFindings) && secretFindings.length > 0) found.add('secret');
  if (found.size > 0) {
    const error = pushError('field-push-unsafe', `field-push-unsafe: ${[...found].sort().join(', ')}`);
    error.findings = [...found].sort();
    throw error;
  }
}

function payloadWithoutScanMarker(bundle) {
  const copy = { ...asObject(bundle) };
  delete copy.scannedClean;
  delete copy.scanMarkedAt;
  return copy;
}

function assertBundleShape(payload) {
  const data = asObject(payload);
  if (!HASH.test(asString(data.projectId))) throw pushError('field-push-bad-bundle', 'field-push-bad-bundle: projectId');
  const stamp = asString(data.exportedAt || data.generatedAt);
  if (!Number.isFinite(Date.parse(stamp))) throw pushError('field-push-bad-bundle', 'field-push-bad-bundle: exportedAt');
  if (!Array.isArray(data.lessons) || !Array.isArray(data.runs)) throw pushError('field-push-bad-bundle', 'field-push-bad-bundle: lessons-runs');
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EXPORT_BYTES) throw pushError('field-push-bad-bundle', 'field-push-bad-bundle: too-large');
  return { ...data, exportedAt: stamp };
}

export function bundleForPush(exportData) {
  const payload = assertBundleShape(exportData);
  return { ...payload, scannedClean: true };
}

export async function assertScannedCleanBundle(bundle, { scan = scanSecretsDetailed } = {}) {
  if (typeof scan !== 'function') throw new TypeError('field push scan must be a function');
  if (asObject(bundle).scannedClean !== true) throw pushError('field-push-not-scanned-clean', 'field-push-not-scanned-clean');
  const payload = assertBundleShape(payloadWithoutScanMarker(bundle));
  await assertSafePayload(JSON.stringify(payload), scan);
  return { ...payload, scannedClean: true, scanMarkedAt: asString(bundle.scanMarkedAt) || null };
}

export async function readFieldBundleFile(file, options) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw pushError('field-push-missing', 'field-push-missing');
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw pushError('field-push-bad-bundle', 'field-push-bad-bundle: json');
  }
  return assertScannedCleanBundle(parsed, options);
}

export async function receiveFieldBundle(root, bundle, options) {
  const clean = await assertScannedCleanBundle(bundle, options);
  const dir = path.resolve(root, '.swarm', 'field', 'inbox');
  const date = new Date(clean.exportedAt);
  const file = path.join(dir, `${date.toISOString().slice(0, 10)}-${clean.projectId}.json`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

export function localFieldBundleTransport(destRoot) {
  return bundle => receiveFieldBundle(destRoot, bundle);
}

export async function postJson(url, { headers = {}, body, timeoutMs = 8000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = res.status === 204 ? '' : await res.text();
  return { status: res.status, body: text };
}

export async function remoteFieldBundleTransport({ env = process.env, deps = realDeps(env) } = {}) {
  const remote = await readRemote(env);
  if (!remote?.dns || !remote?.token) throw pushError('field-push-remote-off', 'field-push-remote-off');
  const port = remote.httpsPort ?? HTTPS_PORT;
  const url = `https://${remote.dns}:${port}/api/field/bundle`;
  return async bundle => {
    const res = await postJson(url, {
      headers: {
        'content-type': 'application/json',
        'x-watch-token': remote.token,
      },
      body: `${JSON.stringify(bundle)}\n`,
    });
    if (res.status !== 200 && res.status !== 204) {
      const error = pushError('field-push-send-failed', 'field-push-send-failed');
      error.status = res.status;
      throw error;
    }
  };
}

export async function pushFieldBundle(root, { bundlePath, bundle, scan, send, env, deps } = {}) {
  const resolved = bundle ?? await readFieldBundleFile(bundlePath, { scan });
  const deliver = send ?? await remoteFieldBundleTransport({ env, deps });
  await deliver(resolved);
  return resolved;
}
