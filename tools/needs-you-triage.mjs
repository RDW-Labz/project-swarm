// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import path from 'node:path';
import {
  integrateBlockerKindFromId,
  integrateBlockerResolutionEvent,
  integrateBlockerRunIdFromId,
  openItems,
  sanitizeText,
} from './journal.mjs';
import { collectInbox, openDecisions } from './inbox.mjs';
import { inboxDeps } from './inbox-commands.mjs';

export const MAX_TRIAGE_ATTEMPTS = 3;
export const REOPEN_SUPPRESS_MS = 60 * 60 * 1000;
const STATE_REL = path.join('.swarm', 'needs-you-triage', 'state.json');
const LOCK_REL = path.join('.swarm', 'needs-you-triage', 'state.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

export const TRIAGE_HANDLER_KINDS = Object.freeze([
  'split-park',
  'integrate',
  'integrate-checkout',
]);

export const RISKY_WORD_FRAGMENTS = Object.freeze([
  'spend', 'cap', 'budget', 'billing', 'bill', 'payment', 'invoice', 'price', 'cost', 'money',
  'dollar', 'key', 'token', 'secret', 'credential', 'password', 'login', 'auth', 'permission',
  'deploy', 'production', 'prod', 'live site', 'merge to main', 'release', 'subscription',
  'quota', 'security', 'scan', 'leak',
]);

const FIXABLE_SUBTYPES = new Set(TRIAGE_HANDLER_KINDS);

const OWNER_MONEY = /\b(spend cap|maxusd|paid service|purchase|raise maxusd)\b/i;
const OWNER_DEPLOY = /\b(live deploy|production merge|deploy to production|merge to (?:main|master))\b/i;
const OWNER_LOGIN = /\b(expired login|expired key|api key|subscription|payment|billing|credential)\b/i;
const DECISION_PREFIX = 'Decision needed:';

export function triageStatePath(root) {
  return path.join(root, STATE_REL);
}

export function triageLockPath(root) {
  return path.join(root, LOCK_REL);
}

export function itemTextBlob(item) {
  if (!item || typeof item !== 'object') return '';
  return `${item.title ?? ''} ${item.text ?? ''} ${(item.steps ?? []).join(' ')}`.trim();
}

export function hasRiskyWords(blob) {
  const text = String(blob ?? '').toLowerCase();
  if (!text) return false;
  return RISKY_WORD_FRAGMENTS.some(fragment => text.includes(fragment.toLowerCase()));
}

export function ciFailureKnownTestCause(item) {
  if (!item || typeof item !== 'object') return false;
  const id = String(item.id ?? '');
  if (!id.startsWith('ci-failure')) return false;
  const blob = itemTextBlob(item);
  if (/\b(security scan|secrets? scan|credential scan)\b/i.test(blob)) return false;
  if (item.knownTestFailure === true) return true;
  if (item.testFile || item.failedTest) return true;
  if (item.hook != null || item.batch != null) return true;
  const cause = String(item.ciCause ?? item.cause ?? item.integrateCause ?? '');
  if (/test[- ]?fail/i.test(cause) || cause === 'test-failure') return true;
  if (/^ci-failure-batch-/i.test(id)) return true;
  if (item.ticket) return true;
  return false;
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

const CHECKOUT_OWNER_INTEGRATE_CAUSE = /\b(the checkout is on (?:main|master)|uncommitted tracked changes|a merge is in progress|a rebase is in progress|a cherry-pick is in progress)\b/i;

export function integrateCheckoutCauseNeedsOwner(cause) {
  const text = String(cause ?? '');
  if (!text) return false;
  return CHECKOUT_OWNER_INTEGRATE_CAUSE.test(text);
}

export function buildIntegrateCheckoutOwnerDecisionText(item) {
  if (!item || typeof item !== 'object') return null;
  const cause = sanitizeText(item.integrateCause ?? item.text ?? item.title ?? '');
  if (!integrateCheckoutCauseNeedsOwner(cause)) return null;
  if (/\bthe checkout is on (?:main|master)\b/i.test(cause)) {
    return `${DECISION_PREFIX} Checkout is on main or master before integrate Options: move work to a swarm/* branch or linked worktree, then integrate. Why only you: integrating on main or master is never automatic.`;
  }
  if (/\buncommitted tracked changes\b/i.test(cause)) {
    return `${DECISION_PREFIX} Uncommitted tracked changes block integrate Options: commit the changes, stash or move them to another branch, or discard what you do not need. Why only you: autopilot will not commit or discard your local edits.`;
  }
  if (/\ba merge is in progress\b/i.test(cause)) {
    return `${DECISION_PREFIX} A merge is in progress in the checkout Options: finish or abort the merge, then integrate. Why only you: resolving an in-progress merge needs the owner.`;
  }
  if (/\ba rebase is in progress\b/i.test(cause)) {
    return `${DECISION_PREFIX} A rebase is in progress in the checkout Options: finish or abort the rebase, then integrate. Why only you: resolving an in-progress rebase needs the owner.`;
  }
  if (/\ba cherry-pick is in progress\b/i.test(cause)) {
    return `${DECISION_PREFIX} A cherry-pick is in progress in the checkout Options: finish or abort the cherry-pick, then integrate. Why only you: resolving an in-progress cherry-pick needs the owner.`;
  }
  return `${DECISION_PREFIX} Checkout must be cleaned up before integrate Options: fix the git state described in the blocker, then integrate. Why only you: this checkout state needs the owner.`;
}

export function classifyInboxItem(item) {
  if (!item || typeof item !== 'object') return 'owner';
  if (item.kind !== 'blocker') return 'owner';
  const blob = itemTextBlob(item);
  if (!blob) return 'owner';
  if (hasRiskyWords(blob)) return 'owner';
  const subtype = inboxItemSubtype(item);
  if (!FIXABLE_SUBTYPES.has(subtype)) return 'owner';
  if (subtype === 'integrate-checkout') {
    const cause = item.integrateCause ?? blob;
    if (integrateCheckoutCauseNeedsOwner(cause)) return 'owner';
  }
  const id = String(item.id ?? '');
  if (id.startsWith('cap-') || OWNER_MONEY.test(blob)) {
    return buildOwnerDecisionText(item) ? 'owner' : 'owner';
  }
  if (OWNER_DEPLOY.test(blob)) return 'owner';
  if (OWNER_LOGIN.test(blob)) return 'owner';
  return 'fixable';
}

export function buildHandlersMap(rawHandlers) {
  const handlers = Object.create(null);
  const source = rawHandlers && typeof rawHandlers === 'object' ? rawHandlers : {};
  for (const kind of TRIAGE_HANDLER_KINDS) {
    if (Object.hasOwn(source, kind) && typeof source[kind] === 'function') {
      handlers[kind] = source[kind];
    }
  }
  return handlers;
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

function shortProjectLabel(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) return 'project';
  const base = path.basename(projectRoot);
  if (base && base !== '.' && base !== '/') return base;
  const hash = Buffer.from(projectRoot).toString('hex').slice(0, 8);
  return hash || 'project';
}

export async function readTriageState(root) {
  const file = triageStatePath(root);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('triage-state-corrupt');
    return {
      passCount: Number(parsed.passCount) || 0,
      items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
      suppressReopen: parsed.suppressReopen && typeof parsed.suppressReopen === 'object' ? parsed.suppressReopen : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultState();
    throw error;
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

export async function isPidAlive(pid, { isPidAlive: check } = {}) {
  const probe = typeof check === 'function' ? check : defaultIsPidAlive;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return probe(pid);
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function lockIsStale(existing, nowMs, isAlive) {
  const owner = Number(existing?.pid);
  const at = Number(existing?.at);
  const alive = await isAlive(owner);
  if (!alive) return true;
  if (!Number.isFinite(at)) return false;
  return nowMs - at > LOCK_STALE_MS && !alive;
}

async function readLockPayload(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    try { await fs.unlink(file); } catch { /* replace unreadable lock */ }
    return null;
  }
}

async function writeLockExclusive(file, payload) {
  const handle = await fsOpen(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(payload)}\n`, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

export async function refreshTriageLock(root, { now = Date.now } = {}) {
  const file = triageLockPath(root);
  const nowMs = typeof now === 'function' ? now() : Number(now);
  try {
    const existing = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number(existing?.pid) !== process.pid) return;
    await fs.writeFile(file, `${JSON.stringify({ pid: process.pid, at: nowMs })}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* no lock */ }
}

export async function acquireTriageLock(root, { now = Date.now, isPidAlive: pidCheck } = {}) {
  const file = triageLockPath(root);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const nowMs = typeof now === 'function' ? now() : Number(now);
  const alive = pid => isPidAlive(pid, { isPidAlive: pidCheck });

  const existing = await readLockPayload(file);
  if (existing) {
    const owner = Number(existing?.pid);
    const stale = await lockIsStale(existing, nowMs, alive);
    if (!stale && owner !== process.pid) return { ok: false, reason: 'locked' };
    if (stale) {
      try { await fs.unlink(file); } catch { /* raced */ }
    } else if (owner === process.pid) {
      await refreshTriageLock(root, { now: nowMs });
      return { ok: true };
    }
  }

  const payload = { pid: process.pid, at: nowMs };
  try {
    await writeLockExclusive(file, payload);
    return { ok: true };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const other = await readLockPayload(file);
    if (other && Number(other.pid) === process.pid) {
      await refreshTriageLock(root, { now: nowMs });
      return { ok: true };
    }
    const owner = Number(other?.pid);
    if (other && !(await lockIsStale(other, nowMs, alive)) && owner !== process.pid) {
      return { ok: false, reason: 'locked' };
    }
    try { await fs.unlink(file); } catch { /* ignore */ }
    try {
      await writeLockExclusive(file, payload);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'locked' };
    }
  }
}

export async function releaseTriageLock(root) {
  const file = triageLockPath(root);
  try {
    const existing = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number(existing?.pid) === process.pid) await fs.unlink(file);
  } catch { /* no lock */ }
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
    const integrateCause = sanitizeText(item.integrateCause ?? text);
    const prior = {
      id: item.id,
      text,
      integrateCause: item.integrateCause,
      integrateKind,
      integrateRun,
    };
    const payload = integrateKind && integrateRun
      ? {
        ...integrateBlockerResolutionEvent(prior, {
          integrateKind,
          integrateRun,
          integrateCause,
          resolvedBy: 'needs-you-triage',
        }),
        triageClosed: true,
        ...(note ? { triageNote: sanitizeText(note) } : {}),
      }
      : {
        kind: 'blocker',
        id: item.id,
        resolved: true,
        text,
        triageClosed: true,
        ...(note ? { triageNote: sanitizeText(note) } : {}),
      };
    await append(projectRoot, payload, { now });
    return;
  }
  if (item.kind === 'human') {
    await append(projectRoot, { kind: 'human', id: item.id, done: true, ...(note ? { triageNote: sanitizeText(note) } : {}) }, { now });
    return;
  }
}

