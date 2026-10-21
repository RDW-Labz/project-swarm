// SPDX-License-Identifier: Apache-2.0
// Acceptance and scope reviews pick a model from ticket risk and touched paths (R-020): Opus for sensitive work, Sonnet for normal code, Haiku for tests and docs.
import { securityReviewReason } from './security-review.mjs';

const MODEL_TIER = Object.freeze({ haiku: 'cheap', sonnet: 'mid', opus: 'expensive' });
const TIER_RANK = Object.freeze({ cheap: 0, mid: 1, expensive: 2 });

const PROSE_OR_ASSET = /\.(?:md|mdx|txt|png|jpe?g|svg|webp|gif|pdf)$/i;

function norm(p) {
  return String(p ?? '').split('\\').join('/').replace(/^\.\//, '');
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function isTestPath(p) {
  const n = norm(p);
  const parts = n.split('/');
  const base = parts[parts.length - 1];
  return parts.some((s) => s === 'tests' || s === 'test' || s === '__tests__') || /\.(test|spec)\./.test(base);
}

function isDocsOrTestPath(p) {
  const n = norm(p);
  if (isTestPath(n)) return true;
  if (n.startsWith('docs/')) return true;
  const base = n.split('/').pop();
  return PROSE_OR_ASSET.test(base);
}

/** Paths the ticket writes, deletes, or adds tests for (used to choose a review model). */
export function touchedPaths(ticket) {
  const out = [];
  for (const f of [...arr(ticket?.files), ...arr(ticket?.deletes), ...arr(ticket?.tests)]) {
    if (typeof f !== 'string' || !f) continue;
    const n = norm(f);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function testsAndDocsOnly(paths, ticket) {
  if (paths.length > 0 && paths.every(isDocsOrTestPath)) return true;
  if (paths.length === 0 && ['test', 'docs', 'design'].includes(ticket?.type)) return true;
  return false;
}

/** @returns {{ model: 'haiku'|'sonnet'|'opus', tier: 'cheap'|'mid'|'expensive', tierReason: string }} */
export function reviewTierForTicket(ticket) {
  const paths = touchedPaths(ticket);
  const security = securityReviewReason(ticket);
  if (security) {
    return { model: 'opus', tier: MODEL_TIER.opus, tierReason: `Sensitive review: ${security}` };
  }
  if (ticket?.risk === 'high') {
    return { model: 'opus', tier: MODEL_TIER.opus, tierReason: 'High-risk ticket.' };
  }
  if (testsAndDocsOnly(paths, ticket)) {
    return { model: 'haiku', tier: MODEL_TIER.haiku, tierReason: 'Tests and docs only.' };
  }
  return { model: 'sonnet', tier: MODEL_TIER.sonnet, tierReason: 'Normal code change.' };
}

/** When several tickets share one review job, use the strongest tier any of them needs. */
export function pickReviewTier(tickets) {
  const list = arr(tickets);
  if (list.length === 0) {
    return { model: 'sonnet', tier: MODEL_TIER.sonnet, tierReason: 'Normal code change.' };
  }
  let best = reviewTierForTicket(list[0]);
  for (let i = 1; i < list.length; i++) {
    const next = reviewTierForTicket(list[i]);
    if (TIER_RANK[next.tier] > TIER_RANK[best.tier]) best = next;
  }
  return best;
}
