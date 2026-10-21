// SPDX-License-Identifier: Apache-2.0
// Per-machine autonomy policy: which owner requests the swarm may approve without waiting on the owner.
import os from 'node:os';
import path from 'node:path';
import { resolveConfigPath } from './local-config.mjs';
import { isRoutingPath } from './routing-paths.mjs';

export const POLICY_FILE_NAME = 'policy.json';

export const NEVER_AUTO = Object.freeze([
  'merge-other-repo',
  'new-paid-service',
  'new-key',
  'new-account',
  'new-secret',
  'spend-past-daily-limit',
  'irreversible-action',
  'deploy',
  'publish',
  'hand-edit-app-code',
  'auth-change',
  'payments-change',
  'override',
  'accept-unmet-acceptance',
]);

export const DEFAULT_RULES = Object.freeze([
  {
    id: 'merge-swarm-pr',
    kind: 'merge-pr',
    description:
      'Auto-approve merge-pr for the swarm repo when CI, reviews, and the full suite are green, merge order is satisfied, and the merge does not deploy a live site.',
  },
  {
    id: 'merge-live-site',
    kind: 'merge-pr',
    description:
      'Auto-approve merge-pr that deploys a live site when CI, full E2E, reviews, post-deploy watch, auto-rollback, and merge order are satisfied and the change is not irreversible or past the daily auto limit.',
  },
  {
    id: 'hosted-migration',
    kind: 'hosted-db-migration',
    description:
      'Auto-approve hosted-db-migration when backward compatible, backup taken, dry run passed, and main E2E proof are true and the migration is not destructive or irreversible.',
  },
  {
    id: 'branch-switch',
    kind: 'branch-switch',
    description:
      'Auto-approve branch-switch to a plain branch name (letters, digits, dot, underscore, slash, dash) when force is not requested.',
  },
  {
    id: 'journal-restore',
    kind: 'journal-restore',
    description:
      'Auto-approve journal-restore when every path is one of the generated routing files: coordination/HANDOFF.md, docs/state/usage-ledger.md, coordination/TASK.md, or docs/scope/build-plan.md.',
  },
  {
    id: 'swarm-update-idle',
    kind: 'swarm-update',
    description:
      'Auto-approve swarm-update when the machine is idle and the update follows a release merge.',
  },
  {
    id: 'commit-push-swarm-branch',
    kind: 'commit-push-swarm-branch',
    description:
      'Auto-approve git commit or push of swarm-produced files on a branch that is not main or master.',
  },
  {
    id: 'setup-and-routing-hand-build',
    kind: 'hand-build-request',
    description:
      'Auto-approve hand-build-request when every file is a routing or setup path and git is limited to commit and push on a non-main branch.',
  },
  {
    id: 'ticket-routine',
    kind: 'ticket-set-status',
    description:
      'Auto-approve ticket-set-status, ticket-park, ticket-retry, and ticket-release except marking done on a ticket that requires review before review has passed.',
  },
  {
    id: 'change-order-path-fix',
    kind: 'change-order-path-fix',
    description: 'Auto-approve change-order-path-fix for a named project.',
  },
  {
    id: 'change-order-split',
    kind: 'change-order-split',
    description: 'Auto-approve change-order-split for a named project.',
  },
  {
    id: 'workflow-change',
    kind: 'workflow-change',
    description:
      'Auto-approve workflow-change when Opus review passed and the change does not add secrets, deploy steps, or publish steps.',
  },
  {
    id: 'cap-raise-small',
    kind: 'cap-raise',
    description:
      'Auto-approve cap-raise up to five US dollars total per project per day when the daily auto limit has not been exceeded.',
  },
  {
    id: 'accept-failed-checks-new-tests-only',
    kind: 'accept-failed-checks',
    description: 'Auto-approve accept-failed-checks when only new-test checks failed and everything else passed.',
  },
]);

