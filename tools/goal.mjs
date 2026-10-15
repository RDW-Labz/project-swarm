// SPDX-License-Identifier: Apache-2.0
// `swarm go "<goal>"` plans one lead, runs it, then the merge queue, then the rollup.
// A manifest path or a run id still uses the older go() path.

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function isGoalArgument(argument) {
  return typeof argument === 'string' && argument.trim() === argument && argument.length > 0 && argument.length <= 2000
    && !RUN_ID.test(argument) && !argument.includes('/') && !argument.includes('\\') && !argument.endsWith('.json');
}

export function manifestForGoal(goal, { checks = [] } = {}) {
  const text = typeof goal === 'string' ? goal.trim() : '';
  if (!text || text.length > 2000) {
    throw Object.assign(new Error('goal must be 1–2000 characters'), { code: 'goal-invalid' });
  }
  return {
    version: 1,
    concurrency: 2,
    report: 'short',
    ...(checks.length ? { checks } : {}),
    jobs: [{
      id: 'goal-lead',
      type: 'lead',
      agent: 'auto',
      prompt: `Turn this goal into one child manifest of worker jobs. Stay inside the area scope. Every child job uses a short report.\n\nGOAL:\n${text}`,
      context: [],
      outputs: ['coordination/goal-child.json'],
      area: { goal: text, scope: ['src/', 'tests/', 'docs/', 'README.md'], maxJobs: 8 },
    }],
  };
}

function failed(stage, base, reason) {
  return { status: 'failed', stage, ...base, reason };
}

// plan, run, wait, integrate (the merge queue), rollup. Commit and ship stay on `go MANIFEST`.
export async function goGoal(root, goal, flags, deps) {
  const base = { runId: null, cost: null, warnings: [], integrate: null, rollup: null, reason: null };
  if (flags?.commitMessage || flags?.payloadPath) return failed('plan', base, 'a goal does not take --commit-message or --pr');
  let manifest;
  try { manifest = await deps.plan(root, goal); }
  catch (error) { return failed('plan', base, error.message); }
  if (!manifest || manifest.report !== 'short') manifest = { ...(manifest ?? {}), report: 'short' };
  let started, waited;
  try {
    started = await deps.run(root, manifest);
    waited = await deps.wait(root, started.id);
  } catch (error) { return failed('run', base, error.message); }
  base.runId = started.id;
  base.cost = waited.costUsd ?? null;
  base.warnings = waited.warnings ?? [];
  if (waited.status !== 'complete') return failed('run', base, `run ${waited.status}`);
  let integrated;
  try { integrated = await deps.integrate(root, started.id, { queue: true }); }
  catch (error) { return failed('integrate', base, error.message); }
  base.integrate = integrated;
  if (integrated?.checksPassed === false || integrated?.checkFailed?.length || integrated?.status === 'failed') {
    return failed('integrate', base, 'merge queue did not integrate');
  }
  let rollup;
  try { rollup = await deps.rollup(root, started.id); }
  catch (error) { return failed('rollup', base, error.message); }
  return { status: 'complete', stage: 'rollup', ...base, rollup };
}
