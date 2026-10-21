// SPDX-License-Identifier: Apache-2.0
// Ticket Manager scope-time checks: context on the ledger, file ownership, gating (R-036 / T-0200).

import { checkTicketTree } from '../../scope-integrity.mjs';
import { buildTicketContext } from '../../ticket-context.mjs';
import { requirementText } from '../../scope.mjs';
import { READY_POOL_MIN, checkReadyPool } from './ready-pool.mjs';

const activeOf = (tickets) => tickets.filter((t) => t && t.status !== 'cancelled' && t.status !== 'proposed');
const norm = (p) => String(p).split('\\').join('/').replace(/^\.\//, '');
const listOf = (ids, n = 6) => ids.slice(0, n).join(', ') + (ids.length > n ? ` and ${ids.length - n} more` : '');

/**
 * SQL paths the ticket text implies (function or table names in migrations), beyond buildTicketContext.
 *
 * @param {object} ticket
 * @param {string} reqText
 * @param {(path: string) => boolean} exists
 * @param {(dir: string) => string[]|undefined} [listFiles]
 * @returns {string[]}
 */
function supplementalDbContextPaths(ticket, reqText, exists, listFiles) {
  if (typeof listFiles !== 'function') return [];
  const text = [ticket.title, ticket.epic, reqText, ...(Array.isArray(ticket.acceptance) ? ticket.acceptance : [])].filter(Boolean).join('\n');
  const words = new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{5,}/g) || []).filter((w) => w.length >= 6));
  if (!words.size) return [];
  const sqlFiles = (listFiles('supabase') || []).map(norm).filter((f) => /\.sql$/.test(f) && exists(f));
  const matched = sqlFiles.filter((f) => [...words].some((w) => f.toLowerCase().includes(w)));
  const out = new Set(matched);
  if (matched.some((f) => /^supabase\/migrations\//.test(f))) {
    if (exists('supabase/seed.sql')) out.add('supabase/seed.sql');
  }
  return [...out].sort();
}

/**
 * @param {object} item
 * @param {'error'|'warning'} level
 */
function treeItemToFinding(item, level) {
  const code = item.code;
  if (code === 'conflict') {
    const first = Array.isArray(item.conflicts) && item.conflicts[0] ? item.conflicts[0] : null;
    const pair = first?.tickets ?? [];
    return {
      code: 'file-ownership-conflict',
      severity: 'needs_you',
      action: 'change-scope-tickets',
      reason: item.message,
      ticket: pair[0],
      recommendation: 'Make one ticket depend on the other or give them different files.',
    };
  }
  if (code === 'test-owned-by-later') {
    const first = Array.isArray(item.items) && item.items[0] ? item.items[0] : null;
    return {
      code: 'test-owned-by-later',
      severity: 'warn',
      action: 'add-context',
      reason: item.message,
      ticket: first?.ticket,
      recommendation: 'Remove the test from the earlier ticket or make the test owner a dependency.',
    };
  }
  if (code === 'gating-ticket') {
    const first = Array.isArray(item.items) && item.items[0] ? item.items[0] : null;
    return {
      code: 'gating-ticket',
      severity: 'warn',
      action: 'split-ticket',
      reason: item.message,
      ticket: first?.ticket,
      gatesCount: first?.gates ?? undefined,
      recommendation: 'Split shared files into early small tickets so one block does not hold the stage.',
    };
  }
  if (level === 'error') {
    return {
      code,
      severity: 'needs_you',
      action: 'change-scope-tickets',
      reason: item.message,
    };
  }
  return {
    code,
    severity: 'warn',
    action: 'split-ticket',
    reason: item.message,
  };
}

/**
 * Paths the manifest builder would attach that are not recorded on the ticket ledger.
 *
 * @param {object} params
 * @returns {{ ticket: string, paths: string[], reason: string }[]}
 */
