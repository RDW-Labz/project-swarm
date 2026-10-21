// SPDX-License-Identifier: Apache-2.0
import { decide, autoDecisionEvent, NEVER_AUTO } from './policy.mjs';
import { ELEVATED_GIT_OPS } from './handbuild.mjs';

function nowMs(now) {
  return typeof now === 'function' ? now() : Number(now ?? Date.now());
}

function dayKey(isoOrMs, now) {
  const t = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
  const ms = Number.isFinite(t) ? t : nowMs(now);
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeHandled(raw) {
  const list = raw ?? [];
  const ids = new Set();
  const records = [];
  for (const entry of list) {
    if (entry == null) continue;
    if (typeof entry === 'string') {
      ids.add(entry);
      continue;
    }
    if (typeof entry === 'object') {
      const id = entry.requestId ?? entry.id;
      if (id != null) ids.add(String(id));
      if (entry.kind === 'auto-decision' || entry.rule != null) records.push(entry);
    }
  }
  return { ids, records };
}

function autoTodayFromRecords(records, now) {
  const today = dayKey(null, now);
  const counts = {};
  for (const entry of records) {
    if (entry.kind && entry.kind !== 'auto-decision') continue;
    const at = entry.at ?? entry.ts;
    if (dayKey(at, now) !== today) continue;
    const rule = entry.rule;
    if (!rule) continue;
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

function isHandbuildItem(item) {
  const id = String(item?.id ?? '');
  const kind = String(item?.kind ?? '');
  return id.startsWith('handbuild-') || kind === 'handbuild' || kind.startsWith('handbuild-');
}

function elevatedGitInFacts(facts) {
  const git = facts?.git;
  if (!Array.isArray(git)) return false;
  return git.some(g => ELEVATED_GIT_OPS.includes(g));
}

function policyErrorRecord(item) {
  return { kind: 'policy-error', requestKind: item?.kind ?? null, requestId: item?.id ?? null };
}

function rulesLoadFailed(rules) {
  return rules == null;
}

export async function appendAutoDecision({ root, entry, deps = {} }) {
  const appendJournal = deps.appendJournal ?? (async (r, ev, opts) => {
    const { appendEvent } = await import('./journal.mjs');
    return appendEvent(r, ev, opts);
  });
  const appendEvents = deps.appendEvents ?? (async (r, ev) => {
    const { appendEvent } = await import('./orchestrator-events.mjs');
    return appendEvent(r, ev);
  });
  const now = deps.now ?? Date.now;
  const at = entry?.at ?? new Date(nowMs(now)).toISOString();
  const journalLine = {
    ts: at,
    kind: 'auto-decision',
    rule: entry?.rule ?? null,
    requestKind: entry?.requestKind ?? null,
    requestId: entry?.requestId ?? null,
    project: entry?.project ?? null,
    machine: entry?.machine ?? '',
    reason: entry?.reason ?? null,
  };
  const eventsLine = {
    at,
    kind: 'auto-decision',
    rule: journalLine.rule,
    requestKind: journalLine.requestKind,
    requestId: journalLine.requestId,
    project: journalLine.project,
    machine: journalLine.machine,
    reason: journalLine.reason,
  };
  await appendJournal(root, journalLine, { now });
  await appendEvents(root, eventsLine);
}

export async function runPolicyPass({
  root,
  items,
  rules,
  factsOf,
  apply,
  journal,
  events,
  now = Date.now,
  machine = '',
  readHandled = () => [],
  limits = {},
} = {}) {
  const list = items ?? [];
  if (rulesLoadFailed(rules)) {
    return { decided: [], left: [...list], errors: [] };
  }
  const effectiveRules = rules;
  const maxPerPass = limits?.maxPerPass ?? 20;
  const { ids: handledIds, records: handledRecords } = normalizeHandled(readHandled());
  let autoToday = { ...autoTodayFromRecords(handledRecords, now) };
  const decided = [];
  const left = [];
  const errors = [];
  let decisionsThisPass = 0;

  for (const item of list) {
    const id = String(item?.id ?? '');
    if (!id) continue;
    if (handledIds.has(id)) continue;
    if (decisionsThisPass >= maxPerPass) {
      left.push(item);
      continue;
    }

    const baseFacts = typeof factsOf === 'function' ? (factsOf(item) ?? {}) : {};
    const request = {
      id: item.id,
      kind: item.kind,
      project: item.project,
      facts: { ...baseFacts, autoToday },
    };
    const result = decide(request, { rules: effectiveRules, now });

    if (result.decision !== 'auto-approve') {
      left.push(item);
      continue;
    }

    if (NEVER_AUTO.includes(item.kind)) {
      left.push(item);
      continue;
    }
    if (isHandbuildItem(item) && elevatedGitInFacts(baseFacts)) {
      left.push(item);
      continue;
    }

    try {
      await apply({ item, decision: result, channel: 'policy' });
    } catch {
      const errEntry = policyErrorRecord(item);
      if (typeof journal === 'function') await journal(errEntry);
      if (typeof events === 'function') await events(errEntry);
      errors.push({ id: item.id, kind: item.kind });
      left.push(item);
      continue;
    }

    const event = autoDecisionEvent(request, result, { now, machine });
    if (typeof journal === 'function') await journal(event);
    if (typeof events === 'function') await events(event);

    handledIds.add(id);
    if (result.rule) autoToday[result.rule] = (autoToday[result.rule] ?? 0) + 1;
    decisionsThisPass += 1;
    decided.push({ id: item.id, kind: item.kind, rule: result.rule });
  }

  return { decided, left, errors };
}
