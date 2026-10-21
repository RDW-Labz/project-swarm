// SPDX-License-Identifier: Apache-2.0

/** Topics that may auto-tag a ticket sensitive (R-010). */
export const SENSITIVE_TICKET_TOPICS = Object.freeze(['auth', 'database', 'payments', 'secrets', 'public-routes']);

const TOPIC_PATTERNS = Object.freeze({
  auth:
    /\b(?:auth(?:entication|orization|z)?|sign[- ]?in|signed[- ]?in|log[- ]?in|log[- ]?out|oauth|openid|session|jwt|password|passkey|sso|clerk|better auth|tokens?|(?:refresh|access)\s+tokens?|cookies?|csrf|permissions?|roles?)\b/iu,
  database:
    /\b(?:database|postgres(?:ql)?|sql|migration|supabase|pgtap|neon|drizzle|prisma|sqlite|mysql|lakebase|rls|row[- ]level security|(?:rls|row[- ]level security)\s+polic(?:y|ies))\b/iu,
  payments: /\b(?:payments?|stripe|billing|checkout|invoice|paywall|merchant|card(?:holder)?)\b/iu,
  secrets: /\b(?:secrets?|credentials?|api[- ]?keys?|private[- ]?keys?|keychain)\b|(?<![\p{L}\p{N}_])\.env\b/iu,
  'public-routes': /\b(?:public[- ]routes?|unauthenticated[- ]routes?|anonymous (?:access|routes?)|public[- ]api|public[- ]endpoints?)\b/iu,
});

export function sensitiveTopicsInText(text) {
  if (typeof text !== 'string' || !text.trim()) return new Set();
  const topics = new Set();
  for (const topic of SENSITIVE_TICKET_TOPICS) {
    if (TOPIC_PATTERNS[topic].test(text)) topics.add(topic);
  }
  return topics;
}

export function isSensitiveScopeEntry(entry) {
  return sensitiveTopicsInText(String(entry ?? '')).size > 0;
}

export function filteredSensitiveScope(scope) {
  if (!Array.isArray(scope?.sensitive)) return [];
  return scope.sensitive
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry !== '' && isSensitiveScopeEntry(entry));
}

export function sensitiveTicketText(ticket, reqLookup) {
  const reqs = reqLookup instanceof Map ? reqLookup : new Map();
  const parts = [ticket?.title, ticket?.epic, ...(ticket?.acceptance ?? []), ...(ticket?.files ?? [])];
  for (const id of ticket?.scopeRefs ?? []) {
    const r = reqs.get(id);
    if (r) parts.push(r.text, ...(r.acceptance ?? []));
  }
  return parts.filter((x) => x != null).join('\n');
}

export function isSensitiveTicketText(scope, text) {
  // Scope phrases may include unrelated product words alongside a sensitive
  // topic. Only the topic itself should trigger automatic tagging.
  return sensitiveTopicsInText(text).size > 0;
}

export function isSensitiveTicket(ticket, scope, reqLookup) {
  if (ticket?.sensitive === true) return true;
  return isSensitiveTicketText(scope, sensitiveTicketText(ticket, reqLookup));
}
