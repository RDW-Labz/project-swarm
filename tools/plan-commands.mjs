// SPDX-License-Identifier: Apache-2.0
// Glue for `swarm plan`, `swarm go` approval and `swarm go --plan ID` (Phase 11). Dependencies are passed in.
import crypto from 'node:crypto';
import { isGoalArgument } from './goal.mjs';
import { estimatePlan, formatPreview, planHash, markPlanRun, savePlan, loadPlan, readCalibration, recordActual, writeCalibration } from './plan-preview.mjs';

export const newPlanId = (now = Date.now) => `plan-${now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

// Pulls the approval flags out of go's argument list; everything else is left for parseGoFlags.
export function extractPlanFlags(args) {
  const rest = [];
  const out = { yes: false, acceptStale: false, planId: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes') out.yes = true;
    else if (arg === '--accept-stale') out.acceptStale = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--plan') {
      if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw Object.assign(new Error('--plan requires a plan id'), { code: 'plan-args' });
      out.planId = args[index + 1];
      index += 1;
    } else rest.push(arg);
  }
  return { ...out, rest };
}

// Builds the manifest exactly as `go` would and the preview for it. Nothing runs.
export async function buildGoalPlan(root, goal, flags, deps) {
  const options = { folders: await deps.folders(root), files: deps.files ? await deps.files(root) : [], leads: flags.leads ?? 'auto', maxJobs: flags.maxJobs, concurrency: flags.concurrency, checks: flags.checks ?? [], maxUsd: flags.maxUsd ?? deps.defaults.maxUsd, maxTokens: flags.maxTokens ?? deps.defaults.maxTokens };
  for (const key of ['maxJobs', 'concurrency']) if (options[key] === undefined) delete options[key];
  const manifest = deps.manifestForGoal(goal, options);
  const calibration = await readCalibration(root);
  const preview = estimatePlan(manifest, { lanes: await deps.laneInfo(manifest), calibration, now: deps.now });
  const now = deps.now ?? Date.now;
  const head = await deps.head(root);
  const planFlags = { leads: options.leads, maxJobs: flags.maxJobs, concurrency: flags.concurrency, maxUsd: options.maxUsd, maxTokens: options.maxTokens };
  return {
    id: newPlanId(now), goal, createdAt: new Date(now()).toISOString(), head, hash: planHash({ manifest, goal, flags: planFlags, head }),
    flags: planFlags,
    manifest, preview, appliedCostRatio: calibration.costRatio ?? 1, appliedTimeRatio: calibration.timeRatio ?? 1,
  };
}

// The owner's yes or no. A person at a terminal is asked; anything else needs --yes and a budget.
export async function approveRun({ yes, interactive, hasBudget, ask }) {
  if (yes) {
    if (!interactive && !hasBudget) return { approved: false, code: 'plan-budget-required', reason: 'an unattended run needs --yes with --max-usd (or --plan)' };
    return { approved: true };
  }
  if (!interactive) return { approved: false, code: 'plan-approval-required', reason: 'no terminal to ask on: pass --yes with --max-usd, or run swarm plan first and use swarm go --plan ID' };
  const answer = String(await ask('Run? [y/N] ')).trim().toLowerCase();
  return answer === 'y' || answer === 'yes' ? { approved: true } : { approved: false, code: 'plan-declined', reason: 'not approved' };
}

// A saved plan is run only if it still describes this repository and is a goal plan; the preview shown at approval
// is recomputed by the caller, never read from the file.
export async function loadApprovedPlan(root, id, { head, acceptStale }) {
  const plan = await loadPlan(root, id);
  if (typeof plan.goal !== 'string' || !isGoalArgument(plan.goal)) throw Object.assign(new Error('plan-invalid: goal'), { code: 'plan-invalid' });
  const hex = value => String(value ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 7);
  if (!acceptStale && (!plan.head || !head || plan.head !== head)) throw Object.assign(new Error(`plan-stale: the repository moved since this plan was made (${hex(plan.head) || 'none'} -> ${hex(head) || 'none'}); make a new plan or pass --accept-stale`), { code: 'plan-stale' });
  return plan;
}

// After a run: estimate beside the actuals, and the actuals fed back into the calibration.
export async function recordRun(root, plan, actual, { now = Date.now } = {}) {
  const compare = { estimated: { costUsd: plan.preview.estimate.costUsd, minutes: plan.preview.estimate.minutes, children: plan.preview.jobs.expectedChildren }, actual };
  try {
    const calibration = await readCalibration(root);
    const estimate = { costUsd: plan.preview.estimate.costUsd, minutes: plan.preview.estimate.minutes, children: plan.preview.jobs.expectedChildren, leads: plan.preview.jobs.leads, appliedCostRatio: plan.appliedCostRatio ?? 1, appliedTimeRatio: plan.appliedTimeRatio ?? 1 };
    await writeCalibration(root, recordActual(calibration, { id: plan.id, estimate, actual: { ...actual, leads: plan.preview.jobs.leads }, at: new Date(now()).toISOString() }));
  } catch { /* calibration is best effort */ }
  return compare;
}

export { formatPreview, savePlan, markPlanRun, estimatePlan, readCalibration };
