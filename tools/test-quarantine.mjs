// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

/** @typedef {{ status: string, exitCode?: number|null, tail?: string, durationMs?: number }} CheckAttempt */

export const TEST_QUARANTINE_FILE = '.swarm/test-quarantine.json';

const PASSED = 'passed';
const FAILED = 'failed';
const QUARANTINED = 'quarantined';

export function quarantineEntryKey(checkName, testFile) {
  const check = typeof checkName === 'string' ? checkName.trim() : '';
  const file = typeof testFile === 'string' ? testFile.trim() : '';
  if (!check || !file) return null;
  return `${check}::${file}`;
}

export function quarantineReportLine({ checkName, testFile, reason, runs }) {
  const file = testFile ?? 'unknown-test';
  const why = reason ?? 'flaky';
  const runText = Number.isInteger(runs) && runs > 0 ? `; runs=${runs}` : '';
  return `quarantined-flaky: ${checkName} (${file}) ${why}${runText} — not retried to green`;
}

export function isIntermittentAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  let sawPass = false;
  let sawFail = false;
  for (const attempt of list) {
    if (!attempt || typeof attempt !== 'object') continue;
    if (attempt.status === PASSED) sawPass = true;
    if (attempt.status === FAILED) sawFail = true;
  }
  return sawPass && sawFail;
}

/** True when a later passing attempt would hide an earlier failure (retry-to-green). */
export function silentlyRetryingToGreen(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.length < 2) return false;
  const last = list[list.length - 1];
  if (!last || last.status !== PASSED) return false;
  return list.slice(0, -1).some((attempt) => attempt && attempt.status === FAILED);
}

export function flakyQuarantineReason({ attempts, flakeOnBase, failedFile } = {}) {
  if (flakeOnBase && typeof flakeOnBase === 'object' && flakeOnBase.failed > 0 && failedFile) {
    return { quarantine: true, reason: 'pre-existing-on-base', testFile: failedFile };
  }
  if (silentlyRetryingToGreen(attempts)) {
    return { quarantine: true, reason: 'retry-to-green', testFile: failedFile ?? null };
  }
  if (isIntermittentAttempts(attempts)) {
    return { quarantine: true, reason: 'intermittent-repeat', testFile: failedFile ?? null };
  }
  return { quarantine: false, reason: null, testFile: failedFile ?? null };
}

export function shouldQuarantineInsteadOfRetry(context) {
  return flakyQuarantineReason(context).quarantine;
}

function appendTail(tail, line) {
  const old = typeof tail === 'string' ? tail : '';
  if (!old) return line;
  if (old.endsWith('\n')) return old + line;
  return old + '\n' + line;
}

/**
 * After a check finishes (or a repeat series), quarantine flaky outcomes and never upgrade a
 * retry-to-green series to passed.
 */
export function flakeQuarantineGuard(check, result, options = {}) {
  const base = result && typeof result === 'object' ? result : { status: FAILED, tail: '' };
  const attempts = Array.isArray(options.attempts) ? options.attempts : [];
  const failedFile = typeof options.failedFile === 'string' ? options.failedFile : undefined;
  const flakeOnBase = options.flakeOnBase;
  const decision = flakyQuarantineReason({ attempts, flakeOnBase, failedFile });
  if (!decision.quarantine) return base;

  const checkName = check?.name ?? 'check';
  const runs = Number.isInteger(options.runs) ? options.runs : (attempts.length || undefined);
  const line = quarantineReportLine({
    checkName,
    testFile: decision.testFile ?? failedFile ?? 'unknown-test',
    reason: decision.reason,
    runs,
  });

  const status = base.status === PASSED || base.status === FAILED ? QUARANTINED : base.status;
  return {
    ...base,
    status,
    quarantined: true,
    quarantineReason: decision.reason,
    ...(decision.testFile ? { quarantinedFile: decision.testFile } : failedFile ? { quarantinedFile: failedFile } : {}),
    tail: appendTail(base.tail, line),
  };
}

