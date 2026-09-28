// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Project Swarm contributors
// Provider rate-limit classification from Claude CLI stream-json events.

const isObject = value => value !== null && typeof value === 'object';
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

// The rejected event carries no top-level utilization; it sits under unifiedWindows[rateLimitType].
function utilizationOf(info) {
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  return finite(info.utilization) ?? (type === null || !isObject(info.unifiedWindows) ? null : finite(info.unifiedWindows[type]?.utilization));
}

export function summarizeRateLimit(events) {
  const infos = (Array.isArray(events) ? events : []).filter(event => isObject(event) && event.type === 'rate_limit_event' && isObject(event.rate_limit_info)).map(event => event.rate_limit_info);
  if (!infos.length) return null;
  const last = infos[infos.length - 1];
  const utilizations = infos.map(utilizationOf).filter(value => value !== null);
  const resetsAt = finite(last.resetsAt);
  return {
    status: typeof last.status === 'string' ? last.status : null,
    rateLimitType: typeof last.rateLimitType === 'string' ? last.rateLimitType : null,
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
    utilization: utilizationOf(last),
    maxUtilization: utilizations.length ? Math.max(...utilizations) : null,
    warnings: infos.filter(info => info.status === 'allowed_warning').length
  };
}

export function rateLimitError(summary) {
  return summary?.status === 'rejected' ? `Provider rate limit rejected (${summary.rateLimitType ?? 'unknown'}); resets ${summary.resetsAt ?? 'unknown'}` : null;
}

export function rateLimitWarning(jobId, summary) {
  if (!summary || (summary.warnings === 0 && summary.status !== 'rejected')) return null;
  const type = summary.rateLimitType ?? 'unknown';
  if (summary.status === 'rejected') return `rate limit: ${jobId} rejected (${type}); resets ${summary.resetsAt ?? 'unknown'}`;
  const pct = summary.maxUtilization === null || summary.maxUtilization === undefined ? '?' : Math.round(summary.maxUtilization * 100);
  return `rate limit warning: ${jobId} ${type} at ${pct}%`;
}
