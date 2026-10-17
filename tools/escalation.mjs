// SPDX-License-Identifier: Apache-2.0

export const MAX_LEVEL = 3;

const TRUNCATION_MARKERS = ['max_tokens', 'truncated', 'output-cap-exceeded'];

export function isTruncation(error) {
  const text = typeof error === 'string' ? error : String(error?.message ?? error ?? '');
  const lower = text.toLowerCase();
  return TRUNCATION_MARKERS.some((marker) => lower.includes(marker));
}

export function nextStep(ticket, { error } = {}) {
  const truncated = isTruncation(error);
  let level = (Number(ticket?.escalation) || 0) + 1;
  if (truncated) {
    level = Math.min(Math.max(level, 2), MAX_LEVEL + 1);
  }
  const kind = truncated ? 'truncated' : 'failed';
  const status = level <= MAX_LEVEL ? 'ready' : 'blocked';
  const reason = status === 'blocked'
    ? `blocked: ${MAX_LEVEL} escalations failed`
    : `escalated to level ${level} after ${truncated ? 'truncated output' : 'failure'}`;
  return { level, status, kind, reason };
}

export function routingFor(level, base = {}) {
  const baseTokens = base.maxOutputTokens ?? 8192;
  const lvl = Number(level) || 0;
  if (lvl <= 0) return {};
  if (lvl === 1) return { maxOutputTokens: Math.min(baseTokens * 2, 32768) };
  if (lvl === 2) return { maxOutputTokens: 32768, hard: true };
  return {
    maxOutputTokens: 32768,
    tier: 'expensive',
    tierReason: 'escalated after 3 failed attempts',
  };
}

export function sizeTicket(ticket, { sizes = {}, capBytes = 15360, maxFiles = 4 } = {}) {
  const entries = ticket?.outputs ?? ticket?.files ?? [];
  const files = entries.filter((file) => typeof file === 'string' && !file.endsWith('/'));
  const reasons = [];

  if (files.length > maxFiles) {
    reasons.push(`${files.length} output files (max ${maxFiles}); split the ticket.`);
  }

  const total = files.reduce((sum, file) => sum + (sizes[file] ?? 0), 0);
  if (total > capBytes * 0.6) {
    reasons.push(`existing files total ${total} bytes (cap ${Math.floor(capBytes * 0.6)} for a rewrite); split the ticket.`);
  }

  for (const file of files) {
    const size = sizes[file] ?? 0;
    if (size > capBytes * 0.8) {
      reasons.push(`${file} is ${size} bytes (limit ${Math.floor(capBytes * 0.8)}); split the ticket.`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
