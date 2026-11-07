// Queue depth for a shared project across machines (T-0266, AC1).
// Input: an array of snapshots, each { jobs: [{ ticket, state, updatedAt }] }.
// A ticket counts once, even when several machines report it.
// The newest record for a ticket wins. Only queued or leased jobs count.

export const QUEUE_STATES = new Set(['queued', 'leased']);

function rank(updatedAt) {
  const t = Date.parse(updatedAt);
  return Number.isNaN(t) ? 0 : t;
}

export function sharedQueueDepth(snapshots) {
  const newest = new Map();
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    const jobs = Array.isArray(snap && snap.jobs) ? snap.jobs : [];
    for (const job of jobs) {
      if (!job || typeof job.ticket !== 'string') continue;
      if (!QUEUE_STATES.has(job.state)) continue;
      const prev = newest.get(job.ticket);
      if (!prev || rank(job.updatedAt) > rank(prev.updatedAt)) {
        newest.set(job.ticket, job);
      }
    }
  }
  return newest.size;
}
