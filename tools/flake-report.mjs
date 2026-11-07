// SPDX-License-Identifier: Apache-2.0
// T-0078 / R-018: report quarantined flaky checks in integrate run state and ship output.
import {
  blockSilentRetryToGreen,
  integrateCheckRunner,
  quarantineEntryKey,
  quarantineReportLine,
} from './test-quarantine.mjs';

export const QUARANTINED_CHECK_STATUS = 'quarantined';

/** Check statuses that must never count as green for integrate or ship. */
export const CHECK_NOT_PASSED_STATUSES = new Set([
  'failed',
  'timeout',
  'spawn-error',
  'unrunnable',
  'cannot-run',
  'check-env-missing',
  'cleanup-failed',
  'cancelled',
  QUARANTINED_CHECK_STATUS,
]);

export function isQuarantinedCheckResult(result) {
  if (!result || typeof result !== 'object') return false;
  return Boolean(result.quarantined || result.status === QUARANTINED_CHECK_STATUS);
}

export function checkCountsAsPassed(check) {
  if (!check || typeof check !== 'object') return false;
  const status = typeof check.status === 'string' ? check.status : '';
  return status.length > 0 && !CHECK_NOT_PASSED_STATUSES.has(status);
}

function coerceQuarantinedStatus(result) {
  if (!isQuarantinedCheckResult(result)) return result;
  if (result.status === 'passed' || result.status === 'failed' || result.status == null) {
    return { ...result, status: QUARANTINED_CHECK_STATUS, quarantined: true };
  }
  return { ...result, quarantined: true };
}

/**
 * One integrate check row for {@code state.checks}: never leaves a quarantined outcome as passed.
 *
 * @param {object} check manifest check `{ name, ... }`
 * @param {ReturnType<integrateCheckRunner>} outcome
 */
export function checkRowFromIntegrateOutcome(check, outcome) {
  const raw = outcome?.result && typeof outcome.result === 'object' ? outcome.result : { status: 'failed', tail: '' };
  const name = check?.name ?? raw.name ?? 'check';
  const row = coerceQuarantinedStatus({
    ...raw,
    name,
    runs: outcome?.runs ?? raw.runs ?? 1,
    ...(outcome?.quarantined || raw.quarantined ? { quarantined: true } : {}),
    ...(raw.quarantineReason ? { quarantineReason: raw.quarantineReason } : {}),
    ...(raw.quarantinedFile ? { quarantinedFile: raw.quarantinedFile } : {}),
    ...(outcome?.retryBlockReason ? { retryBlocked: outcome.retryBlockReason } : {}),
    ...(outcome?.unusedAttempts ? { unusedAttempts: outcome.unusedAttempts } : {}),
    ...(outcome?.allowRetry === false ? { allowRetry: false } : {}),
  });
  return row;
}

/**
 * @param {object} check
 * @param {ReturnType<integrateCheckRunner>} outcome
 * @returns {object|null}
 */
export function quarantinedFlakyEntry(check, outcome) {
  const result = outcome?.result;
  const quarantined = Boolean(outcome?.quarantined || isQuarantinedCheckResult(result));
  if (!quarantined) return null;

  const checkName = check?.name ?? result?.name ?? 'check';
  const testFile = result?.quarantinedFile ?? outcome?.failedFile;
  if (!testFile || typeof testFile !== 'string') return null;

  const key = quarantineEntryKey(checkName, testFile);
  if (!key) return null;

  const reason = result?.quarantineReason ?? outcome?.retryBlockReason ?? 'flaky';
  const runs = outcome?.runs ?? result?.runs ?? 1;
  return {
    key,
    checkName,
    testFile,
    reason,
    runs,
    line: quarantineReportLine({ checkName, testFile, reason, runs }),
    allowRetry: outcome?.allowRetry === true,
    retryBlockReason: outcome?.retryBlockReason ?? null,
  };
}

