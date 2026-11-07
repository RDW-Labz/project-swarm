// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChildManifest, validateChildManifest, validateLeadArea, leadPromptBlock } from '../tools/leads.mjs';
import { validateManifest } from '../tools/swarm.mjs';

const lead = () => ({ id: 'lead-1', type: 'lead', agent: 'codex', outputs: ['goal-lead-1.json'], area: { goal: 'Build', scope: ['app/'] } });
const childOptions = () => {
  const job = lead();
  return { lead: job, area: validateLeadArea(job), parentManifest: {} };
};

test('normalizeChildManifest defaults missing job context to []', () => {
  const raw = { version: 1, jobs: [{ id: 'w', agent: 'codex', model: 'm', prompt: 'Do it', outputs: ['app/out.js'] }] };
  const out = normalizeChildManifest(raw);
  assert.notEqual(out, raw);
  assert.deepEqual(out.jobs[0].context, []);
  assert.equal(raw.jobs[0].context, undefined);
});

test('normalizeChildManifest keeps an existing context array', () => {
  const raw = { version: 1, jobs: [{ id: 'w', agent: 'codex', model: 'm', prompt: 'Do it', context: ['app/in.js'], outputs: ['app/out.js'] }] };
  const out = normalizeChildManifest(raw);
  assert.deepEqual(out.jobs[0].context, ['app/in.js']);
});

test('normalizeChildManifest does not invent outputs', () => {
  const raw = { version: 1, jobs: [{ id: 'w', agent: 'codex', model: 'm', prompt: 'Do it' }] };
  const out = normalizeChildManifest(raw);
  assert.equal(out.jobs[0].outputs, undefined);
  assert.throws(() => validateManifest(out), /context and outputs must be explicit arrays/);
});

test('validateChildManifest applies context default for manifest validator', () => {
  const child = { version: 1, jobs: [{ id: 'worker', agent: 'codex', model: 'gpt-5', prompt: 'Build.', outputs: ['app/result.js'] }] };
  const validated = validateChildManifest(child, childOptions());
  assert.deepEqual(validated.jobs[0].context, []);
  assert.doesNotThrow(() => validateManifest(validated));
});

test('leadPromptBlock reminds leads to set context on every job', () => {
  const job = lead();
  const area = validateLeadArea(job);
  const block = leadPromptBlock({ job, area, outputPath: job.outputs[0] });
  assert.match(block, /Give every job a context array \(use \[\] when it needs no files\)\./);
});
