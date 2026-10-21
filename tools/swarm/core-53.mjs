import { readState } from './core-41.mjs';

// What a finished goal run really used: its child jobs and, when the jobs report it, their cost.
async function runStats(root, runId) {
  try {
    let children = 0, costUsd = 0, costed = false;
    const add = job => { if (Number.isFinite(job.costUsd)) { costUsd += job.costUsd; costed = true; } };
    for (const job of (await readState(root, runId)).jobs ?? []) {
      add(job);
      if (job.childRun) {
        const child = await readState(root, job.childRun);
        children += child.jobs?.length ?? 0;
        for (const childJob of child.jobs ?? []) add(childJob);
      }
    }
    return { children, ...(costed ? { costUsd: Math.round(costUsd * 1e6) / 1e6 } : {}) };
  } catch { return {}; }
}

export { runStats };
