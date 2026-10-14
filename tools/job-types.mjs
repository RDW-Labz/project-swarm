// SPDX-License-Identifier: Apache-2.0
import { isTestFile } from './context-check.mjs';

const preset = (writes, route, timeoutMs, skill, promptLine) => Object.freeze({
  writes, route: Object.freeze(route), timeoutMs, skill, promptLine,
});

export const JOB_TYPES = Object.freeze({
  build: preset('any', ['cursor', 'codex'], 1800000, null, 'Implement the change and its tests inside your declared outputs.'),
  fix: preset('any', ['cursor', 'codex'], 1800000, 'diagnosing-bugs', 'Reproduce the failure first, fix the cause, and keep or add a regression test inside your outputs.'),
  test: preset('tests', ['codex', 'cursor'], 1200000, 'tdd', 'Write or update tests only; do not change non-test files.'),
  review: preset('none', ['hermes', 'codex'], 900000, 'code-review', 'Do not edit files. Finish with one JSON line: {"status":"complete","summary":"...","findings":[{"file":"...","line":0,"severity":"high|medium|low","issue":"...","fix":"..."}]}.'),
  research: preset('none', ['hermes', 'openrouter'], 900000, null, 'Do not edit files. Finish with one JSON line: {"status":"complete","summary":"...","sources":["..."],"findings":["..."]}. For GitHub prior art, the coordinator uses swarm scout or sweep instead.'),
  docs: preset('docs', ['hermes'], 900000, null, 'Edit documentation only. Plain, short sentences.'),
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
  const suffix = `\n\nJob type ${job.type}: ${type.promptLine}`;
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
