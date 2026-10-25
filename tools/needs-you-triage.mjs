// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  integrateBlockerKindFromId,
  integrateBlockerRunIdFromId,
  openItems,
  sanitizeText,
} from './journal.mjs';
import { collectInbox, openDecisions } from './inbox.mjs';
import { inboxDeps } from './inbox-commands.mjs';

export const MAX_TRIAGE_ATTEMPTS = 3;
export const REOPEN_SUPPRESS_MS = 60 * 60 * 1000;
const STATE_REL = path.join('.swarm', 'needs-you-triage', 'state.json');

const OWNER_MONEY = /\b(spend cap|maxusd|paid service|purchase|raise maxusd)\b/i;
const OWNER_DEPLOY = /\b(live deploy|production merge|deploy to production|merge to (?:main|master))\b/i;
const OWNER_LOGIN = /\b(expired login|expired key|api key|subscription|payment|billing|credential)\b/i;
const DECISION_PREFIX = 'Decision needed:';

export function triageStatePath(root) {
  return path.join(root, STATE_REL);
}

export function inboxItemSubtype(item) {
  const id = String(item?.id ?? '');
  if (id.startsWith('split-park-')) return 'split-park';
  const integrateKind = integrateBlockerKindFromId(id);
  if (integrateKind) return integrateKind;
  if (id.startsWith('ci-failure')) return 'ci-failure';
  if (item?.kind === 'decision') return 'decision';
  if (item?.triageKind) return String(item.triageKind);
  return 'generic';
}

export function buildOwnerDecisionText(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'decision') {
    const line = sanitizeText(item.text ?? item.title ?? String(item.id ?? 'decision'));
    const choices = Array.isArray(item.choices) ? item.choices.map(String) : [];
    const opts = choices.length ? choices.join(', ') : String(item.default ?? 'yes, no');
    return `${DECISION_PREFIX} ${line} Options: ${opts}. Why only you: this choice was created with swarm decision and only the owner can confirm it.`;
  }
  const title = sanitizeText(item.title ?? item.text ?? String(item.id ?? ''));
  const id = String(item.id ?? '');
  if (id.startsWith('cap-') || OWNER_MONEY.test(title)) {
    return `${DECISION_PREFIX} Run is paused on a spend cap Options: raise maxUsd with a reason, keep paused. Why only you: spending limits and purchases need the owner.`;
  }
  if (OWNER_DEPLOY.test(title)) {
    return `${DECISION_PREFIX} ${title} Options: proceed with deploy, wait. Why only you: live deploys and production merges need the owner.`;
  }
  if (OWNER_LOGIN.test(title) || (item.kind === 'human' && OWNER_LOGIN.test(`${title} ${(item.steps ?? []).join(' ')}`))) {
    return `${DECISION_PREFIX} ${title} Options: refresh login or key, defer. Why only you: credentials, billing, and subscriptions are owner-only.`;
  }
  if (/\bbilling\b/i.test(title)) {
    return `${DECISION_PREFIX} ${title} Options: fix billing, cancel. Why only you: billing problems need the owner.`;
  }
  return null;
}

export function classifyInboxItem(item) {
  if (!item || typeof item !== 'object') return 'fixable';
  if (item.kind === 'decision') {
    return buildOwnerDecisionText(item) ? 'owner' : 'fixable';
  }
  const subtype = inboxItemSubtype(item);
  if (['split-park', 'integrate', 'integrate-checkout', 'ci-failure'].includes(subtype)) return 'fixable';
  const blob = `${item.title ?? ''} ${item.text ?? ''} ${(item.steps ?? []).join(' ')}`;
  if (item.kind === 'blocker' || item.kind === 'human') {
    const id = String(item.id ?? '');
    if (id.startsWith('cap-') || OWNER_MONEY.test(blob)) {
      return buildOwnerDecisionText(item) ? 'owner' : 'fixable';
    }
    if (OWNER_DEPLOY.test(blob)) return buildOwnerDecisionText(item) ? 'owner' : 'fixable';
    if (OWNER_LOGIN.test(blob)) return buildOwnerDecisionText(item) ? 'owner' : 'fixable';
  }
  return 'fixable';
}

function itemStateKey(item) {
  return `${item.project ?? ''}:${item.kind}:${item.id}`;
}

