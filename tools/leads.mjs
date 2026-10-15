// SPDX-License-Identifier: Apache-2.0
import { LANE_AGENTS } from './lanes.mjs';
import { sanitizeWorkerText } from './worker-text.mjs';

export const LEAD_LIMITS = Object.freeze({ maxJobsDefault: 50, maxJobsMax: 500, concurrencyDefault: 8, concurrencyMax: 64 });
const AREA_KEYS = ['goal', 'scope', 'maxJobs', 'concurrency', 'agents', 'budget'];
const CHILD_KEYS = ['version', 'concurrency', 'jobs', 'budget', 'contract', 'report'];
const JOB_KEYS = ['id', 'agent', 'model', 'type', 'tier', 'prompt', 'context', 'outputs', 'timeoutMs', 'maxOutputTokens', 'after', 'deletes', 'report', 'sensitive'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, reason) => Object.assign(new Error(`${code}: ${reason}`), { code });
function keys(value, allowed, fail) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`key ${key} is not allowed`);
}
function integer(value, max, field, fail) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail(`${field} must be an integer 1–${max}`);
  return value;
}
function budget(value, fail) {
  if (!object(value)) fail('budget must be an object');
  keys(value, ['maxUsd', 'maxTokens'], fail);
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isFinite(amount) || amount <= 0 || (key === 'maxTokens' && !Number.isInteger(amount))) fail(`budget.${key} must be positive${key === 'maxTokens' ? ' integer' : ''}`);
  }
  return { ...value };
}
function repoPath(file) {
  return typeof file === 'string' && file.length > 0 && file.trim() === file
    && !/^(?:\/|[A-Za-z]:|\.\/)/.test(file) && !/\.\.|[*?\[\\\u0000-\u001f]/.test(file)
    && !file.split('/').some(part => part === '.' || part === '.git' || part === '.swarm' || part.startsWith('.env'))
    && !file.includes('//');
}

export function inScope(file, scope) {
  if (!repoPath(file)) return false;
  return scope.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
}

export function scopesOverlap(a, b) {
  return a.some(left => b.some(right => left === right
    || (left.endsWith('/') && right.startsWith(left)) || (right.endsWith('/') && left.startsWith(right))));
}

export function validateLeadArea(job) {
  const fail = reason => { throw error('lead-area-invalid', `Job ${job.id}: ${reason}`); };
  const area = job.area;
  if (!object(area)) fail('area must be an object');
  keys(area, AREA_KEYS, fail);
  if (typeof area.goal !== 'string' || !area.goal.trim() || area.goal.length > 2000) fail('goal must be a non-empty string up to 2000 chars');
  if (!Array.isArray(area.scope) || area.scope.length < 1 || area.scope.length > 50 || area.scope.some(entry => !repoPath(entry))) fail('scope must contain 1 to 50 repo-relative paths without forbidden shapes');
  const maxJobs = integer(area.maxJobs === undefined ? LEAD_LIMITS.maxJobsDefault : area.maxJobs, LEAD_LIMITS.maxJobsMax, 'maxJobs', fail);
  const concurrency = integer(area.concurrency === undefined ? LEAD_LIMITS.concurrencyDefault : area.concurrency, LEAD_LIMITS.concurrencyMax, 'concurrency', fail);
  const agents = area.agents === undefined ? [...new Set(['auto', job.agent])] : area.agents;
  if (!Array.isArray(agents) || !agents.length || agents.some(agent => agent !== 'auto' && !LANE_AGENTS.includes(agent))) fail('agents must be a non-empty array of agent names');
  const normalizedBudget = budget(area.budget === undefined ? {} : area.budget, fail);
  if (!Array.isArray(job.outputs) || job.outputs.length !== 1 || typeof job.outputs[0] !== 'string' || !job.outputs[0].endsWith('.json')) fail('lead must have exactly one .json output');
  if (inScope(job.outputs[0], area.scope)) fail('lead output must not be inside its scope');
  return { goal: area.goal, scope: [...area.scope], maxJobs, concurrency, agents: [...new Set(agents)], budget: normalizedBudget };
}

export function validateParentLeads(manifest) {
  const leads = manifest.jobs.filter(job => job.type === 'lead').map(job => ({ job, area: validateLeadArea(job) }));
  for (let i = 0; i < leads.length; i += 1) {
    const { job, area } = leads[i];
    for (const other of leads.slice(i + 1)) {
      if (scopesOverlap(area.scope, other.area.scope)) throw error('lead-scope-overlap', `${job.id} and ${other.job.id}`);
    }
    for (const worker of manifest.jobs.filter(entry => entry.type !== 'lead')) {
      for (const file of worker.outputs ?? []) {
        if (inScope(file, area.scope)) throw error('lead-scope-overlap', `job ${worker.id} output ${file} is inside lead ${job.id}`);
      }
    }
  }
}

export function validateChildManifest(child, { lead, area, parentManifest, leadSensitive }) {
  const fail = reason => { throw error('lead-child-invalid', `${lead.id}: ${reason}`); };
  if (!object(child)) fail('manifest must be an object');
  keys(child, CHILD_KEYS, fail);
  if (child.version !== 1) fail('version must be 1');
  if (child.contract !== undefined && child.contract !== parentManifest.contract) fail('contract must be the parent contract');
  if (!Array.isArray(child.jobs) || child.jobs.length < 1 || child.jobs.length > area.maxJobs) fail(`jobs must contain 1 to ${area.maxJobs} entries`);
  for (const job of child.jobs) {
    if (!object(job)) fail('job must be an object');
    keys(job, JOB_KEYS, fail);
    if (job.type === 'lead') fail('depth limit 2: child jobs cannot be leads');
    if (!area.agents.includes(job.agent)) fail(`agent ${job.agent} is not allowed`);
    if (job.tier === 'expensive' && !area.agents.includes('claude')) fail('expensive tier requires claude in area.agents');
    if (job.sensitive === false && (leadSensitive ?? lead.sensitive) !== false) fail('sensitive: false requires a lead with sensitive: false');
    for (const field of ['outputs', 'deletes']) {
      if (job[field] !== undefined && !Array.isArray(job[field])) fail(`${field} must be an array`);
      for (const file of job[field] ?? []) if (!inScope(file, area.scope)) fail(`${field} path ${file} is outside scope`);
    }
  }
  const concurrency = child.concurrency === undefined ? area.concurrency : Math.min(integer(child.concurrency, Number.MAX_SAFE_INTEGER, 'concurrency', fail), area.concurrency);
  const childBudget = budget(child.budget === undefined ? {} : child.budget, fail);
  for (const [key, amount] of Object.entries(area.budget)) {
    if (childBudget[key] > amount) fail(`budget.${key} exceeds area budget`);
    if (childBudget[key] === undefined) childBudget[key] = amount;
  }
  const result = { ...child, concurrency, budget: childBudget };
  // `report` has one legal value. A lead that writes a sentence there (the prompt says "use a short report") means "short"; a parent that asked for short reports gets them from every child.
  const shortReports = parentManifest.report === 'short';
  if (shortReports || child.report !== undefined) result.report = 'short';
  result.jobs = child.jobs.map(job => (shortReports || job.report !== undefined ? { ...job, report: 'short' } : job));
  for (const key of ['checks', 'preChecks']) if (parentManifest[key] !== undefined) result[key] = parentManifest[key];
  if (child.contract === undefined && parentManifest.contract !== undefined) result.contract = parentManifest.contract;
  return result;
}

export function leadPromptBlock({ job, area, outputPath }) {
  // The area itself remains authoritative when its text exceeds the prompt cap.
  const short = (value, max) => value.length > max ? `${value.slice(0, max - 3)}...` : value;
  const file = area.scope[0].endsWith('/') ? `${area.scope[0]}result.txt` : area.scope[0];
  const example = { version: 1, jobs: [{ id: 'worker', agent: area.agents[0], prompt: 'Implement the goal.', outputs: [file.length <= 200 ? file : '<file inside scope>'] }] };
  return `\nLead goal: ${short(area.goal, 400)}\nScope: ${short(JSON.stringify(area.scope), 700)}\nMax jobs: ${area.maxJobs}; allowed agents: ${area.agents.join(', ')}; concurrency cap: ${area.concurrency}.\nOnly output: ${short(outputPath, 200)}, holding one JSON manifest {"version":1,"jobs":[...]}.\nAllowed top-level keys: ${CHILD_KEYS.join(', ')}.\nAllowed job keys: ${JOB_KEYS.join(', ')}.\nEvery job output and deletes entry must be inside the scope. outputs, context and deletes are exact file paths, never folders (no trailing slash): to change an existing file list it in both context and outputs, to create a file name the new file. Plan from the file list you are given; you cannot read file contents, so tell each child job to read the files it needs. A job's report, if you set it, is exactly the word short. Child jobs cannot be leads or run commands.\nExample: ${JSON.stringify(example)}`;
}

export function leadRollup(childState, rollup) {
  const records = Array.isArray(childState.jobs) ? childState.jobs : Object.entries(childState.jobs ?? {}).map(([id, record]) => ({ ...record, id: record.id ?? id }));
  const attention = records.filter(job => ['failed', 'blocked', 'held'].includes(job.status)).slice(0, 3)
    .map(job => ({ job: sanitizeWorkerText(job.id), error: sanitizeWorkerText(job.error ?? job.heldReason ?? '', 160) }));
  return {
    job: childState.leadJob, run: childState.id ?? rollup.run, status: childState.status,
    total: rollup.total ?? records.length, counts: { ...rollup.counts },
    spend: { costUsd: rollup.spend?.costUsd ?? 0, tokens: rollup.spend?.tokens ?? 0, estimatedCount: rollup.spend?.estimatedCount ?? 0 }, attention,
  };
}
