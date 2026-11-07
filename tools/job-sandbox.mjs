// SPDX-License-Identifier: Apache-2.0
// Service-side command guard for sandbox jobs (T-0408): deny git push for isolated workers
// before the agent process runs the command. Legacy projects are unchanged unless isolation
// is explicitly enabled (default off).
import { SWARM_JOB_GRANT_FILE, SWARM_JOB_ID } from './job-grants.mjs';
import { isIsolationEnabled } from './job-sandbox-grants.mjs';
import {
  DENY_EXIT_CODE,
  evaluateJobCommand,
} from './job-sandbox-policy.mjs';

export { DENY_EXIT_CODE };

export const GIT_PUSH_DENIED_MESSAGE =
  'sandbox: git push is not allowed for isolated jobs';

export const GIT_ALIAS_DENIED_MESSAGE =
  'sandbox: git alias is not allowed for isolated jobs';

/**
 * @typedef {'legacy' | 'isolated'} JobSandboxMode
 */

/**
 * @param {unknown} project
 * @returns {boolean}
 */
export function isProjectIsolationEnabled(project) {
  return isIsolationEnabled(project);
}

/**
 * Whether this job is running in the isolated sandbox (distinct grants / env handles).
 *
 * @param {{ grant?: { mode?: string } | null, env?: Record<string, string | undefined> }} ctx
 * @returns {boolean}
 */
export function isJobRunningIsolated({ grant, env } = {}) {
  if (grant?.mode === 'isolated') return true;
  if (
    env &&
    typeof env[SWARM_JOB_ID] === 'string' &&
    typeof env[SWARM_JOB_GRANT_FILE] === 'string'
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string | null | undefined} reason
 * @returns {string}
 */
export function messageForDenialReason(reason) {
  if (reason === 'isolated-job-denied-git-push') return GIT_PUSH_DENIED_MESSAGE;
  if (reason === 'isolated-job-denied-git-alias') return GIT_ALIAS_DENIED_MESSAGE;
  if (reason === 'isolated-project-missing-grant') {
    return 'sandbox: isolated project requires a job grant or isolated env handles';
  }
  if (reason === 'isolated-job-unparseable-command') {
    return 'sandbox: isolated jobs require an explicit argv array for command screening';
  }
  if (reason === 'isolated-signal-mismatch') {
    return 'sandbox: job isolation signals disagree with project configuration';
  }
  return 'sandbox: command denied for isolated job';
}

/**
 * @param {string} reason
 * @returns {{ proceed: false, exitCode: number, message: string, reason: string }}
 */
function denyJobCommand(reason) {
  return {
    proceed: false,
    exitCode: DENY_EXIT_CODE,
    message: messageForDenialReason(reason),
    reason,
  };
}

/**
 * Whether the caller supplied a real argv array (not a shell command string).
 *
 * @param {readonly string[] | undefined} argv
 * @param {string | undefined} command
 * @returns {boolean}
 */
export function hasExplicitArgvForCommandCheck(argv) {
  return Array.isArray(argv) && argv.length > 0;
}

/**
 * Normalize argv for policy evaluation. Only explicit argv arrays are valid for isolated
 * screening; raw shell command strings must be rejected by the guard before calling this.
 *
 * @param {readonly string[] | undefined} argv
 * @returns {readonly string[]}
 */
export function argvForCommandCheck(argv) {
  if (Array.isArray(argv) && argv.length > 0) return argv;
  return [];
}

/**
 * Service hook: run immediately before spawning the job command. When denied, the service
 * must exit with `exitCode` and print `message` without invoking the agent command.
 *
 * @param {{
 *   project: unknown,
 *   grant?: { mode?: string, permissions?: { gitPush?: boolean } } | null,
 *   env?: Record<string, string | undefined>,
 *   argv?: readonly string[],
 *   command?: string,
 * }} input
 * @returns {{ proceed: true } | { proceed: false, exitCode: number, message: string, reason: string }}
 */
export function guardJobCommandExecution({
  project,
  grant,
  env,
  argv,
  command,
} = {}) {
  const projectIsolated = isProjectIsolationEnabled(project);
  const jobIsolated = isJobRunningIsolated({ grant, env });
  const grantLegacy = grant?.mode === 'legacy';

  if (!projectIsolated && jobIsolated) {
    return denyJobCommand('isolated-signal-mismatch');
  }

  if (projectIsolated && !jobIsolated) {
    if (grantLegacy) {
      return { proceed: true };
    }
    return denyJobCommand('isolated-project-missing-grant');
  }

  if (!projectIsolated && !jobIsolated) {
    return { proceed: true };
  }

  const hasArgv = hasExplicitArgvForCommandCheck(argv);
  const hasShellCommand =
    typeof command === 'string' && command.length > 0 && !hasArgv;
  if (hasShellCommand) {
    return denyJobCommand('isolated-job-unparseable-command');
  }

  const argvToCheck = argvForCommandCheck(argv);
  const decision = evaluateJobCommand({
    mode: 'isolated',
    grants: { gitPush: grant?.permissions?.gitPush },
    argv: argvToCheck,
  });

  if (decision.allowed) {
    return { proceed: true };
  }

  return {
    proceed: false,
    exitCode: decision.exitCode ?? DENY_EXIT_CODE,
    message: messageForDenialReason(decision.reason),
    reason: decision.reason,
  };
}
