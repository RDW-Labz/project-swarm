/**
 * Service-side sandbox policy for worker jobs (ticket T-0260).
 *
 * Isolated jobs run with permissions enforced by the service. This module
 * decides, before any agent command executes, whether a command is allowed.
 * Legacy jobs keep their existing behaviour. Isolation is opt-in per project
 * and off by default.
 *
 * Limit: argv screening is a best-effort guard, not a security boundary. The
 * binding control is credential-level: isolated containers must receive no
 * push-capable token or credential helper, and remotes must be read-only.
 */

/** @typedef {'legacy' | 'isolated'} SandboxMode */

/**
 * @typedef {Object} JobGrants
 * @property {boolean} [gitPush] whether this job may run git push
 */

/**
 * @typedef {Object} PolicyDecision
 * @property {boolean} allowed
 * @property {number} exitCode 0 when allowed, 1 when denied at the service
 * @property {string} reason
 */

export const DENY_EXIT_CODE = 1;

/**
 * Git options that take a separate value argument and must be skipped
 * when looking for the subcommand.
 */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);

/** Subcommands that transmit objects to a remote. */
const PUSH_SUBCOMMANDS = new Set(['push', 'send-pack', 'receive-pack']);

/** Separators used to split argv entries into words, covering shell wrappers. */
const WORD_SEPARATORS = /[\s;&|()<>`$'"]+/;

/**
 * Resolve the sandbox mode for a project. Anything other than an explicit
 * `isolated: true` opt-in resolves to legacy.
 *
 * @param {string} project
 * @param {{ sandbox?: Record<string, { isolated?: boolean }> } | null | undefined} config
 * @returns {SandboxMode}
 */
export function resolveSandboxMode(project, config) {
  const entry = config?.sandbox?.[project];
  return entry && entry.isolated === true ? 'isolated' : 'legacy';
}

/**
 * Lowercased executable basename without directory or .exe suffix.
 *
 * @param {string} word
 * @returns {string}
 */
function basenameOf(word) {
  const parts = String(word).split(/[/\\]/);
  return (parts[parts.length - 1] || '').toLowerCase().replace(/\.exe$/, '');
}

/**
 * Split every argv entry into words so wrapped commands (env, sh -c, and so on)
 * are visible to the check.
 *
 * @param {readonly string[]} argv
 * @returns {string[]}
 */
function wordsOf(argv) {
  return argv.flatMap((a) => String(a).split(WORD_SEPARATORS)).filter((w) => w.length > 0);
}

/**
 * Return the git subcommand name from an argv array such as
 * ['git', '-C', 'dir', 'push', 'origin']. Returns null when argv is not a git
 * command or no subcommand can be found.
 *
 * @param {readonly string[]} argv
 * @returns {string | null}
 */
export function gitSubcommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  if (basenameOf(argv[0]) !== 'git') return null;
  let i = 1;
  while (i < argv.length) {
    const token = String(argv[i]);
    if (token === '--') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      i += GIT_OPTIONS_WITH_VALUE.has(token) ? 2 : 1;
      continue;
    }
    return token;
  }
  return null;
}

/**
 * Check one git invocation starting at words[start] (the 'git' word).
 *
 * @param {string[]} ws
 * @param {number} start
 * @returns {string | null} denial reason, or null when this invocation is allowed
 */
function gitInvocationReason(ws, start) {
  let j = start + 1;
  let aliasSeen = false;
  while (j < ws.length) {
    const w = ws[j];
    if (w === '--') {
      j += 1;
      continue;
    }
    if (w.startsWith('-')) {
      if (/^-calias\./i.test(w)) aliasSeen = true;
      if (GIT_OPTIONS_WITH_VALUE.has(w)) {
        const value = ws[j + 1] || '';
        if (w === '-c' && /^alias\./i.test(value)) aliasSeen = true;
        j += 2;
      } else {
        j += 1;
      }
      continue;
    }
    // An alias could map to a push, so any alias config is denied outright.
    if (aliasSeen) return 'isolated-job-denied-git-alias';
    return PUSH_SUBCOMMANDS.has(w.toLowerCase()) ? 'isolated-job-denied-git-push' : null;
  }
  return aliasSeen ? 'isolated-job-denied-git-alias' : null;
}

/**
 * Find a push-capable git invocation anywhere in argv, including inside wrappers.
 *
 * @param {readonly string[]} argv
 * @returns {string | null} denial reason, or null
 */
function pushDenialReason(argv) {
  const ws = wordsOf(argv);
  for (let i = 0; i < ws.length; i += 1) {
    const base = basenameOf(ws[i]);
    if (base === 'git') {
      const reason = gitInvocationReason(ws, i);
      if (reason) return reason;
    } else if (base.startsWith('git-') && PUSH_SUBCOMMANDS.has(base.slice(4))) {
      return 'isolated-job-denied-git-push';
    }
  }
  return null;
}

/**
 * Decide whether a command may run for a job.
 *
 * @param {{ mode: SandboxMode, grants?: JobGrants, argv: readonly string[] }} input
 * @returns {PolicyDecision}
 */
export function evaluateJobCommand({ mode, grants, argv }) {
  if (mode !== 'isolated') {
    return { allowed: true, exitCode: 0, reason: 'legacy-mode' };
  }
  if (!Array.isArray(argv)) {
    return { allowed: false, exitCode: DENY_EXIT_CODE, reason: 'isolated-job-invalid-argv' };
  }
  if (grants?.gitPush === true) {
    return { allowed: true, exitCode: 0, reason: 'allowed-git-push-granted' };
  }
  const reason = pushDenialReason(argv);
  if (reason) {
    return { allowed: false, exitCode: DENY_EXIT_CODE, reason };
  }
  return { allowed: true, exitCode: 0, reason: 'allowed' };
}
