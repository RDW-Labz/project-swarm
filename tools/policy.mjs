// SPDX-License-Identifier: Apache-2.0
// Per-machine autonomy policy: which owner requests the swarm may approve without waiting on the owner.
import os from 'node:os';
import path from 'node:path';
import { resolveConfigPath } from './local-config.mjs';
import { isRoutingPath } from './routing-paths.mjs';

export const POLICY_FILE_NAME = 'policy.json';

export const NEVER_AUTO = Object.freeze([
  'merge-deploying-pr',
  'merge-other-repo',
  'hosted-db-migration',
  'new-paid-service',
  'new-key',
  'spend-past-daily-limit',
  'deploy',
  'publish',
  'hand-edit-app-code',
  'new-secret',
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

const protectedBranch = branch => {
  const b = String(branch ?? '').toLowerCase();
  return b === 'main' || b === 'master';
};

const normPath = p => String(p).replace(/\\/g, '/');

function isSetupFile(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  return SETUP_FILES.has(normPath(rel).toLowerCase());
}

function handBuildFileOk(rel) {
  return isRoutingPath(rel) || isSetupFile(rel);
}

function gitFactsOk(facts) {
  const git = facts.git;
  if (git == null || git === '' || (Array.isArray(git) && git.length === 0)) {
    if (facts.branch != null && protectedBranch(facts.branch)) return false;
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
    if (branch != null && protectedBranch(branch)) return false;
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
    if (entry.enabled !== undefined && entry.enabled !== false) {
      errors.push(`${where}: enabled may only be set to false`);
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

export function loadPolicy(filePath, { fs }) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { rules: baseEffectiveRules(), error: null };
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
  if (rule.projects?.length) {
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

function factsForKind(kind, facts = {}) {
  if (kind === 'merge-pr') {
    if (facts.repoClass !== 'swarm') return { ok: false, reason: 'not swarm repo' };
    if (facts.ciGreen !== true) return { ok: false, reason: 'ci not green' };
    if (facts.reviewsPass !== true) return { ok: false, reason: 'reviews not passing' };
    if (facts.fullSuiteGreen !== true) return { ok: false, reason: 'full suite not green' };
    if (facts.inMergeOrder !== true) return { ok: false, reason: 'not in merge order' };
    if (facts.deploysLiveSite === true) return { ok: false, reason: 'deploys live site' };
    return { ok: true };
  }
  if (kind === 'swarm-update') {
    if (facts.machineIdle !== true) return { ok: false, reason: 'machine not idle' };
    if (facts.afterReleaseMerge !== true) return { ok: false, reason: 'not after release merge' };
    return { ok: true };
  }
  if (kind === 'commit-push-swarm-branch') {
    if (protectedBranch(facts.branch)) return { ok: false, reason: 'protected branch' };
    if (facts.allSwarmProduced !== true) return { ok: false, reason: 'not all swarm-produced' };
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
    const toDone = facts.status === 'done' || facts.toStatus === 'done';
    if (toDone && facts.requiresReview === true && facts.reviewPassed !== true) {
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
    if (facts.otherChecksPassing !== true) return { ok: false, reason: 'other checks not passing' };
    return { ok: true };
  }
  if (kind === 'workflow-change') {
    if (facts.opusReviewPassed !== true) return { ok: false, reason: 'opus review not passed' };
    if (facts.addsSecrets === true) return { ok: false, reason: 'adds secrets' };
    if (facts.addsDeploy === true) return { ok: false, reason: 'adds deploy' };
    if (facts.addsPublish === true) return { ok: false, reason: 'adds publish' };
    return { ok: true };
  }
  if (kind === 'cap-raise') {
    const amount = facts.amountUsd;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: 'invalid amount' };
    }
    if (facts.pastDailyAutoLimit === true) return { ok: false, reason: 'past daily auto limit' };
    const raised = Number(facts.raisedTodayUsd ?? 0);
    if (!Number.isFinite(raised) || raised + amount > 5) return { ok: false, reason: 'over daily cap' };
    return { ok: true };
  }
  if (kind === 'change-order-path-fix' || kind === 'change-order-split') {
    if (!facts.project) return { ok: false, reason: 'project missing' };
    return { ok: true };
  }
  return { ok: false, reason: 'no matching rule' };
}

export function decide(request, { rules, now = Date.now } = {}) {
  const kind = request?.kind;
  if (NEVER_AUTO.includes(kind)) {
    return { decision: 'needs-owner', rule: null, reason: 'owner-only' };
  }
  const def = DEFAULT_BY_KIND.get(kind);
  if (!def) return { decision: 'needs-owner', rule: null, reason: 'unknown request kind' };
  const rule = (rules ?? []).find(r => r.id === def.id);
  if (!rule || !rule.enabled) {
    return { decision: 'needs-owner', rule: null, reason: 'rule disabled or missing' };
  }
  const scope = ruleApplies(rule, request, request.facts ?? {});
  if (!scope.ok) return { decision: 'needs-owner', rule: null, reason: scope.reason };
  const factsOk = factsForKind(kind, request.facts ?? {});
  if (!factsOk.ok) return { decision: 'needs-owner', rule: null, reason: factsOk.reason };
  return { decision: 'auto-approve', rule: rule.id, reason: 'policy match' };
}

export function autoDecisionEvent(request, result, { now = Date.now, machine = '' } = {}) {
  return {
    kind: 'auto-decision',
    at: new Date(now()).toISOString(),
    rule: result?.rule ?? null,
    requestKind: request?.kind ?? null,
    requestId: request?.id ?? null,
    project: request?.project ?? null,
    machine: String(machine ?? ''),
    reason: result?.reason ?? null,
  };
}

export function handledForYou(events, { limit = 20 } = {}) {
  const list = (events ?? []).filter(e => e && e.kind === 'auto-decision');
  list.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return list.slice(0, limit);
}
