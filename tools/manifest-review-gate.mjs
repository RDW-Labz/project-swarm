// SPDX-License-Identifier: Apache-2.0
// Manifest runs and scope sync share one review gate (R-020): the same security reasons, acceptance
// tiers, and low-risk batching ledger tickets get when sync writes .swarm/*-reviews/RUN.json.
import { securityReviewReason, securityReviewManifest } from './security-review.mjs';
import { acceptanceReviewManifest, pickReviewTier, reviewTierForTicket } from './review-tier.mjs';

const arr = (value) => (Array.isArray(value) ? value : []);

/** Models scope sync accepts for each review manifest kind (keep in sync with scope-commands ACC_KIND / SEC_KIND). */
export const SECURITY_REVIEW_MODELS = /^opus$/;
export const ACCEPTANCE_REVIEW_MODELS = /^(haiku|sonnet|opus)$/;

function ticketById(ledger, id) {
  return (ledger?.tickets ?? []).find((t) => t.id === id);
}

/** Ledger tickets that correspond to worker jobs in a scope wave manifest (job id is ticket id). */
export function ledgerTicketsForManifest(manifest, ledger) {
  const jobs = arr(manifest?.jobs).filter((j) => j && typeof j.id === 'string' && j.type !== 'review' && j.type !== 'lead' && j.type !== 'human');
  const out = [];
  for (const job of jobs) {
    const ticket = ticketById(ledger, job.id);
    if (ticket) out.push(ticket);
  }
  return out;
}

/** True when every non-review job in the manifest names a ledger ticket (a scope wave manifest). */
export function isLedgerScopeManifest(manifest, ledger) {
  const jobs = arr(manifest?.jobs).filter((j) => j?.type !== 'review' && j?.type !== 'lead' && j?.type !== 'human');
  if (!jobs.length) return false;
  return jobs.every((j) => ticketById(ledger, j.id));
}

/** Tickets that need an Opus security review before done (same rule as scope sync --integrated). */
export function securityReviewItems(tickets) {
  const out = [];
  for (const ticket of arr(tickets)) {
    const reason = securityReviewReason(ticket);
    if (reason) out.push({ ticket, reason });
  }
  return out;
}

/** Small low-risk tickets may share one acceptance review job (R-020). */
export function isLowRiskBatchable(ticket) {
  if (!ticket || ticket.type === 'human') return false;
  if (ticket.risk !== 'low') return false;
  if ((ticket.size ?? 'M') !== 'S') return false;
  if (ticket.sensitive === true) return false;
  if (securityReviewReason(ticket)) return false;
  return true;
}

/**
 * Partition acceptance review items into batches: one shared batch for all small low-risk tickets,
 * then one batch per remaining ticket.
 * items: [{ ticket, uncovered, hash? }]
 */
export function batchAcceptanceReviewItems(items) {
  const list = arr(items);
  const batchable = [];
  const rest = [];
  for (const item of list) {
    if (isLowRiskBatchable(item.ticket ?? {})) batchable.push(item);
    else rest.push(item);
  }
  const batches = [];
  if (batchable.length) batches.push(batchable);
  for (const item of rest) batches.push([item]);
  return batches;
}

/** Flatten batches back to one list (scope sync writes a single acceptance manifest per run). */
export function mergeAcceptanceBatches(batches) {
  return arr(batches).flat();
}

/** Security review manifest for a scope run (one Opus job, same as sync). */
export async function buildSecurityReviewManifest(root, scopeRunId, items, ledger) {
  return securityReviewManifest(root, scopeRunId, arr(items), arr(ledger?.tickets));
}

/** Acceptance review manifest with model/tier from ticket risk and paths (same as ledger gate). */
export function buildAcceptanceReviewManifest(scopeRunId, items, ledger, options = {}) {
  const tickets = arr(ledger?.tickets);
  const merged = mergeAcceptanceBatches(batchAcceptanceReviewItems(items));
  return acceptanceReviewManifest(scopeRunId, merged, { ...options, tickets });
}

/**
 * Build both review manifests for tickets integrated by a scope run, matching scope sync --integrated.
 * security / acceptance are lists of items in the same shape sync collects (needReview / accNeed).
 */
export async function buildLedgerReviewManifests(root, scopeRunId, { security = [], acceptance = [], ledger, exists = null } = {}) {
  const out = {};
  if (security.length) {
    out.security = await buildSecurityReviewManifest(root, scopeRunId, security, ledger);
  }
  if (acceptance.length) {
    out.acceptance = buildAcceptanceReviewManifest(scopeRunId, acceptance, ledger, { exists });
  }
  return out;
}

/** Apply the ledger review tier to every review job in a manifest (manifest runs and sync files). */
export function applyLedgerReviewTier(manifest, tickets) {
  const tier = pickReviewTier(arr(tickets));
  for (const job of arr(manifest?.jobs)) {
    if (job.type !== 'review') continue;
    job.model = tier.model;
    job.tier = tier.tier;
    job.tierReason = tier.tierReason;
    if (job.agent === undefined || job.agent === 'auto') job.agent = 'claude';
  }
  return manifest;
}

/**
 * Manifest runs that carry scope tickets get the same review gate as ledger scope sync:
 * security manifests stay Opus; acceptance manifests pick model/tier from ticket risk and paths.
 */
export function applyManifestReviewGate(manifest, { ledger } = {}) {
  if (!manifest || !ledger) return manifest;
  const tickets = ledgerTicketsForManifest(manifest, ledger);
  if (!tickets.length) return manifest;
  const sec = securityReviewItems(tickets);
  for (const job of arr(manifest.jobs)) {
    if (job.type !== 'review') continue;
    const id = String(job.id ?? '');
    if (id.startsWith('sec-review-')) {
      job.agent = 'claude';
      job.model = 'opus';
      job.tier = 'expensive';
      job.tierReason = 'Automatic security review of tickets that touch auth, API routes, migrations, policies or sensitive paths.';
      continue;
    }
    if (id.startsWith('acc-review-')) {
      applyLedgerReviewTier({ version: manifest.version ?? 1, jobs: [job] }, tickets);
      continue;
    }
    if (sec.length && job.model === 'opus') {
      job.agent = 'claude';
      job.model = 'opus';
      job.tier = 'expensive';
      job.tierReason = job.tierReason ?? 'Automatic security review of tickets that touch auth, API routes, migrations, policies or sensitive paths.';
    } else {
      applyLedgerReviewTier({ version: manifest.version ?? 1, jobs: [job] }, tickets);
    }
  }
  return manifest;
}

export { reviewTierForTicket, pickReviewTier, securityReviewReason };