/** Pick the visible check outcome for a repeat series without treating retry-to-green as passed. */
export function finalizeRepeatAttempts(check, attempts, options = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) {
    return {
      result: flakeQuarantineGuard(check, { status: FAILED, tail: 'no check attempts recorded' }, options),
      runs: 0,
    };
  }

  if (silentlyRetryingToGreen(list)) {
    const last = list[list.length - 1];
    return {
      result: flakeQuarantineGuard(check, last, { ...options, attempts: list, runs: list.length }),
      runs: list.length,
      quarantined: true,
    };
  }

  const firstBad = list.findIndex((attempt) => attempt && attempt.status !== PASSED);
  if (firstBad >= 0) {
    const slice = list.slice(0, firstBad + 1);
    const raw = list[firstBad];
    const result = flakeQuarantineGuard(check, raw, { ...options, attempts: slice, runs: firstBad + 1 });
    return {
      result,
      runs: firstBad + 1,
      ...(result.quarantined ? { quarantined: true } : {}),
      ...(firstBad + 1 < list.length ? { unusedAttempts: list.length - firstBad - 1 } : {}),
    };
  }

  const last = list[list.length - 1];
  const gate = blockSilentRetryToGreen({ attempts: list, result: last, quarantined: false });
  if (!gate.allowRetry) {
    const result = flakeQuarantineGuard(check, last, { ...options, attempts: list, runs: list.length });
    return {
      result,
      runs: list.length,
      quarantined: true,
      retryBlocked: gate.reason,
    };
  }
  const result = flakeQuarantineGuard(check, last, { ...options, attempts: list, runs: list.length });
  return {
    result,
    runs: list.length,
    ...(result.quarantined ? { quarantined: true } : {}),
  };
}

const ERRORED_CHECK_STATUSES = new Set(['spawn-error', 'unrunnable', 'cannot-run', 'check-env-missing']);

/**
 * Integrate check runner hook (T-0080 wires `runChecks` here): finalize a repeat series, apply
 * quarantine reporting, and refuse silent retry-to-green on errored-check respawn.
 *
 * @param {object} check manifest check `{ name, ... }`
 * @param {{
 *   attempts?: CheckAttempt[],
 *   result?: object,
 *   failedFile?: string,
 *   flakeOnBase?: object,
 *   erroredRetryResult?: object|null,
 * }} bundle
 */
export function integrateCheckRunner(check, bundle = {}) {
  const list = Array.isArray(bundle.attempts) ? bundle.attempts.slice() : [];
  const raw = bundle.result && typeof bundle.result === 'object' ? bundle.result : { status: FAILED, tail: '' };
  const options = {
    failedFile: typeof bundle.failedFile === 'string' ? bundle.failedFile : undefined,
    flakeOnBase: bundle.flakeOnBase,
  };

  const attemptSeries = list.length ? list : [raw];
  let { result, runs, quarantined, unusedAttempts, retryBlocked } = list.length
    ? finalizeRepeatAttempts(check, list, options)
    : {
      result: flakeQuarantineGuard(check, raw, { ...options, attempts: attemptSeries, runs: 1 }),
      runs: 1,
      quarantined: Boolean(raw.quarantined),
    };

  const erroredRetry = bundle.erroredRetryResult && typeof bundle.erroredRetryResult === 'object'
    ? bundle.erroredRetryResult
    : null;
  if (erroredRetry && ERRORED_CHECK_STATUSES.has(raw.status)) {
    const beforeRetry = blockSilentRetryToGreen({ attempts: attemptSeries, result, quarantined });
    if (!beforeRetry.allowRetry) {
      result = flakeQuarantineGuard(check, result, { ...options, attempts: attemptSeries, runs });
      quarantined = true;
      retryBlocked = beforeRetry.reason;
    } else {
      const extended = [...attemptSeries, erroredRetry];
      const after = finalizeRepeatAttempts(check, extended, options);
      result = after.result;
      runs = after.runs;
      quarantined = after.quarantined;
      unusedAttempts = after.unusedAttempts;
      retryBlocked = after.retryBlocked;
      const afterGate = blockSilentRetryToGreen({ attempts: extended, result, quarantined });
      if (!afterGate.allowRetry) {
        result = flakeQuarantineGuard(check, result, { ...options, attempts: extended, runs });
        quarantined = true;
        retryBlocked = afterGate.reason;
      }
    }
  } else {
    const gate = blockSilentRetryToGreen({ attempts: attemptSeries, result, quarantined });
    if (!gate.allowRetry) {
      result = flakeQuarantineGuard(check, result, { ...options, attempts: attemptSeries, runs });
      quarantined = true;
      retryBlocked = gate.reason;
    }
  }

  const policy = blockSilentRetryToGreen({ attempts: attemptSeries, result, quarantined });
  return {
    result,
    runs,
    quarantined: Boolean(quarantined || result.quarantined),
    allowRetry: policy.allowRetry,
    retryBlockReason: policy.reason ?? retryBlocked ?? null,
    ...(unusedAttempts ? { unusedAttempts } : {}),
  };
}

