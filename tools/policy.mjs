// SPDX-License-Identifier: Apache-2.0
// Per-machine autonomy policy: which owner requests the swarm may approve without waiting on the owner.
import os from 'node:os';
import path from 'node:path';
import { resolveConfigPath } from './local-config.mjs';

export const POLICY_FILE_NAME = 'policy.json';

export const NEVER_AUTO = Object.freeze([
  'merge-main',
  'deploy',
  'publish',
  'cap-raise',
  'hand-edit-app-code',
  'new-workflow',
  'new-secret',
  'auth-change',
  'payments-change',
  'migration',
  'override',
  'accept-unmet-acceptance',
]);

export const DEFAULT_RULES = Object.freeze([
  { id: 'commit-push-swarm-branch', kind: 'commit-push-swarm-branch', conditions: 'swarm-produced files on a branch that is not main or master' },
  { id: 'setup-files-branch', kind: 'setup-files-branch', conditions: 'project setup files on a branch that is not main or master' },
  { id: 'accept-failed-checks-new-tests-only', kind: 'accept-failed-checks', conditions: 'only new-test checks failed and everything else passed' },
  { id: 'retry', kind: 'retry', conditions: 'project named' },
  { id: 'park', kind: 'park', conditions: 'project named' },
  { id: 'release', kind: 'release', conditions: 'project named' },
  { id: 'change-order-path-fix', kind: 'change-order-path-fix', conditions: 'project named' },
  { id: 'change-order-split', kind: 'change-order-split', conditions: 'project named' },
]);

const DEFAULT_IDS = new Set(DEFAULT_RULES.map(r => r.id));
const DEFAULT_BY_KIND = new Map(DEFAULT_RULES.map(r => [r.kind, r]));
const RULE_OVERRIDE_KEYS = new Set(['id', 'enabled', 'projects', 'maxPerDay']);

const protectedBranch = branch => {
  const b = String(branch ?? '').toLowerCase();
  return b === 'main' || b === 'master';
};

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
    if (NEVER_AUTO.includes(entry.id) || (typeof entry.kind === 'string' && NEVER_AUTO.includes(entry.kind))) {
      errors.push(`${where}: ${entry.kind ?? entry.id} can never be auto-approved`);
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
  if (kind === 'commit-push-swarm-branch') {
    if (protectedBranch(facts.branch)) return { ok: false, reason: 'protected branch' };
    if (facts.allSwarmProduced !== true) return { ok: false, reason: 'not all swarm-produced' };
    return { ok: true };
  }
  if (kind === 'setup-files-branch') {
    if (protectedBranch(facts.branch)) return { ok: false, reason: 'protected branch' };
    if (facts.setupFiles !== true) return { ok: false, reason: 'not setup files' };
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
  if (['retry', 'park', 'release', 'change-order-path-fix', 'change-order-split'].includes(kind)) {
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