/** @param {{ check?: object, outcome?: object }[]} checkOutcomes */
export function collectQuarantinedFlaky(checkOutcomes) {
  const list = Array.isArray(checkOutcomes) ? checkOutcomes : [];
  const entries = [];
  const seen = new Set();
  for (const item of list) {
    const entry = quarantinedFlakyEntry(item?.check, item?.outcome ?? item);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

/**
 * Apply quarantine reporting to integrate run state (`checks`, `quarantinedFlaky`, `checksPassed`).
 *
 * @param {object} [state]
 * @param {{ check: object, outcome: ReturnType<integrateCheckRunner> }[]} checkOutcomes
 */
export function applyFlakeReportToRunState(state, checkOutcomes) {
  const base = state && typeof state === 'object' ? { ...state } : {};
  const list = Array.isArray(checkOutcomes) ? checkOutcomes : [];
  const checks = list.map(({ check, outcome }) => checkRowFromIntegrateOutcome(check, outcome));
  const quarantinedFlaky = collectQuarantinedFlaky(list);
  const checksPassed = checks.every(checkCountsAsPassed);
  return {
    ...base,
    checks,
    quarantinedFlaky,
    checksPassed,
    ...(quarantinedFlaky.length ? { flakeQuarantineReported: true } : {}),
  };
}

/** Finalize one manifest check and return rows for run state and ship. */
export function finalizeCheckWithFlakeReport(check, bundle) {
  const outcome = integrateCheckRunner(check, bundle);
  return {
    check,
    outcome,
    checkRow: checkRowFromIntegrateOutcome(check, outcome),
    quarantinedEntry: quarantinedFlakyEntry(check, outcome),
  };
}

/** Batch finalize: manifest checks with per-check integrate bundles. */
export function integrateChecksFlakeReport(checks, bundles) {
  const manifestChecks = Array.isArray(checks) ? checks : [];
  const bundleList = Array.isArray(bundles) ? bundles : [];
  const checkOutcomes = manifestChecks.map((check, index) => ({
    check,
    outcome: integrateCheckRunner(check, bundleList[index] ?? {}),
  }));
  return applyFlakeReportToRunState({}, checkOutcomes);
}

export function shipCheckRenderSuffix(result) {
  if (!isQuarantinedCheckResult(result)) return '';
  const file = result.quarantinedFile ?? 'unknown-test';
  const why = result.quarantineReason ?? 'flaky';
  const runText = Number.isInteger(result.runs) && result.runs > 0 ? `; runs=${result.runs}` : '';
  return ` — quarantined flaky (${file}) ${why}${runText}; not retried to green`;
}

/** Prepare integrate/ship check results for PR rendering (status stays quarantined, never passed). */
export function annotateShipChecks(results) {
  return (Array.isArray(results) ? results : []).map((result) => {
    if (!result || typeof result !== 'object') return result;
    const row = coerceQuarantinedStatus(result);
    if (!isQuarantinedCheckResult(row)) return result;
    return { ...row, shipNote: shipCheckRenderSuffix(row) };
  });
}

export function shipWarningsForQuarantinedFlaky(checks) {
  const warnings = [];
  for (const check of annotateShipChecks(checks)) {
    if (!isQuarantinedCheckResult(check)) continue;
    const name = check.name ?? 'check';
    warnings.push(check.line ?? quarantineReportLine({
      checkName: name,
      testFile: check.quarantinedFile ?? 'unknown-test',
      reason: check.quarantineReason ?? 'flaky',
      runs: check.runs,
    }));
    if (check.retryBlocked) warnings.push(`retry-blocked: ${name} (${check.retryBlocked})`);
  }
  return warnings;
}

/**
 * Whether ship may schedule another flaky rerun (integrate tree or CI). Quarantined outcomes never
 * silently retry to green.
 */
export function shipAllowFlakyRerun(checks, gateContext = {}) {
  const policy = blockSilentRetryToGreen(gateContext);
  if (!policy.allowRetry) return { allow: false, reason: policy.reason };
  const blocked = (Array.isArray(checks) ? checks : []).some((row) => isQuarantinedCheckResult(row));
  if (blocked) return { allow: false, reason: 'quarantined-flaky' };
  return { allow: true, reason: null };
}