async function ensureOwnerCard(_projectRoot, item, _deps) {
  const checkoutDecision = buildIntegrateCheckoutOwnerDecisionText(item);
  const decision = checkoutDecision ?? buildOwnerDecisionText(item);
  if (!decision) return { updated: false };
  const title = sanitizeText(item.title ?? item.text ?? '');
  if (title.startsWith(DECISION_PREFIX)) return { updated: false, decision: title };
  return { updated: false, decision };
}

async function invokeHandler(projectRoot, item, deps, handlers, kind) {
  if (!Object.hasOwn(handlers, kind)) return { skipped: true };
  const fn = handlers[kind];
  if (typeof fn !== 'function') return { skipped: true };
  return { out: await fn({ root: projectRoot, item, deps, kind }) };
}

function lastErrorLine(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return 'unknown';
  const raw = String(attempts[attempts.length - 1]?.error ?? 'unknown');
  const line = raw.split(/\r?\n/).filter(Boolean).pop() ?? raw;
  return sanitizeText(line).slice(0, 300);
}

function stripPathsForGoal(text) {
  let out = sanitizeText(String(text ?? ''));
  out = out.replace(/(?:[A-Za-z]:)?\/(?:[^\s:]{1,200})/g, '<path>');
  out = out.replace(/\b[\w./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|txt|yml|yaml)\b/gi, '<path>');
  out = out.replace(/\b[\w.-]*\/[\w./-]+\b/g, '<path>');
  return out.slice(0, 200);
}