const DEFAULT_IDS = new Set(DEFAULT_RULES.map(r => r.id));
const DEFAULT_BY_KIND = new Map();
for (const rule of DEFAULT_RULES) {
  DEFAULT_BY_KIND.set(rule.kind, rule);
}
DEFAULT_BY_KIND.set('ticket-park', DEFAULT_RULES.find(r => r.id === 'ticket-routine'));
DEFAULT_BY_KIND.set('ticket-retry', DEFAULT_RULES.find(r => r.id === 'ticket-routine'));
DEFAULT_BY_KIND.set('ticket-release', DEFAULT_RULES.find(r => r.id === 'ticket-routine'));

const RULE_OVERRIDE_KEYS = new Set(['id', 'enabled', 'projects', 'maxPerDay']);

const SETUP_FILES = new Set([
  '.gitignore',
  'claude.md',
  'agents.md',
  '.project-swarm.json',
  'coordination/checks.json',
]);

export const POLICY_INITIALIZED_MARKER = '.policy-initialized';

export function normalizePolicyProject(project) {
  if (typeof project !== 'string') return null;
  const trimmed = project.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

export function normalizeBranchName(branch) {
  if (typeof branch !== 'string') return null;
  let b = branch.trim();
  if (!b) return null;
  if (/^HEAD$/i.test(b) || /^HEAD:/i.test(b)) return 'HEAD';
  b = b.replace(/^refs\/remotes\/[^/]+\//i, '');
  b = b.replace(/^refs\/heads\//i, '');
  b = b.replace(/^refs\/remotes\//i, '');
  b = b.replace(/^upstream\//i, '');
  b = b.replace(/^origin\//i, '');
  const remoteMain = /^[a-zA-Z0-9._-]+\/(main|master|release(?:\/.*)?)$/i.exec(b);
  if (remoteMain) b = remoteMain[1];
  return b;
}

/** @returns {'protected'|'unprotected'|'unknown'} */
export function protectedBranchState(branch) {
  const normalized = normalizeBranchName(branch);
  if (normalized === null) return 'unknown';
  if (normalized === 'HEAD') return 'protected';
  const lower = normalized.toLowerCase();
  if (lower === 'main' || lower === 'master' || lower === 'release' || lower.startsWith('release/')) {
    return 'protected';
  }
  if (!PLAIN_BRANCH.test(normalized) || normalized.includes(':')) return 'unknown';
  return 'unprotected';
}

function protectedBranch(branch) {
  return protectedBranchState(branch) === 'protected';
}

function branchNeedsOwner(branch) {
  const state = protectedBranchState(branch);
  return state === 'protected' || state === 'unknown';
}

function factIsTrue(facts, key) {
  return facts[key] === true;
}

function factIsFalse(facts, key) {
  return facts[key] === false;
}

function deploysLiveSiteKnown(facts) {
  const v = facts.deploysLiveSite;
  return v === true || v === false;
}

const normPath = p => String(p).replace(/\\/g, '/');

function isSetupFile(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  return SETUP_FILES.has(normPath(rel).toLowerCase());
}

function handBuildFileOk(rel) {
  return isRoutingPath(rel) || isSetupFile(rel);
}

const PLAIN_BRANCH = /^[a-zA-Z0-9._/-]+$/;

function pathHasDotDot(rel) {
  const p = normPath(rel);
  if (p === '..' || p.startsWith('../') || p.endsWith('/..') || p.includes('/../')) return true;
  return p.split('/').some(seg => seg === '..');
}

function swarmSegmentSensitive(seg) {
  if (!seg) return false;
  if (seg === 'ledger' || seg.startsWith('ledger.')) return true;
  if (seg === 'counter' || seg.startsWith('counter.')) return true;
  if (seg.includes('auto-decision')) return true;
  if (seg === 'journal' || seg.startsWith('journal.')) return true;
  return false;
}

function isSwarmSensitivePath(lowerPath) {
  if (!lowerPath.startsWith('.swarm/')) return false;
  const tail = lowerPath.slice('.swarm/'.length);
  return tail.split('/').some(swarmSegmentSensitive);
}

const JOURNAL_RESTORE_EXACT = new Set([
  'coordination/handoff.md',
  'docs/state/usage-ledger.md',
  'coordination/task.md',
  'docs/scope/build-plan.md',
]);

function isJournalRestorePath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const p = normPath(rel);
  if (pathHasDotDot(p)) return false;
  const lower = p.toLowerCase();
  if (lower.startsWith('.swarm/')) return false;
  return JOURNAL_RESTORE_EXACT.has(lower);
}

function ruleIdForKind(kind, facts = {}) {
  if (kind === 'merge-pr') {
    if (!deploysLiveSiteKnown(facts)) return null;
    return facts.deploysLiveSite === true ? 'merge-live-site' : 'merge-swarm-pr';
  }
  const def = DEFAULT_BY_KIND.get(kind);
  return def?.id ?? null;
}

function gitFactsOk(facts) {
  const git = facts.git;
  if (git == null || git === '' || (Array.isArray(git) && git.length === 0)) {
    if (facts.branch != null && branchNeedsOwner(facts.branch)) return false;
    return true;
  }
  const entries = Array.isArray(git) ? git : [git];
  const allowed = new Set(['commit', 'push']);
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.op ?? entry?.name;
    if (typeof name !== 'string' || !allowed.has(name)) return false;
    const branch = typeof entry === 'object' && entry != null && !Array.isArray(entry)
      ? entry.branch ?? facts.branch
      : facts.branch;
    if (branch != null && branchNeedsOwner(branch)) return false;
  }
  return true;
}

export const DEFAULT_POLICY_FILE = Object.freeze({
  version: 1,
  'owner-note':
    'Default standing approvals for this machine. Each rules[] entry may set enabled: false to require owner approval for that rule.',
  rules: DEFAULT_RULES.map(({ id }) => ({ id, enabled: true })),
});

export function policyPath(env = process.env, home = env?.HOME || os.homedir()) {
  const configFile = resolveConfigPath({ env, home });
  return path.join(path.dirname(configFile), POLICY_FILE_NAME);
}

function baseEffectiveRules() {
  return DEFAULT_RULES.map(r => ({
    ...r,
    enabled: true,
    projects: null,
    maxPerDay: null,
  }));
}

export function effectiveRulesFromOverrides(overrides = []) {
  const byId = new Map(baseEffectiveRules().map(r => [r.id, { ...r }]));
  for (const entry of overrides) {
    const cur = byId.get(entry.id);
    if (!cur) continue;
    if (entry.enabled === false) cur.enabled = false;
    if (Array.isArray(entry.projects)) cur.projects = entry.projects;
    if (entry.maxPerDay !== undefined && entry.maxPerDay !== null) cur.maxPerDay = entry.maxPerDay;
  }
  return [...byId.values()];
}

export function validatePolicy(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('policy must be a JSON object');
    return errors;
  }
  const rules = obj.rules;
  if (rules !== undefined && !Array.isArray(rules)) {
    errors.push('rules must be an array');
    return errors;
  }
  if (!rules) return errors;
  for (let i = 0; i < rules.length; i += 1) {
    const entry = rules[i];
    const where = `rules[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!RULE_OVERRIDE_KEYS.has(key)) errors.push(`${where}: unknown field ${key}`);
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      errors.push(`${where}: id is required`);
      continue;
    }
    if (NEVER_AUTO.includes(entry.id)) {
      errors.push(`${where}: ${entry.id} can never be auto-approved`);
      continue;
    }
    if (!DEFAULT_IDS.has(entry.id)) {
      errors.push(`${where}: unknown rule id ${entry.id}`);
      continue;
    }
    if (entry.enabled !== undefined && entry.enabled !== false && entry.enabled !== true) {
      errors.push(`${where}: enabled must be true or false`);
    }
    if (entry.projects !== undefined) {
      if (!Array.isArray(entry.projects) || !entry.projects.every(p => typeof p === 'string' && p)) {
        errors.push(`${where}: projects must be a list of project names`);
      }
    }
    if (entry.maxPerDay !== undefined) {
      const n = entry.maxPerDay;
      if (!Number.isInteger(n) || n < 1) errors.push(`${where}: maxPerDay must be a positive integer`);
    }
  }
  return errors;
}

export function policyInitializedMarkerPath(policyFilePath) {
  return path.join(path.dirname(policyFilePath), POLICY_INITIALIZED_MARKER);
}

export function loadPolicy(filePath, { fs }) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const marker = policyInitializedMarkerPath(filePath);
      try {
        fs.accessSync(marker);
        return { rules: [], error: 'policy file missing after init' };
      } catch (markerErr) {
        if (markerErr?.code && markerErr.code !== 'ENOENT') {
          return { rules: [], error: String(markerErr.message ?? markerErr) };
        }
        return { rules: baseEffectiveRules(), error: null };
      }
    }
    return { rules: [], error: String(error.message ?? error) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { rules: [], error: 'invalid policy json' };
  }
  const errors = validatePolicy(parsed);
  if (errors.length) return { rules: [], error: errors.join('; ') };
  return { rules: effectiveRulesFromOverrides(parsed.rules ?? []), error: null };
}

function ruleApplies(rule, request, facts) {
  if (!rule.enabled) return { ok: false, reason: 'rule disabled' };
  if (Array.isArray(rule.projects)) {
    if (rule.projects.length === 0) return { ok: false, reason: 'project not in rule list' };
    const project = request.project ?? facts?.project;
    if (!project || !rule.projects.includes(project)) return { ok: false, reason: 'project not in rule list' };
  }
  if (rule.maxPerDay != null) {
    const counts = facts?.autoToday && typeof facts.autoToday === 'object' ? facts.autoToday : {};
    const used = Number(counts[rule.id] ?? 0);
    if (used >= rule.maxPerDay) return { ok: false, reason: 'daily limit reached' };
  }
  return { ok: true };
}

function factsForKind(kind, facts = {}, ruleId = null, request = {}) {
  if (kind === 'merge-pr') {
    if (!deploysLiveSiteKnown(facts)) return { ok: false, reason: 'deploys live site unknown' };
    const rid = ruleId ?? ruleIdForKind(kind, facts);
    if (rid === 'merge-live-site') {
      if (!factIsTrue(facts, 'deploysLiveSite')) return { ok: false, reason: 'does not deploy live site' };
      if (facts.repoClass !== 'swarm') return { ok: false, reason: 'not swarm repo' };
      if (!factIsTrue(facts, 'ciGreen')) return { ok: false, reason: 'ci not green' };
      if (!factIsTrue(facts, 'fullE2eGreen')) return { ok: false, reason: 'full e2e not green' };
      if (!factIsTrue(facts, 'reviewsPass')) return { ok: false, reason: 'reviews not passing' };
      if (!factIsTrue(facts, 'postDeployWatch')) return { ok: false, reason: 'post-deploy watch not configured' };
      if (!factIsTrue(facts, 'autoRollback')) return { ok: false, reason: 'auto-rollback not configured' };
      if (!factIsTrue(facts, 'inMergeOrder')) return { ok: false, reason: 'not in merge order' };
      if (!factIsFalse(facts, 'irreversible')) return { ok: false, reason: 'irreversible' };
      if (!factIsFalse(facts, 'pastDailyAutoLimit')) return { ok: false, reason: 'past daily auto limit' };
      return { ok: true };
    }
    if (facts.repoClass !== 'swarm') return { ok: false, reason: 'not swarm repo' };
    if (!factIsTrue(facts, 'ciGreen')) return { ok: false, reason: 'ci not green' };
    if (!factIsTrue(facts, 'reviewsPass')) return { ok: false, reason: 'reviews not passing' };
    if (!factIsTrue(facts, 'fullSuiteGreen')) return { ok: false, reason: 'full suite not green' };
    if (!factIsTrue(facts, 'inMergeOrder')) return { ok: false, reason: 'not in merge order' };
    if (!factIsFalse(facts, 'deploysLiveSite')) return { ok: false, reason: 'deploys live site' };
    return { ok: true };
  }
  if (kind === 'hosted-db-migration') {
    if (!factIsTrue(facts, 'backwardCompatible')) return { ok: false, reason: 'not backward compatible' };
    if (!factIsTrue(facts, 'backupTaken')) return { ok: false, reason: 'backup not taken' };
    if (!factIsTrue(facts, 'dryRunPassed')) return { ok: false, reason: 'dry run not passed' };
    if (!factIsTrue(facts, 'mainE2eProof')) return { ok: false, reason: 'main e2e proof missing' };
    if (!factIsFalse(facts, 'destructive')) return { ok: false, reason: 'destructive' };
    if (!factIsFalse(facts, 'irreversible')) return { ok: false, reason: 'irreversible' };
    return { ok: true };
  }
  if (kind === 'branch-switch') {
    const normalized = normalizeBranchName(facts.branch);
    if (normalized === null || !PLAIN_BRANCH.test(normalized) || normalized.includes(':')) {
      return { ok: false, reason: 'invalid branch name' };
    }
    if (branchNeedsOwner(normalized)) return { ok: false, reason: 'protected branch' };
    if (!factIsFalse(facts, 'force')) return { ok: false, reason: 'force switch' };
    return { ok: true };
  }
  if (kind === 'journal-restore') {
    const files = facts.files;
    if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: 'files missing' };
    if (!files.every(isJournalRestorePath)) return { ok: false, reason: 'file outside generated or routing' };
    return { ok: true };
  }
  if (kind === 'swarm-update') {
    if (!factIsTrue(facts, 'machineIdle')) return { ok: false, reason: 'machine not idle' };
    if (!factIsTrue(facts, 'afterReleaseMerge')) return { ok: false, reason: 'not after release merge' };
    return { ok: true };
  }
  if (kind === 'commit-push-swarm-branch') {
    if (branchNeedsOwner(facts.branch)) return { ok: false, reason: 'protected branch' };
    if (!factIsTrue(facts, 'allSwarmProduced')) return { ok: false, reason: 'not all swarm-produced' };
    return { ok: true };
  }
  if (kind === 'hand-build-request') {
    const files = facts.files;
    if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: 'files missing' };
    if (!files.every(handBuildFileOk)) return { ok: false, reason: 'file outside routing or setup' };
    if (!gitFactsOk(facts)) return { ok: false, reason: 'git not limited to commit/push on non-main' };
    return { ok: true };
  }
  if (kind === 'ticket-set-status') {
    const rawStatus = facts.status ?? facts.toStatus;
    const toDone = typeof rawStatus === 'string' && rawStatus.trim().toLowerCase() === 'done';
    if (toDone && facts.requiresReview !== false && facts.reviewPassed !== true) {
      return { ok: false, reason: 'review gate' };
    }
    return { ok: true };
  }
  if (kind === 'ticket-park' || kind === 'ticket-retry' || kind === 'ticket-release') {
    return { ok: true };
  }
  if (kind === 'accept-failed-checks') {
    const failing = facts.failingChecks;
    const newTests = facts.newTestChecks;
    if (!Array.isArray(failing) || failing.length === 0) return { ok: false, reason: 'no failing checks listed' };
    if (!Array.isArray(newTests)) return { ok: false, reason: 'new test checks missing' };
    if (!failing.every(name => newTests.includes(name))) return { ok: false, reason: 'failing check outside new tests' };
    if (!factIsTrue(facts, 'otherChecksPassing')) return { ok: false, reason: 'other checks not passing' };
    return { ok: true };
  }
  if (kind === 'workflow-change') {
    if (!factIsTrue(facts, 'opusReviewPassed')) return { ok: false, reason: 'opus review not passed' };
    if (!factIsFalse(facts, 'isNewWorkflow')) return { ok: false, reason: 'new workflow' };
    if (!factIsFalse(facts, 'addsSecrets')) return { ok: false, reason: 'adds secrets' };
    if (!factIsFalse(facts, 'addsDeploy')) return { ok: false, reason: 'adds deploy' };
    if (!factIsFalse(facts, 'addsPublish')) return { ok: false, reason: 'adds publish' };
    return { ok: true };
  }
  if (kind === 'cap-raise') {
    const amount = facts.amountUsd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: 'invalid amount' };
    }
    const project = normalizePolicyProject(request.project ?? facts.project);
    if (!project) return { ok: false, reason: 'project missing' };
    if (!factIsFalse(facts, 'pastDailyAutoLimit')) return { ok: false, reason: 'past daily auto limit' };
    const raised = Number(facts.raisedTodayUsd ?? 0);
    if (!Number.isFinite(raised) || raised < 0) return { ok: false, reason: 'raised today unknown' };
    if (raised + amount > 5) return { ok: false, reason: 'over daily cap' };
    return { ok: true };
  }
  if (kind === 'change-order-path-fix' || kind === 'change-order-split') {
    const p = facts.project;
    const reqProject = request.project ?? request.facts?.project;
    if (typeof p !== 'string' || !p.trim()) return { ok: false, reason: 'project missing' };
    if (typeof reqProject !== 'string' || !reqProject.trim()) return { ok: false, reason: 'project missing' };
    if (p !== reqProject) return { ok: false, reason: 'project mismatch' };
    return { ok: true };
  }
  return { ok: false, reason: 'no matching rule' };
}

export function decide(request, { rules, now = Date.now } = {}) {
  const kind = request?.kind;
  if (NEVER_AUTO.includes(kind)) {
    return { decision: 'needs-owner', rule: null, reason: 'owner-only' };
  }
  const ruleId = ruleIdForKind(kind, request.facts ?? {});
  if (!ruleId) return { decision: 'needs-owner', rule: null, reason: 'unknown request kind' };
  const rule = (rules ?? []).find(r => r.id === ruleId);
  if (!rule || !rule.enabled) {
    return { decision: 'needs-owner', rule: null, reason: 'rule disabled or missing' };
  }
  const scope = ruleApplies(rule, request, request.facts ?? {});
  if (!scope.ok) return { decision: 'needs-owner', rule: null, reason: scope.reason };
  const factsOk = factsForKind(kind, request.facts ?? {}, ruleId, request);
  if (!factsOk.ok) return { decision: 'needs-owner', rule: null, reason: factsOk.reason };
  return { decision: 'auto-approve', rule: rule.id, reason: 'policy match' };
}

export function autoDecisionEvent(request, result, { now = Date.now, machine = '' } = {}) {
  const event = {
    kind: 'auto-decision',
    at: new Date(now()).toISOString(),
    rule: result?.rule ?? null,
    requestKind: request?.kind ?? null,
    requestId: request?.id ?? null,
    project: request?.project ?? null,
    machine: String(machine ?? ''),
    reason: result?.reason ?? null,
  };
  if (request?.kind === 'cap-raise' && typeof request.facts?.amountUsd === 'number') {
    event.amountUsd = request.facts.amountUsd;
  }
  return event;
}

export function handledForYou(events, { limit = 20 } = {}) {
  const list = (events ?? []).filter(e => e && e.kind === 'auto-decision');
  list.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return list.slice(0, limit);
}
