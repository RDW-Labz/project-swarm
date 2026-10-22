// SPDX-License-Identifier: Apache-2.0
import { isTestFile } from './context-check.mjs';

// The cheapest lanes first for every kind of job that any lane can do: the flat-rate subscriptions (Cursor, then Codex), then paid Haiku, then the free local lane. The router
// still skips a lane that is paused or cannot take the job, and never routes sensitive jobs where they must not go.
const CHEAPEST_FIRST = ['cursor', 'codex', 'anthropic', 'hermes'];
const preset = (writes, route, timeoutMs, skill, promptLine) => Object.freeze({
  writes, route: Object.freeze(route), timeoutMs, skill, promptLine,
});

export const JOB_TYPES = Object.freeze({
  build: preset('any', ['cursor', 'codex', 'anthropic'], 1800000, null, 'Implement the change and its tests inside your declared outputs.'),
  fix: preset('any', ['cursor', 'codex', 'anthropic'], 1800000, 'diagnosing-bugs', 'Reproduce the failure first, fix the cause, and keep or add a regression test inside your outputs.'),
  test: preset('tests', CHEAPEST_FIRST, 1200000, 'tdd', 'Write or update tests only; do not change non-test files.'),
  review: preset('none', ['codex'], 900000, 'code-review', 'Do not edit files. Finish with one JSON line: {"status":"complete","summary":"...","findings":[{"file":"...","line":0,"severity":"high|medium|low","issue":"...","fix":"..."}]}.'),
  research: preset('none', ['hermes'], 900000, null, 'Do not edit files. Finish with one JSON line: {"status":"complete","summary":"...","sources":["..."],"findings":["..."]}. For GitHub prior art, the coordinator uses swarm scout or sweep instead.'),
  diagnose: preset('none', ['hermes', 'cursor'], 900000, null, 'Do not edit files. Finish with exactly ONE JSON line: {"status":"complete","summary":"..."} where summary is at most 1200 characters (about 5 short lines) naming the likely cause, the evidence (file:line or command output), and one next step.'),
  docs: preset('docs', CHEAPEST_FIRST, 900000, null, 'Edit documentation only. Plain, short sentences.'),
  merge: preset('any', ['codex'], 1800000, 'resolving-merge-conflicts', "Resolve the conflict so both sides' intent survives; never drop a side silently. Keep tests passing."),
  lead: preset('manifest', ['codex'], 900000, null, 'Write exactly one child manifest JSON file as your only output. Do not edit any other file. Child jobs must stay inside your assigned area.'),
});

function jobPreset(job) {
  if (job.type === undefined) return null;
  if (typeof job.type !== 'string' || !Object.hasOwn(JOB_TYPES, job.type)) {
    throw Object.assign(new Error(`Job ${job.id}: unknown type ${job.type}`), { code: 'job-type-invalid' });
  }
  return JOB_TYPES[job.type];
}

export function applyJobType(job, { skillNames = null } = {}) {
  const type = jobPreset(job), newJob = { ...job }, warnings = [];
  if (!type) return { job: newJob, warnings };
  if (job.timeoutMs === undefined) newJob.timeoutMs = type.timeoutMs;
  if (job.skills === undefined && type.skill) {
    if (Array.isArray(skillNames) && skillNames.includes(type.skill)) newJob.skills = [type.skill];
    else warnings.push({
      code: 'job-type-skill-unavailable', jobId: job.id, skill: type.skill,
      message: `job-type-skill-unavailable: Job ${job.id} (type ${job.type}) wants skill ${type.skill}; configure a skills dir that has it`,
    });
  }
  // A build or fix job that owns no test file writes none (the line that asks for tests inside the outputs would send it to put a test in a production file, or to refuse).
  const ownsNoTest = ['build', 'fix'].includes(job.type) && Array.isArray(job.outputs) && job.outputs.length > 0 && !job.outputs.some(isTestFile);
  const promptLine = ownsNoTest
    ? (job.type === 'fix' ? 'Reproduce the failure first and fix the cause inside your outputs. You own no test file here: write no tests or test blocks; prove the fix with the type check and by reading your code.' : 'Implement the change inside your declared outputs. You own no test file here: write no tests or test blocks (never import.meta.vitest in a source file); prove your work with the type check.')
    : type.promptLine;
  const suffix = `\n\nJob type ${job.type}: ${promptLine}`;
  if (!job.prompt.endsWith(suffix)) newJob.prompt = job.prompt + suffix;
  newJob.typeRoute = type.route;
  return { job: newJob, warnings };
}

export function isDocsFile(relPath) {
  const file = String(relPath).replace(/\\/g, '/');
  if (/^docs\/state\//i.test(file)) return false;
  return /\.(?:md|mdx|rst|adoc)$/i.test(file) || /(?:^|\/)(?:README|CHANGELOG)\.txt$/i.test(file);
}

export function jobTypeOutputViolations(job) {
  const type = jobPreset(job);
  if (!type || type.writes === 'any') return [];
  const outputs = job.outputs ?? [];
  if (type.writes === 'none') return [...outputs];
  if (type.writes === 'tests') return outputs.filter(file => !isTestFile(file));
  if (type.writes === 'docs') return outputs.filter(file => !isDocsFile(file));
  if (outputs.length === 1 && outputs[0].endsWith('.json')) return [];
  return outputs.length ? [...outputs] : ['(none)'];
}