async function openSwarmFixGoal({ projectRoot, item, state, key, deps, nowMs, log }) {
  const entry = state.items[key] ?? { attempts: [] };
  const attempts = entry.attempts ?? [];
  const tries = attempts.length;
  const lastError = stripPathsForGoal(lastErrorLine(attempts));
  const label = shortProjectLabel(projectRoot);
  const subtype = inboxItemSubtype(item);
  const goalText = sanitizeText(`SWARM-FIX: needs-you triage failed subtype=${subtype} project=${label} attempts=${tries} last=${lastError}`);
  const swarmRoot = await resolveSwarmRoot(deps, projectRoot);
  if (!swarmRoot) {
    const message = sanitizeText(`needs-you triage exhausted for ${label} (${item.id}); no project-swarm root found for swarm-fix goal`);
    if (typeof log === 'function') log(message);
    return { note: null, goalId: null, goalRoot: null, stuck: true };
  }
  let goalId = null;
  if (typeof deps.addGoal === 'function') {
    const out = await deps.addGoal(swarmRoot, { goal: goalText, paths: ['tools/needs-you-triage.mjs', 'tools/autopilot.mjs'] }, { now: deps.now });
    goalId = out?.id ?? null;
  }
  if (!goalId) {
    return { note: null, goalId: null, goalRoot: swarmRoot, stuck: true };
  }
  const note = sanitizeText(`autopilot triage opened swarm-fix goal ${goalId} in ${path.basename(swarmRoot)}`);
  return { note, goalId, goalRoot: swarmRoot, stuck: false };
}

