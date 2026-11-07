// SPDX-License-Identifier: Apache-2.0
// R-019 / T-0081: cached base-check verdict policy. Green verdicts at a base sha and checks
// fingerprint are reused; a cached red (or any non-green) verdict is never trusted and is always
// recomputed on the next run.
import crypto from 'node:crypto';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function baseChecksCacheRel(baseSha) {
  return `.swarm/base-checks/${baseSha}.json`;
}

export function checksKeyFor(checks) {
  return digest(JSON.stringify((checks ?? []).map(check => [check.name, check.argv, check.base ?? true])));
}

export function parseBaseCheckCacheRecord(bytes) {
  if (bytes == null) return null;
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  try {
    const record = JSON.parse(text);
    return record !== null && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/** @returns {object|null} the cached record when it may be returned without re-running checks */
export function reusableCachedBaseCheck(record, checksKey) {
  if (!record || record.checksKey !== checksKey) return null;
  if (record.status !== 'green') return null;
  if (Array.isArray(record.failures) && record.failures.length) return null;
  return record;
}

/** Raw cache file bytes (e.g. from `bytesAt`); null when checks must run again. */
export function resolveCachedBaseCheckBytes(cachedBytes, checksKey) {
  return reusableCachedBaseCheck(parseBaseCheckCacheRecord(cachedBytes), checksKey);
}

export async function readCachedBaseCheck(root, { baseSha, checksKey, readBytes }) {
  const cached = await readBytes(root, baseChecksCacheRel(baseSha), true);
  return resolveCachedBaseCheckBytes(cached, checksKey);
}