/** Persist a quarantined outcome from {@link integrateCheckRunner} when `root` is known. */
export async function integrateCheckRunnerRecord(root, check, outcome, { runId, fsImpl = fs } = {}) {
  const result = outcome?.result;
  if (!result?.quarantined) return null;
  const testFile = result.quarantinedFile ?? outcome?.failedFile;
  if (!testFile || typeof testFile !== 'string') return null;
  return recordQuarantinedFlakyCheck(root, {
    checkName: check?.name ?? 'check',
    testFile,
    reason: result.quarantineReason ?? 'flaky',
    runId,
  }, fsImpl);
}

export async function loadTestQuarantine(root, fsImpl = fs) {
  if (typeof root !== 'string' || !root) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(await fsImpl.readFile(path.join(root, TEST_QUARANTINE_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1, entries: {} };
    const entries = parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)
      ? parsed.entries
      : parsed;
    if (entries === parsed) {
      const out = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'version') continue;
        if (value && typeof value === 'object') out[key] = value;
      }
      return { version: 1, entries: out };
    }
    return { version: 1, entries };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 1, entries: {} };
    throw error;
  }
}

export async function saveTestQuarantine(root, store, fsImpl = fs) {
  const entries = store?.entries && typeof store.entries === 'object' ? store.entries : {};
  const payload = { version: 1, entries };
  const file = path.join(root, TEST_QUARANTINE_FILE);
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  await fsImpl.writeFile(file, JSON.stringify(payload, null, 2));
  return payload;
}

export async function recordQuarantinedFlakyCheck(root, entry, fsImpl = fs) {
  const checkName = entry?.checkName;
  const testFile = entry?.testFile;
  const key = quarantineEntryKey(checkName, testFile);
  if (!key) throw new Error('quarantine-record-needs-check-and-file');

  const store = await loadTestQuarantine(root, fsImpl);
  const now = typeof entry.at === 'string' ? entry.at : new Date().toISOString();
  const prev = store.entries[key] ?? { hits: 0, hitTimestamps: [] };
  const hitTimestamps = [...(Array.isArray(prev.hitTimestamps) ? prev.hitTimestamps : []), now];
  store.entries[key] = {
    checkName,
    testFile,
    reason: entry.reason ?? prev.reason ?? 'flaky',
    lastSeenAt: now,
    hits: hitTimestamps.length,
    hitTimestamps,
    ...(entry.runId ? { lastRunId: entry.runId } : {}),
    ...(entry.flakeOnBase ? { flakeOnBase: entry.flakeOnBase } : {}),
  };
  await saveTestQuarantine(root, store, fsImpl);
  return store.entries[key];
}

export async function isTestQuarantined(root, { checkName, testFile }, fsImpl = fs) {
  const key = quarantineEntryKey(checkName, testFile);
  if (!key) return false;
  const store = await loadTestQuarantine(root, fsImpl);
  return Object.prototype.hasOwnProperty.call(store.entries, key);
}

/**
 * Integrate/ship must not schedule another run of the same check argv hoping for green when the
 * outcome is already quarantined flaky.
 */
export function blockSilentRetryToGreen({ attempts, result, quarantined }) {
  if (quarantined || result?.quarantined || result?.status === QUARANTINED) {
    return { allowRetry: false, reason: 'quarantined-flaky' };
  }
  if (silentlyRetryingToGreen(attempts)) {
    return { allowRetry: false, reason: 'retry-to-green' };
  }
  return { allowRetry: true, reason: null };
}