function missingContextOnLedger({
  scope,
  tickets,
  exists,
  listFiles,
  sizes,
  profileContext,
}) {
  const active = activeOf(tickets);
  const gaps = [];
  for (const t of active) {
    if (t.type === 'human') continue;
    const reqText = (Array.isArray(t.scopeRefs) ? t.scopeRefs : [])
      .map((id) => requirementText(scope, id))
      .filter(Boolean)
      .flatMap((r) => [r.text, ...(r.acceptance || [])])
      .join('\n');
    const built = buildTicketContext({
      ticket: { ...t, requirements: reqText },
      scope,
      exists,
      sizes,
      profileContext,
      listFiles,
      allTickets: active,
    });
    const declared = new Set([...(t.context || []), ...(t.contracts || [])].map(norm));
    const outputs = new Set([...(t.files || []), ...(t.tests || [])].map(norm));
    const sharedAuto = new Set(built.shared.map(norm));
    const expected = new Set(
      [...built.context, ...supplementalDbContextPaths(t, reqText, exists, listFiles)]
        .map(norm)
        .filter((p) => exists(p) && !outputs.has(p) && !sharedAuto.has(p)),
    );
    const missing = [...expected].filter((p) => !declared.has(p)).sort();
    if (!missing.length) continue;
    gaps.push({
      ticket: t.id,
      paths: missing,
      reason: `${t.id} is missing ${missing.length} context path(s) workers need: ${listOf(missing)}.`,
    });
  }
  return gaps;
}

/**
 * Each repo path may be written by at most one active ticket (files, deletes, or test ownership).
 *
 * @param {object[]} active
 * @returns {{ file: string, tickets: string[] }[]}
 */
function duplicateFileOwners(active) {
  const owners = new Map();
  const claim = (file, id) => {
    if (!file || file.endsWith('/')) return;
    const f = norm(file);
    if (!owners.has(f)) owners.set(f, []);
    owners.get(f).push(id);
  };
  for (const t of active) {
    for (const f of [...(t.files || []), ...(t.deletes || [])]) claim(f, t.id);
    if (t.type === 'test') for (const f of t.tests || []) claim(f, t.id);
  }
  return [...owners].filter(([, ids]) => ids.length > 1).map(([file, tickets]) => ({ file, tickets: [...new Set(tickets)].sort() }));
}

/**
 * Scope-time gate for the Ticket Manager: ready pool (R-036 AC1), ownership, context on the ledger, and gating chains.
 *
 * @param {{
 *   scope?: object,
 *   tickets?: object[],
 *   exists?: (path: string) => boolean,
 *   listFiles?: (dir: string) => string[]|undefined,
 *   sizes?: Record<string, number>,
 *   profileContext?: Record<string, string[]>,
 *   sizeBudget?: object,
 * }} [params]
 * @returns {{ ok: boolean, findings: object[], tree: ReturnType<typeof checkTicketTree>, readyPool: ReturnType<typeof checkReadyPool> }}
 */
export function checkTicketManagerScopeIntegrity({
  scope,
  tickets = [],
  exists = () => false,
  listFiles,
  sizes = {},
  profileContext = {},
  sizeBudget,
} = {}) {
  const findings = [];
  const tree = checkTicketTree({ scope, tickets, sizeBudget });
  const readyPool = checkReadyPool({ tickets });

  for (const err of tree.errors) findings.push(treeItemToFinding(err, 'error'));
  for (const warn of tree.warnings) {
    if (warn.code === 'waves-unavailable') continue;
    findings.push(treeItemToFinding(warn, 'warning'));
  }

  for (const { file, tickets: ids } of duplicateFileOwners(activeOf(tickets))) {
    findings.push({
      code: 'duplicate-file-owner',
      severity: 'needs_you',
      action: 'change-scope-tickets',
      ticket: ids[0],
      reason: `${ids.length} tickets claim ${file}: ${ids.join(', ')}.`,
      recommendation: 'Give the file to one ticket and make the other depend on it.',
    });
  }

  for (const gap of missingContextOnLedger({ scope, tickets, exists, listFiles, sizes, profileContext })) {
    findings.push({
      code: 'missing-context',
      severity: 'warn',
      action: 'add-context',
      ticket: gap.ticket,
      reason: gap.reason,
      recommendation: `Add to context: ${gap.paths.slice(0, 8).join(', ')}${gap.paths.length > 8 ? '…' : ''}.`,
      paths: gap.paths,
    });
  }

  if (readyPool.active && !readyPool.ok) {
    const need = readyPool.shortfall;
    findings.push({
      code: 'ready-pool-shortfall',
      severity: 'warn',
      action: 'move-to-checklist',
      reason:
        `Active project has ${readyPool.readyCount} ready ticket(s) (Ticket Manager keeps at least ${READY_POOL_MIN}); ` +
        `${need} more needed and ${readyPool.promotable} can move to ready by unlocking dependencies or releasing todo tickets.`,
      recommendation:
        'Promote todo and dependency-unblocked tickets to ready until the pool reaches five, or split scope so more work can run in parallel.',
    });
  }

  const blocking = findings.some((f) => f.severity === 'needs_you');
  const ok = tree.ok && readyPool.ok && !blocking;
  return { ok, findings, tree, readyPool };
}