/**
 * One needs-you triage pass for the primary project and any registry projects.
 * Injectable handlers and inbox deps; never raises caps, merges live, or touches credentials.
 */
export async function runNeedsYouTriagePass(primaryRoot, deps, { now, log } = {}) {
  const nowSource = now ?? deps?.now ?? Date.now;
  const nowFn = typeof nowSource === 'function' ? nowSource : () => Number(nowSource);
  const nowMs = nowFn();
  const lock = await acquireTriageLock(primaryRoot, { now: nowFn, isPidAlive: deps?.isPidAlive });
  if (lock?.ok !== true) {
    return { passCount: 0, results: [], skipped: lock?.reason ?? 'locked' };
  }
  try {
    let state;
    try {
      state = await readTriageState(primaryRoot);
    } catch {
      return { passCount: 0, results: [], error: 'state-unreadable' };
    }
    const triageDeps = {
      now: nowSource,
      installRoot: deps.installRoot ?? null,
      appendEvent: deps.appendEvent,
      readJournal: deps.readJournal,
      addGoal: deps.addGoal,
      markDone: deps.markDone,
      collectInbox: deps.collectInbox,
      listTriageRoots: deps.listTriageRoots,
      swarmRoot: deps.swarmRoot,
      integrate: deps.integrate,
      startScope: deps.startScope,
      checkout: deps.checkout,
      gitExecForIntegrate: deps.gitExecForIntegrate,
      integrateCheckoutGitState: deps.integrateCheckoutGitState,
      runIntegrateGitStatus: deps.runIntegrateGitStatus,
      ...(deps.needsYouTriage ?? {}),
    };
    const handlers = buildHandlersMap(triageDeps.handlers ?? {});
    const roots = await listProjectRoots(primaryRoot, triageDeps);
    state.passCount = (state.passCount ?? 0) + 1;
    const passCount = state.passCount;

    const items = await collectTriageItems(roots, triageDeps);
    const results = [];

    for (const item of Array.isArray(items) ? items : []) {
      if (!item?.id) continue;
      const projectRoot = item.project ?? primaryRoot;
      const key = itemStateKey(item);
      const bucket = classifyInboxItem(item);
      const subtype = inboxItemSubtype(item);

      if (bucket === 'owner') {
        await refreshTriageLock(primaryRoot, { now: nowFn });
        const owner = await ensureOwnerCard(projectRoot, item, triageDeps);
        const decision = owner.decision
          ?? buildIntegrateCheckoutOwnerDecisionText(item)
          ?? buildOwnerDecisionText(item);
        results.push({ id: item.id, project: projectRoot, action: 'owner', decision });
        continue;
      }

      if (!Object.hasOwn(handlers, subtype)) {
        continue;
      }

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

      if (!canRetryThisPass(state, key, passCount)) {
        results.push({ id: item.id, project: projectRoot, action: 'wait-pass' });
        continue;
      }

      const tries = attemptCount(state, key);
      if (tries >= MAX_TRIAGE_ATTEMPTS) {
        const fix = await openSwarmFixGoal({ projectRoot, item, state, key, deps: triageDeps, nowMs, log });
        if (fix.stuck) {
          results.push({ id: item.id, project: projectRoot, action: 'stuck', ...fix });
          continue;
        }
        await closeItem(projectRoot, item, triageDeps, { note: fix.note });
        recordSuppress(state, item, nowMs);
        state.items[key] = { ...(state.items[key] ?? {}), exhausted: true };
        results.push({ id: item.id, project: projectRoot, action: 'swarm-fix', ...fix });
        continue;
      }

      let ok = false;
      let error = null;
      try {
        await refreshTriageLock(primaryRoot, { now: nowFn });
        const handled = await invokeHandler(projectRoot, item, triageDeps, handlers, subtype);
        if (handled.skipped) continue;
        const out = handled.out;
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
        const fix = await openSwarmFixGoal({ projectRoot, item, state, key, deps: triageDeps, nowMs, log });
        if (fix.stuck) {
          results.push({ id: item.id, project: projectRoot, action: 'stuck', ...fix });
        } else {
          await closeItem(projectRoot, item, triageDeps, { note: fix.note });
          recordSuppress(state, item, nowMs);
          state.items[key] = { ...(state.items[key] ?? {}), exhausted: true };
          results.push({ id: item.id, project: projectRoot, action: 'swarm-fix', ...fix });
        }
      } else {
        results.push({ id: item.id, project: projectRoot, action: 'retry', attempt: after, error });
      }
    }

    await writeTriageState(primaryRoot, state);
    return { passCount, results };
  } finally {
    await releaseTriageLock(primaryRoot);
  }
}