function causeKey(item) {
  const subtype = inboxItemSubtype(item);
  const integrateRun = integrateBlockerRunIdFromId(String(item.id ?? ''));
  return `${item.project ?? ''}:${subtype}:${integrateRun ?? item.id}`;
}

function defaultState() {
  return { passCount: 0, items: {}, suppressReopen: {} };
}

export async function readTriageState(root) {
  const file = triageStatePath(root);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultState();
    return {
      passCount: Number(parsed.passCount) || 0,
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
      suppressReopen: parsed.suppressReopen && typeof parsed.suppressReopen === 'object' ? parsed.suppressReopen : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultState();
    return defaultState();
  }
}

export async function writeTriageState(root, state) {
  const file = triageStatePath(root);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    passCount: state.passCount ?? 0,
    items: state.items ?? {},
    suppressReopen: state.suppressReopen ?? {},
  };
  await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, file);
}

async function collectTriageItems(roots, triageDeps) {
  if (typeof triageDeps.collectInbox === 'function') return triageDeps.collectInbox(roots, triageDeps);
  if (typeof triageDeps.listRuns === 'function' && typeof triageDeps.readState === 'function') {
    const inbox = inboxDeps({ now: triageDeps.now, channel: 'agent' });
    return collectInbox(roots, { ...inbox, ...triageDeps });
  }
  const nowMs = typeof triageDeps.now === 'function' ? triageDeps.now() : Date.now();
  const items = [];
  for (const root of roots) {
    const events = await triageDeps.readJournal(root, { limit: Infinity });
    for (const event of openItems(events)) {
      const id = String(event.id);
      const since = event.ts ?? new Date(nowMs).toISOString();
      if (event.kind === 'human') {
        items.push({
          id,
          kind: 'human',
          project: root,
          title: sanitizeText(event.title ?? event.text ?? id),
          steps: Array.isArray(event.steps) ? event.steps.map(step => sanitizeText(step)) : [],
          unblocks: Number.isFinite(event.unblocks) ? event.unblocks : 0,
          since,
        });
      } else if (event.kind === 'blocker') {
        items.push({
          id,
          kind: 'blocker',
          project: root,
          title: sanitizeText(event.text ?? event.title ?? id),
          text: sanitizeText(event.text ?? ''),
          integrateCause: event.integrateCause,
          unblocks: 0,
          since,
        });
      }
    }
    for (const event of openDecisions(events)) {
      const item = {
        id: String(event.id),
        kind: 'decision',
        project: root,
        title: sanitizeText(event.text ?? String(event.id)),
        text: sanitizeText(event.text ?? String(event.id)),
        unblocks: 0,
        since: event.ts ?? new Date(nowMs).toISOString(),
      };
      if (Array.isArray(event.options)) item.choices = event.options.map(option => String(option));
      if (event.choice !== undefined) item.default = String(event.choice);
      items.push(item);
    }
  }
  return items;
}

async function listProjectRoots(primaryRoot, deps) {
  if (typeof deps.listTriageRoots === 'function') return deps.listTriageRoots(primaryRoot);
  const roots = [primaryRoot];
  const installRoot = deps.installRoot;
  if (!installRoot) return roots;
  let registry = [];
  try {
    const value = JSON.parse(await fs.readFile(path.join(installRoot, '.swarm-projects.json'), 'utf8'));
    registry = Array.isArray(value) ? value : [];
  } catch { registry = []; }
  for (const entry of registry) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || roots.includes(entry)) continue;
    try {
      await fs.access(path.join(entry, '.swarm'));
      roots.push(entry);
    } catch { /* not a swarm project */ }
  }
  return roots;
}

async function resolveSwarmRoot(deps, primaryRoot) {
  if (typeof deps.swarmRoot === 'string' && deps.swarmRoot) return deps.swarmRoot;
  const installRoot = deps.installRoot;
  if (installRoot) {
    let registry = [];
    try {
      const value = JSON.parse(await fs.readFile(path.join(installRoot, '.swarm-projects.json'), 'utf8'));
      registry = Array.isArray(value) ? value : [];
    } catch { registry = []; }
    for (const entry of registry) {
      if (typeof entry !== 'string') continue;
      const name = path.basename(entry);
      if (name === 'project-swarm' || entry.endsWith(`${path.sep}project-swarm`)) return entry;
    }
  }
  if (primaryRoot && path.basename(primaryRoot) === 'project-swarm') return primaryRoot;
  return null;
}

