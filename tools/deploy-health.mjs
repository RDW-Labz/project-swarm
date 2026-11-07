// SPDX-License-Identifier: Apache-2.0
// Production health URL and error-log polling for the post-merge deploy watch (R-031, T-0147).
import { previewBase, realGet } from './handoff-docs.mjs';
import { pullErrors, validateErrorsConfig } from './errors.mjs';

export const POLL_INTERVAL_MS = 60 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow = () => Date.now();

/** GET the configured preview /health (or the preview root if /health is missing). */
export async function checkProductionHealth(handoffConfig, { fetchImpl } = {}) {
  const base = previewBase({ config: handoffConfig });
  if (base.error) return { ok: false, kind: 'health', reason: base.error };
  const healthUrl = `${base.base.replace(/\/$/, '')}/health`;
  let res;
  try {
    res = await realGet(healthUrl, { fetchImpl });
  } catch {
    res = await realGet(base.base, { fetchImpl });
  }
  if (res.status >= 200 && res.status <= 299) return { ok: true, kind: 'health', url: healthUrl };
  return { ok: false, kind: 'health', reason: `health-http-${res.status || 'unreachable'}` };
}

function eventMs(ev) {
  const raw = ev?.at ?? ev?.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  const t = Date.parse(String(raw ?? ''));
  return Number.isFinite(t) ? t : NaN;
}

/** Pull production errors and fail when any event appeared since shortly before the watch started. */
export async function checkProductionErrors(root, startedAtMs, errorsConfig, pullErrorsImpl = pullErrors) {
  const cfg = errorsConfig ?? validateErrorsConfig({}).config;
  let pulled;
  try {
    pulled = await pullErrorsImpl(root, { config: cfg });
  } catch (error) {
    return { ok: false, kind: 'errors', reason: String(error?.message ?? 'errors-source-failed').slice(0, 120) };
  }
  const since = startedAtMs - 60_000;
  const bad = (pulled.events ?? []).filter((ev) => {
    const t = eventMs(ev);
    return Number.isFinite(t) && t >= since;
  });
  if (bad.length) {
    return { ok: false, kind: 'errors', reason: `production-errors-${bad.length}`, count: bad.length };
  }
  return { ok: true, kind: 'errors', lines: pulled.lines ?? 0 };
}

/** One poll cycle: production health endpoint and error logs. */
export async function pollHealthAndErrors(
  root,
  { handoffConfig, errorsConfig, startedAtMs, pullErrorsImpl = pullErrors, fetchImpl } = {},
) {
  const checks = await Promise.all([
    checkProductionHealth(handoffConfig, { fetchImpl }),
    checkProductionErrors(root, startedAtMs, errorsConfig, pullErrorsImpl),
  ]);
  const failures = checks.filter((c) => !c.ok);
  return { ok: failures.length === 0, checks, failures };
}

/**
 * Run health and error log checks every `intervalMs` until `endsAtMs` or a check fails (AC1).
 * Returns { status: 'passed' | 'failed', ticks, checks, failures?, reason? }.
 */
export async function runHealthErrorPollWindow(
  root,
  {
    handoffConfig,
    errorsConfig,
    startedAtMs,
    endsAtMs,
    intervalMs = POLL_INTERVAL_MS,
    sleep = defaultSleep,
    now = defaultNow,
    pullErrorsImpl = pullErrors,
    fetchImpl,
    onTick,
  } = {},
) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endsAtMs) || endsAtMs <= startedAtMs) {
    return { status: 'failed', ticks: 0, reason: 'invalid-watch-window' };
  }
  let ticks = 0;
  let lastChecks = [];
  while (now() < endsAtMs) {
    const tick = await pollHealthAndErrors(root, {
      handoffConfig,
      errorsConfig,
      startedAtMs,
      pullErrorsImpl,
      fetchImpl,
    });
    ticks += 1;
    lastChecks = tick.checks;
    if (typeof onTick === 'function') {
      await onTick({ ticks, ...tick });
    }
    if (!tick.ok) {
      const reason = tick.failures.map((f) => f.reason).join('; ') || 'health-error-check-failed';
      return { status: 'failed', ticks, checks: lastChecks, failures: tick.failures, reason };
    }
    const remaining = endsAtMs - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return { status: 'passed', ticks, checks: lastChecks };
}
