// SPDX-License-Identifier: Apache-2.0
// After 2 failed reviews on the same PR, the next fix goes to Opus.
// The fleet passes the count as SWARM_REVIEW_FAILURES (or a manifest job sets reviewFailures). Build and fix jobs
// then route as auto with tier "expensive": the anthropic lane on Opus first, then the claude lane's expensive model.
// The lane-doctor gate still applies; a lane that failed doctor is skipped.
export const OPUS_AFTER_REVIEW_FAILURES = 2;
const MAX_REVIEW_FAILURES = 50;
const ESCALATED_TYPES = new Set([undefined, 'build', 'fix']);

export function reviewFailuresFromEnv(env = process.env) {
  const raw = env?.SWARM_REVIEW_FAILURES;
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_REVIEW_FAILURES ? n : 0;
}

export function needsOpusFix(job) {
  return job?.type !== 'review' && Number.isInteger(job?.reviewFailures) && job.reviewFailures >= OPUS_AFTER_REVIEW_FAILURES;
}

export function validReviewFailures(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0 && value <= MAX_REVIEW_FAILURES);
}

const reasonFor = n => `${n} failed reviews on this PR: the fix goes to Opus`;

// Mutates the manifest. A job that already carries reviewFailures is never re-routed here (it may be a job the
// router already placed), so validating a manifest twice gives the same result.
export function applyReviewEscalation(manifest, env = process.env) {
  if (!manifest || !Array.isArray(manifest.jobs)) return manifest;
  const fromEnv = reviewFailuresFromEnv(env);
  for (const job of manifest.jobs) {
    if (!job || typeof job !== 'object') continue;
    if (job.reviewFailures !== undefined) {
      if (needsOpusFix(job) && job.tier === undefined) Object.assign(job, { tier: 'expensive', tierReason: job.tierReason ?? reasonFor(job.reviewFailures) });
      continue;
    }
    if (fromEnv < OPUS_AFTER_REVIEW_FAILURES || !ESCALATED_TYPES.has(job.type) || job.shell === true || job.preset !== undefined) continue;
    job.reviewFailures = fromEnv;
    job.agent = 'auto';
    delete job.model;
    job.tier = 'expensive';
    job.tierReason = reasonFor(fromEnv);
  }
  return manifest;
}