function attemptCount(state, key) {
  const entry = state.items[key];
  return Array.isArray(entry?.attempts) ? entry.attempts.length : 0;
}

function canRetryThisPass(state, key, passCount) {
  const entry = state.items[key];
  if (!entry?.lastFailedPass) return true;
  return entry.lastFailedPass < passCount;
}

function recordAttempt(state, key, passCount, error) {
  const prev = state.items[key] ?? { attempts: [] };
  const attempts = [...(prev.attempts ?? []), { pass: passCount, error: sanitizeText(String(error ?? 'failed')).slice(0, 500) }];
  state.items[key] = { ...prev, attempts, lastFailedPass: passCount };
}

function recordSuppress(state, item, nowMs) {
  const key = causeKey(item);
  state.suppressReopen[key] = nowMs + REOPEN_SUPPRESS_MS;
}

function isReopenSuppressed(state, item, nowMs) {
  const until = state.suppressReopen[causeKey(item)];
  return Number.isFinite(until) && until > nowMs;
}

async function closeItem(projectRoot, item, deps, { note } = {}) {
  const append = deps.appendEvent;
  const now = deps.now;
  if (typeof append !== 'function') throw new Error('triage-missing-append');
  const text = sanitizeText(item.title ?? item.text ?? String(item.id ?? ''));
  if (item.kind === 'blocker') {
    const integrateKind = integrateBlockerKindFromId(String(item.id ?? ''));
    const integrateRun = integrateBlockerRunIdFromId(String(item.id ?? ''));
    const payload = {
      kind: 'blocker',
      id: item.id,
      resolved: true,
      text,
      triageClosed: true,
      ...(note ? { triageNote: sanitizeText(note) } : {}),
    };
    if (integrateKind && integrateRun) {
      payload.integrateKind = integrateKind;
      payload.integrateRun = integrateRun;
      payload.integrateCause = sanitizeText(item.integrateCause ?? text);
    }
    await append(projectRoot, payload, { now });
    return;
  }
  if (item.kind === 'human') {
    if (typeof deps.markDone === 'function' && String(item.id ?? '').includes(':')) {
      await deps.markDone(projectRoot, item.id, deps);
      return;
    }
    await append(projectRoot, { kind: 'human', id: item.id, done: true, ...(note ? { triageNote: sanitizeText(note) } : {}) }, { now });
    return;
  }
}

async function ensureOwnerCard(_projectRoot, item, _deps) {
  const decision = buildOwnerDecisionText(item);
  if (!decision) return { updated: false };
  const title = sanitizeText(item.title ?? item.text ?? '');
  if (title.startsWith(DECISION_PREFIX)) return { updated: false, decision: title };
  return { updated: false, decision };
}

async function defaultHandler(projectRoot, item, deps, handlers) {
  const kind = inboxItemSubtype(item);
  const fn = handlers[kind] ?? handlers.generic;
  if (typeof fn !== 'function') throw new Error(`triage-no-handler: ${kind}`);
  return fn({ root: projectRoot, item, deps, kind });
}

async function openSwarmFixGoal({ projectRoot, item, state, key, deps, nowMs }) {
  const entry = state.items[key] ?? { attempts: [] };
  const attempts = entry.attempts ?? [];
  const lastError = attempts.length ? attempts[attempts.length - 1].error : 'unknown';
  const title = `needs-you triage failed after ${MAX_TRIAGE_ATTEMPTS} tries`;
  const detail = `item=${item.id} project=${projectRoot} last=${lastError} attempts=${JSON.stringify(attempts)}`;
  const goalText = `SWARM-FIX: ${title} — ${detail}`;
  const swarmRoot = await resolveSwarmRoot(deps, projectRoot);
  const goalRoot = swarmRoot ?? projectRoot;
  const prefixed = swarmRoot ? goalText : `SWARM-FIX: ${goalText}`;
  let goalId = null;
  if (typeof deps.addGoal === 'function') {
    const out = await deps.addGoal(goalRoot, { goal: prefixed, paths: ['tools/needs-you-triage.mjs', 'tools/autopilot.mjs'] }, { now: deps.now });
    goalId = out?.id ?? null;
  }
  const note = goalId ? `autopilot triage opened swarm-fix goal ${goalId} in ${goalRoot}` : `autopilot triage opened swarm-fix backlog goal in ${goalRoot}`;
  return { note, goalId, goalRoot };
}

