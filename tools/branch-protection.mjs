// Ticket T-0250: branch protection payload for main (R-045).
// Pure data builder: no network calls, no tokens, no test code.

export const REQUIRED_PAT_PERMISSIONS = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
  actions: 'read'
});

export const FORBIDDEN_PAT_PERMISSIONS = Object.freeze([
  'administration',
  'workflows',
  'secrets',
  'environments'
]);

export const PROTECTED_BRANCH = 'main';

export function protectionPath(owner, repo) {
  if (typeof owner !== 'string' || owner === '' || typeof repo !== 'string' || repo === '') {
    throw new TypeError('owner and repo must be non-empty strings');
  }
  return `/repos/${owner}/${repo}/branches/${PROTECTED_BRANCH}/protection`;
}

export function buildMainProtectionPayload(requiredChecks) {
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    throw new TypeError('requiredChecks must be a non-empty array of check names');
  }
  for (const name of requiredChecks) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError('each required check must be a non-empty string');
    }
  }
  return {
    required_status_checks: {
      strict: true,
      contexts: [...requiredChecks]
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: true
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: false,
    allow_fork_syncing: false
  };
}
