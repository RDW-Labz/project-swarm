// SPDX-License-Identifier: Apache-2.0
// Shared pause gate for paid API lanes before any credential is read from env or keychain.
export const PAID_KEY_LANES = Object.freeze(['anthropic', 'openrouter', 'openai', 'gemini', 'rented', 'lambda']);

export function isHostedLambdaInference(env = process.env) {
  try {
    const { hostname } = new URL(env.SWARM_LAMBDA_URL);
    return !(['localhost', '::1', '[::1]'].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname));
  } catch {
    return true;
  }
}

export function paidLanePauseCode(lane) {
  return `${lane}-lane-paused`;
}

export function paidLanePausedProblem(lane, config) {
  if (config?.lanes?.[lane]?.paused !== true) return null;
  const code = paidLanePauseCode(lane);
  return `${code}: the paid ${lane} lane is paused and no key was read`;
}

export function assertPaidLaneNotPaused(lane, config) {
  const problem = paidLanePausedProblem(lane, config);
  if (problem) throw Object.assign(new Error(problem), { code: paidLanePauseCode(lane) });
}

/** Validation helper for tools/swarm/core-51.mjs validateProject (after anthropic/openrouter checks). */
export function pausedPaidLaneProblems(manifest, config) {
  const jobs = manifest?.jobs ?? [];
  const problems = [];
  for (const lane of ['openai', 'gemini', 'rented', 'lambda']) {
    if (!jobs.some(job => job.agent === lane)) continue;
    const problem = paidLanePausedProblem(lane, config);
    if (problem) problems.push({ lane, code: paidLanePauseCode(lane), message: problem });
  }
  return problems;
}
