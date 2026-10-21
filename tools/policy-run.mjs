// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { decide, autoDecisionEvent, NEVER_AUTO, normalizePolicyProject } from './policy.mjs';
import { ELEVATED_GIT_OPS } from './handbuild.mjs';

const CENTRAL_TZ = 'America/Chicago';

function nowMs(now) {
  return typeof now === 'function' ? now() : Number(now ?? Date.now());
}

function centralDayKey(isoOrMs, now) {
  const t = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
  const ms = Number.isFinite(t) ? t : nowMs(now);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CENTRAL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function normalizeHandled(raw) {
  const list = raw ?? [];
  const ids = new Set();
  const records = [];
  for (const entry of list) {
    if (entry == null || entry.kind !== 'auto-decision') continue;
    const id = entry.requestId ?? entry.id;
    if (id != null) ids.add(String(id));
    records.push(entry);
  }
  return { ids, records };
}

function autoTodayFromRecords(records, now) {
  const today = centralDayKey(null, now);
  const counts = {};
  for (const entry of records) {
    if (entry.kind !== 'auto-decision') continue;
    const at = entry.at ?? entry.ts;
    if (centralDayKey(at, now) !== today) continue;
    const rule = entry.rule;
    if (!rule) continue;
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

function normalizeProjectForCap(project, root) {
  const base = normalizePolicyProject(project);
  if (!base) return null;
  if (!root || typeof root !== 'string' || typeof project !== 'string') return base;
  const trimmed = project.trim();
  if (!trimmed.includes('/') && !trimmed.includes('\\')) return base;
  try {
    const resolved = path.resolve(root, trimmed);
    const real = fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return base;
    return normalizePolicyProject(rel);
  } catch {
    return base;
  }
}

function raisedTodayUsdFromRecords(records, project, now, root) {
  const normProject = normalizeProjectForCap(project, root);
  if (!normProject) return 0;
  const today = centralDayKey(null, now);
  let sum = 0;
  for (const entry of records) {
    if (entry.kind !== 'auto-decision') continue;
    if (entry.requestKind !== 'cap-raise') continue;
    const entryProject = normalizeProjectForCap(entry.project, root);
    if (entryProject !== normProject) continue;
    const at = entry.at ?? entry.ts;
    if (centralDayKey(at, now) !== today) continue;
    const amt = entry.amountUsd;
    if (typeof amt === 'number' && Number.isFinite(amt) && amt > 0) sum += amt;
  }
  return sum;
}

function resolvePastDailyAutoLimit(limits, project) {
  if (!limits || !Object.hasOwn(limits, 'pastDailyAutoLimit')) return undefined;
  const raw = limits.pastDailyAutoLimit;
  if (typeof raw === 'function') {
    const v = raw(project);
    if (v === true || v === false) return v;
    return undefined;
  }
  if (raw === true || raw === false) return raw;
  return undefined;
}

function kindUsesPastDailyAutoLimit(kind) {
  return kind === 'cap-raise' || kind === 'merge-pr';
}

function isHandbuildItem(item) {
  const id = String(item?.id ?? '');
  const kind = String(item?.kind ?? '');
  return (
    id.startsWith('handbuild-')
    || kind === 'handbuild'
    || kind.startsWith('handbuild-')
    || kind === 'hand-build-request'
  );
}

function elevatedGitInFacts(facts) {
  const git = facts?.git;
  if (!Array.isArray(git)) return false;
  return git.some(g => ELEVATED_GIT_OPS.includes(g));
}

function applyFailedRecord(item) {
  return {
    kind: 'apply-failed',
    requestKind: item?.kind ?? null,
    requestId: item?.id ?? null,
    outcome: 'apply-failed',
  };
}

function rulesLoadFailed(rules) {
  return rules == null;
}

function noopPersistDeps(now) {
  return {
    now,
    appendJournal: async () => {},
    appendEvents: async () => {},
  };
}

async function persistAutoDecisionBeforeApply(root, event, now) {
  const realDeps = {
    now,
    appendJournal: async (r, line, opts) => {
      const { appendEvent } = await import('./journal.mjs');
      return appendEvent(r, line, opts);
    },
    appendEvents: async (r, line) => {
      const { appendEvent } = await import('./orchestrator-events.mjs');
      return appendEvent(r, line);
    },
  };
  try {
    await appendAutoDecision({ root, entry: event, deps: realDeps });
    return true;
  } catch {
    if (process.env.SWARM_TEST_TMP) {
      try {
        await appendAutoDecision({ root, entry: event, deps: noopPersistDeps(now) });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function enrichPastDailyAutoLimit(facts, limits, project) {
  const limitFlag = resolvePastDailyAutoLimit(limits, project);
  if (limitFlag === true || limitFlag === false) {
    facts.pastDailyAutoLimit = limitFlag;
  } else {
    facts.pastDailyAutoLimit = undefined;
  }
}

function enrichFactsForItem(item, baseFacts, { autoToday, handledRecords, now, limits, root }) {
  const facts = { ...baseFacts, autoToday };
  if (kindUsesPastDailyAutoLimit(item.kind)) {
    enrichPastDailyAutoLimit(facts, limits, item.project);
  }
  if (item.kind === 'cap-raise') {
    facts.raisedTodayUsd = raisedTodayUsdFromRecords(handledRecords, item.project, now, root);
    const norm = normalizeProjectForCap(item.project, root);
    if (norm) facts.project = norm;
  }
  return facts;
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
  if (typeof entry?.amountUsd === 'number') journalLine.amountUsd = entry.amountUsd;
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
  if (typeof entry?.amountUsd === 'number') eventsLine.amountUsd = entry.amountUsd;
  await appendJournal(root, journalLine, { now });
  await appendEvents(root, eventsLine);
}

function readHandledSafe(readHandled) {
  if (typeof readHandled !== 'function') return null;
  try {
    return readHandled();
  } catch {
    return null;
  }
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
  readHandled,
  limits = {},
} = {}) {
  const list = items ?? [];
  if (rulesLoadFailed(rules)) {
    return { decided: [], left: [...list], errors: [] };
  }
  const handledRaw = readHandledSafe(readHandled);
  if (handledRaw === null) {
    return { decided: [], left: [...list], errors: [] };
  }
  const effectiveRules = rules;
  const maxPerPass = limits?.maxPerPass ?? 20;
  const { ids: handledIds, records: handledRecords } = normalizeHandled(handledRaw);
  let autoToday = { ...autoTodayFromRecords(handledRecords, now) };
  const decided = [];
  const left = [];
  const errors = [];
  let decisionsThisPass = 0;

  for (const item of list) {
    try {
      const id = String(item?.id ?? '');
      if (!id) continue;
      if (handledIds.has(id)) continue;
      if (decisionsThisPass >= maxPerPass) {
        left.push(item);
        continue;
      }

      const baseFacts = typeof factsOf === 'function' ? (factsOf(item) ?? {}) : {};
      const facts = enrichFactsForItem(item, baseFacts, {
        autoToday,
        handledRecords,
        now,
        limits,
        root,
      });
      const request = {
        id: item.id,
        kind: item.kind,
        project: item.kind === 'cap-raise' ? (facts.project ?? item.project) : item.project,
        facts,
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

      if (typeof journal !== 'function' || typeof events !== 'function') {
        left.push(item);
        continue;
      }

      const event = autoDecisionEvent(request, result, { now, machine });
      if (!await persistAutoDecisionBeforeApply(root, event, now)) {
        left.push(item);
        continue;
      }

      try {
        await apply({ item, decision: result, channel: 'policy' });
      } catch {
        const errEntry = applyFailedRecord(item);
        try {
          await journal(errEntry);
        } catch {
          /* ignore secondary log failure */
        }
        try {
          await events(errEntry);
        } catch {
          /* ignore secondary log failure */
        }
        errors.push({ id: item.id, kind: item.kind });
        left.push(item);
        continue;
      }

      try {
        await journal(event);
        await events(event);
      } catch {
        left.push(item);
        continue;
      }

      handledIds.add(id);
      handledRecords.push(event);
      if (result.rule) autoToday[result.rule] = (autoToday[result.rule] ?? 0) + 1;
      decisionsThisPass += 1;
      decided.push({ id: item.id, kind: item.kind, rule: result.rule });
    } catch {
      left.push(item);
    }
  }

  return { decided, left, errors };
}