/**
 * One needs-you triage pass for the primary project and any registry projects.
 * Injectable handlers and inbox deps; never raises caps, merges live, or touches credentials.
 */
export async function runNeedsYouTriagePass(primaryRoot, deps, { now = Date.now } = {}) {
  const nowFn = typeof now === 'function' ? now : () => Number(now);
  const nowMs = nowFn();
  const triageDeps = {
    now,
    installRoot: deps.installRoot ?? null,
    appendEvent: deps.appendEvent,
    readJournal: deps.readJournal,
    addGoal: deps.addGoal,
    markDone: deps.markDone,
    collectInbox: deps.collectInbox,
    listTriageRoots: deps.listTriageRoots,
    swarmRoot: deps.swarmRoot,
    ...(deps.needsYouTriage ?? {}),
  };
  const handlers = { ...(triageDeps.handlers ?? {}) };
  const roots = await listProjectRoots(primaryRoot, triageDeps);
  const state = await readTriageState(primaryRoot);
  state.passCount = (state.passCount ?? 0) + 1;
  const passCount = state.passCount;

  const items = await collectTriageItems(roots, triageDeps);
  const results = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id) continue;
    const projectRoot = item.project ?? primaryRoot;
    const key = itemStateKey(item);

    if (state.items[key]?.exhausted) {
      if (isReopenSuppressed(state, item, nowMs)) {
        const note = 'suppressed reopen within one hour for the same cause';
        await closeItem(projectRoot, item, triageDeps, { note });
        results.push({ id: item.id, project: projectRoot, action: 'suppressed-reopen', note });
      }
      continue;
    }

    if (isReopenSuppressed(state, item, nowMs)) {
      const note = 'suppressed reopen within one hour for the same cause';
      await closeItem(projectRoot, item, triageDeps, { note });
      results.push({ id: item.id, project: projectRoot, action: 'suppressed-reopen', note });
      continue;
    }

    const bucket = classifyInboxItem(item);
    if (bucket === 'owner') {
      const owner = await ensureOwnerCard(projectRoot, item, triageDeps);
      results.push({ id: item.id, project: projectRoot, action: 'owner', decision: owner.decision ?? buildOwnerDecisionText(item) });
      continue;
    }

    if (!canRetryThisPass(state, key, passCount)) {
      results.push({ id: item.id, project: projectRoot, action: 'wait-pass' });
      continue;
    }

    const tries = attemptCount(state, key);
    if (tries >= MAX_TRIAGE_ATTEMPTS) {
      const fix = await openSwarmFixGoal({ projectRoot, item, state, key, deps: triageDeps, nowMs });
      await closeItem(projectRoot, item, triageDeps, { note: fix.note });
      recordSuppress(state, item, nowMs);
      state.items[key] = { ...(state.items[key] ?? {}), exhausted: true };
      results.push({ id: item.id, project: projectRoot, action: 'swarm-fix', ...fix });
      continue;
    }

    let ok = false;
    let error = null;
    try {
      const out = await defaultHandler(projectRoot, item, triageDeps, handlers);
      ok = out?.ok !== false;
      if (!ok) error = out?.error ?? 'handler returned not ok';
    } catch (err) {
      ok = false;
      error = String(err?.message ?? err);
    }

    if (ok) {
      const note = 'autopilot triage fixed and closed';
      await closeItem(projectRoot, item, triageDeps, { note });
      recordSuppress(state, item, nowMs);
      delete state.items[key];
      results.push({ id: item.id, project: projectRoot, action: 'closed', note });
      continue;
    }

    recordAttempt(state, key, passCount, error);
    const after = attemptCount(state, key);
    if (after >= MAX_TRIAGE_ATTEMPTS) {
      const fix = await openSwarmFixGoal({ projectRoot, item, state, key, deps: triageDeps, nowMs });
      await closeItem(projectRoot, item, triageDeps, { note: fix.note });
      recordSuppress(state, item, nowMs);
      state.items[key] = { ...(state.items[key] ?? {}), exhausted: true };
      results.push({ id: item.id, project: projectRoot, action: 'swarm-fix', ...fix });
    } else {
      results.push({ id: item.id, project: projectRoot, action: 'retry', attempt: after, error });
    }
  }

  await writeTriageState(primaryRoot, state);
  return { passCount, results };
}
