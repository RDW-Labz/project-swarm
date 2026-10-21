// SPDX-License-Identifier: Apache-2.0
import { isSensitiveText } from './scope.mjs';

/** Topics that may auto-tag a ticket sensitive (R-010). */
export const SENSITIVE_TICKET_TOPICS = Object.freeze(['auth', 'database', 'payments', 'secrets', 'public-routes']);

const TOPIC_PATTERNS = Object.freeze({
  auth: /\b(?:auth(?:entication|orization)?|sign[- ]?in|signed[- ]?in|log[- ]?in|log[- ]?out|oauth|openid|session|jwt|password|passkey|sso|clerk|better auth)\b/iu,
  database: /\b(?:database|postgres(?:ql)?|sql|migration|supabase|pgtap|neon|drizzle|prisma|sqlite|mysql|lakebase)\b/iu,
  payments: /\b(?:payments?|stripe|billing|checkout|invoice|paywall|merchant|card(?:holder)?)\b/iu,
  secrets: /\b(?:secrets?|credentials?|api[- ]?keys?|private[- ]?keys?|keychain|\.env\b)\b/iu,
  'public-routes': /\b(?:public routes?|unauthenticated routes?|anonymous (?:access|route)|public api|public endpoint)\b/iu,
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
  if (typeof text !== 'string') return false;
  if (sensitiveTopicsInText(text).size > 0) return true;
  const entries = filteredSensitiveScope(scope);
  if (!entries.length) return false;
  return isSensitiveText({ sensitive: entries }, text);
}

export function isSensitiveTicket(ticket, scope, reqLookup) {
  if (ticket?.sensitive === true) return true;
  if (!scope) return false;
  return isSensitiveTicketText(scope, sensitiveTicketText(ticket, reqLookup));
}
