// SPDX-License-Identifier: Apache-2.0

export const REFUSED_KINDS = Object.freeze([
  'merge',
  'deploy',
  'cap-raise',
  'spend',
  'key',
  'migration',
]);

const SOURCES = new Set(['board', 'phone']);
const ALLOWED_DECISIONS = new Set(['approve', 'deny']);

// A refused kind is an exact token after trimming and case-folding, or a refused
// token followed by a separator. Separators are any characters outside ASCII
// letters and digits, so `merge-request` is refused while `merger` is not.
const REFUSED_KIND_RE = /^(?:merge|deploy|cap-raise|spend|key|migration)(?:$|[^a-z0-9])/i;

function normalizedString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function isRefusedKind(value) {
  const normalized = normalizedString(value);
  return normalized !== null && REFUSED_KIND_RE.test(normalized);
}

export function guardBoardAction({ kind, source, itemKind } = {}) {
  if (typeof source !== 'string' || !SOURCES.has(source)) {
    return { allowed: false, reason: 'source-refused' };
  }

  const normalizedKind = normalizedString(kind);
  if (normalizedKind === null || !ALLOWED_DECISIONS.has(normalizedKind) || isRefusedKind(normalizedKind)) {
    return { allowed: false, reason: 'kind-refused' };
  }

  const normalizedItemKind = normalizedString(itemKind);
  if (normalizedItemKind === null || normalizedItemKind === '' || isRefusedKind(normalizedItemKind)) {
    return { allowed: false, reason: 'item-kind-refused' };
  }

  return { allowed: true, reason: 'allowed' };
}
