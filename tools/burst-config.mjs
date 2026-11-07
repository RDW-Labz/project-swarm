// Ticket T-0271: per-project burst configuration and queue filtering.
// Burst defaults to 'off'. When a project's burst is off, cloud (lane:burst) jobs are hidden from queue listings.

export const BURST_DEFAULT = 'off';
const VALID_BURST = new Set(['off', 'on']);

export function normalizeBurst(value) {
  if (value === undefined || value === null || value === '') return BURST_DEFAULT;
  const v = String(value).trim().toLowerCase();
  if (!VALID_BURST.has(v)) throw new Error(`invalid burst value: ${value}`);
  return v;
}

export function burstEnabled(projectConfig) {
  return normalizeBurst(projectConfig?.burst) === 'on';
}

export function isCloudJob(job) {
  if (Array.isArray(job?.tags)) return job.tags.includes('lane:burst');
  return job?.lane === 'burst';
}

export function visibleQueueJobs(jobs, projectConfig) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (burstEnabled(projectConfig)) return list.slice();
  return list.filter((job) => !isCloudJob(job));
}
