// SPDX-License-Identifier: Apache-2.0
// R-020: small low-risk scope tickets share one review job; larger or riskier tickets stay on their own.
import { reviewTierForTicket, sensitiveReviewReason } from './review-tier.mjs';

const MAX_OUTPUT_FILES = 4;

function arr(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {{ ticket?: object } | object} item */
export function ticketFromReviewItem(item) {
  if (!item || typeof item !== 'object') return null;
  return item.ticket ?? item;
}

/** Scope split keeps worker tickets at size S with at most four outputs; only low risk and non-Opus review tiers batch together. */
export function isSmallLowRiskTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') return false;
  if (ticket.type === 'human') return false;
  if (ticket.sensitive === true) return false;
  if ((ticket.risk ?? 'low') !== 'low') return false;
  if ((ticket.size ?? 'S') !== 'S') return false;
  if (sensitiveReviewReason(ticket)) return false;
  if (reviewTierForTicket(ticket).model === 'opus') return false;
  const paths = [...arr(ticket.files), ...arr(ticket.deletes), ...arr(ticket.tests)];
  return paths.length <= MAX_OUTPUT_FILES;
}

/**
 * Partition items waiting for review so every small low-risk ticket is in one shared batch.
 * Other tickets each get their own single-ticket batch. Order within the shared batch follows input order.
 * @template T
 * @param {readonly T[]} items
 * @returns {T[][]}
 */
export function batchReviewItems(items) {
  const list = arr(items);
  const batchable = [];
  const solo = [];
  for (const item of list) {
    if (isSmallLowRiskTicket(ticketFromReviewItem(item))) batchable.push(item);
    else solo.push(item);
  }
  const groups = solo.map((item) => [item]);
  if (batchable.length > 0) groups.push(batchable);
  return groups;
}
