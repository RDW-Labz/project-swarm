// SPDX-License-Identifier: Apache-2.0

export const REFUSED_KINDS = Object.freeze([
  'merge',
  'deploy',
  'cap-raise',
  'spend',
  'key',
  'migration',
]);

export const ALLOWED_KINDS = Object.freeze([
  'handbuild',
  'decision',
  'proposed-ticket',
  'scope',
]);

const ALLOWED_ITEM_KINDS = new Set(ALLOWED_KINDS);

const SOURCES = new Set(['board', 'phone']);
const ALLOWED_DECISIONS = new Set(['approve', 'deny']);

const REFUSED_WORDS = new Set([
  'merge',
  'deploy',
  'cap',
  'budget',
  'spend',
  'key',
  'keys',
  'secret',
  'migration',
  'migrate',
  'rollback-prod',
]);

export function kindWords(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  const spaced = trimmed
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^\w\s-]+/g, ' ');
  return spaced.toLowerCase().split(/[-_.: \t]+/).filter(Boolean);
}

const PROTECTED_TOPIC_WORDS = new Set([
  'merge',
  'merged',
  'merging',
  'deploy',
  'deployed',
  'deployment',
  'spend',
  'spending',
  'cap',
  'caps',
  'budget',
  'key',
  'keys',
  'secret',
  'secrets',
  'token',
  'tokens',
  'migration',
  'migrations',
  'migrate',
  'rollback-prod',
]);

/** True when decision text must not be marked board-safe or answered from the board. */
export function isProtectedTopic(text) {
  if (typeof text !== 'string') return true;
  const words = kindWords(text);
  if (words === null) return true;
  if (words.length === 0) return false;
  const lower = text.toLowerCase();
  if (lower.includes('pull request') && words.includes('merge')) return true;
  for (const word of words) {
    if (PROTECTED_TOPIC_WORDS.has(word)) return true;
  }
  return false;
}

export function isRefusedActionKind(value) {
  const words = kindWords(value);
  if (words === null) return true;
  if (words.length === 0) return true;
  if (words.includes('limit') && words.includes('raise')) return true;
  if (REFUSED_WORDS.has(words.join('-'))) return true;
  if (REFUSED_KINDS.includes(words.join('-'))) return true;
  for (const word of words) {
    if (REFUSED_WORDS.has(word)) return true;
    if (REFUSED_KINDS.includes(word)) return true;
  }
  return false;
}

function normalizedString(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

export function guardBoardAction({ kind, source, itemKind } = {}) {
  if (typeof source !== 'string' || !SOURCES.has(source)) {
    return { allowed: false, reason: 'source-refused' };
  }

  const normalizedKind = normalizedString(kind);
  if (normalizedKind === null || !ALLOWED_DECISIONS.has(normalizedKind) || isRefusedActionKind(normalizedKind)) {
    return { allowed: false, reason: 'kind-refused' };
  }

  const normalizedItemKind = normalizedString(itemKind);
  if (normalizedItemKind === null || normalizedItemKind === '') {
    return { allowed: false, reason: 'item-kind-refused' };
  }
  if (isRefusedActionKind(itemKind)) {
    return { allowed: false, reason: 'item-kind-refused' };
  }
  if (!ALLOWED_ITEM_KINDS.has(normalizedItemKind)) {
    return { allowed: false, reason: 'not an allowed action kind' };
  }

  return { allowed: true, reason: 'allowed' };
}
