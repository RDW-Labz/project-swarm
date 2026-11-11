// SPDX-License-Identifier: Apache-2.0
// Retry jobs that were running on a lane that went down, on another healthy lane (T-0456, R-083).

/**
 * @typedef {{ id: string, health: 'healthy' | 'degraded' | 'down', cost?: number }} Lane
 * @typedef {{ id: string, state: string, lane?: string | null, retries?: number }} Job
 */

/**
 * Pick the lane that should take a retried job: cheapest healthy lane first (existing cost order),
 * and a degraded lane only when no healthy lane is routable. Down lanes are never picked.
 *
 * @param {Lane[]} lanes
 * @param {string} [excludeLaneId] lane the job was on when it went down
 * @returns {Lane | null}
 */
export function pickRetryLane(lanes, excludeLaneId) {
  const byCost = [...lanes]
    .filter((lane) => lane.id !== excludeLaneId)
    .sort((a, b) => Number(a.cost ?? 0) - Number(b.cost ?? 0));
  return byCost.find((lane) => lane.health === 'healthy')
    ?? byCost.find((lane) => lane.health === 'degraded')
    ?? null;
}

/**
 * Move every job that is 'running' on a down lane off that lane. Each moved job is set to 'queued'
 * (so it is never left in 'running') and assigned to the retry lane when one is routable.
 *
 * @param {Job[]} jobs
 * @param {Lane[]} lanes
 * @returns {{ jobs: Job[], moved: { id: string, from: string, to: string }[], stranded: string[] }}
 */
export function retryJobsFromDownLanes(jobs, lanes) {
  const downIds = new Set(lanes.filter((lane) => lane.health === 'down').map((lane) => lane.id));
  const moved = [];
  const stranded = [];
  const nextJobs = jobs.map((job) => {
    if (job.state !== 'running' || !job.lane || !downIds.has(job.lane)) return job;
    const target = pickRetryLane(lanes, job.lane);
    const retries = Number(job.retries ?? 0) + 1;
    if (!target || target.health === 'down') {
      stranded.push(job.id);
      return { ...job, state: 'queued', lane: null, retries };
    }
    moved.push({ id: job.id, from: job.lane, to: target.id });
    return { ...job, state: 'queued', lane: target.id, retries };
  });
  return { jobs: nextJobs, moved, stranded };
}
