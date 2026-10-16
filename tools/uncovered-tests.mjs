// SPDX-License-Identifier: Apache-2.0
const HEADER = 'Uncovered test references (add the test to context, or list it in ignoreTests with a reason in the prompt): ';
const ENTRY = /^([A-Za-z0-9._-]+): (\S+) <- (\S+)$/;

export function parseUncovered(message) {
  if (typeof message !== 'string' || !message.startsWith('Uncovered test references')) return [];
  const at = message.indexOf('): ');
  if (at === -1) return [];
  const body = message.slice(at + 3);
  const refs = [];
  for (const part of body.split('; ')) {
    const match = ENTRY.exec(part.trim());
    if (match) refs.push({ job: match[1], output: match[2], test: match[3] });
  }
  return refs;
}

export function ignoreUncovered(jobs, refs) {
  const byJob = new Map();
  for (const ref of refs ?? []) {
    if (!byJob.has(ref.job)) byJob.set(ref.job, new Set());
    byJob.get(ref.job).add(ref.test);
  }
  return jobs.map(job => {
    const wanted = byJob.get(job.id);
    if (!wanted) return job;
    const existing = Array.isArray(job.ignoreTests) ? job.ignoreTests : [];
    const added = [...wanted].filter(test => !existing.includes(test)).sort();
    let prompt = job.prompt;
    for (const test of added) {
      prompt += '\nignoreTests: ' + test + " — Existing test is outside this job's declared outputs; the coordinator runs it after integration.";
    }
    return { ...job, prompt, ignoreTests: [...new Set([...existing, ...wanted])].sort() };
  });
}
