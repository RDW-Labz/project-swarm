import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, runManifest, inspectRun, claudeArgs } from '../tools/swarm.mjs';
import { preflightProject } from '../tools/preflight.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-tier-test-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()] });

test('accepts each valid tier, with a reason required only for expensive', () => {
  assert.doesNotThrow(() => validateManifest(manifest([job({ tier: 'cheap' })])));
  assert.doesNotThrow(() => validateManifest(manifest([job({ tier: 'mid' })])));
  assert.doesNotThrow(() => validateManifest(manifest([job({ tier: 'expensive', tierReason: 'Touches the token refresh security boundary.' })])));
});

test('rejects an unknown tier value', () => {
  assert.throws(() => validateManifest(manifest([job({ tier: 'premium' })])), /Unknown tier/);
  assert.throws(() => validateManifest(manifest([job({ tier: 'Expensive' })])), /Unknown tier/);
});

test('rejects expensive without a non-empty tierReason', () => {
  assert.throws(() => validateManifest(manifest([job({ tier: 'expensive' })])), /tierReason/);
  assert.throws(() => validateManifest(manifest([job({ tier: 'expensive', tierReason: '' })])), /tierReason/);
  assert.throws(() => validateManifest(manifest([job({ tier: 'expensive', tierReason: '   ' })])), /tierReason/);
});

test('rejects a malformed tierReason regardless of tier', () => {
  assert.throws(() => validateManifest(manifest([job({ tier: 'cheap', tierReason: 42 })])), /Invalid tierReason/);
  assert.throws(() => validateManifest(manifest([job({ tier: 'mid', tierReason: 'x'.repeat(2001) })])), /Invalid tierReason/);
});

test('a manifest with no tier field validates exactly as before', () => {
  const plain = manifest();
  const before = JSON.stringify(plain);
  const validated = validateManifest(plain);
  assert.equal(validated.jobs[0].tier, undefined);
  assert.equal(validated.jobs[0].tierReason, undefined);
  assert.equal(JSON.stringify(plain), before);
});

test('an explicit per-task model wins over tier: tier never changes the model that is dispatched', () => {
  const withTier = job({ tier: 'expensive', tierReason: 'Public API contract between two repos.', model: 'claude-sonnet-4-6' });
  validateManifest(manifest([withTier]));
  // The dispatched CLI args carry only the explicit model; tier/tierReason are not consulted.
  assert.deepEqual(claudeArgs(withTier).slice(-2), ['--model', 'claude-sonnet-4-6']);
  // Changing tier alone (cheap vs expensive) does not change the resolved model.
  const cheapSameModel = job({ tier: 'cheap', model: 'claude-sonnet-4-6' });
  assert.deepEqual(claudeArgs(cheapSameModel), claudeArgs(withTier));
});

test('claudeArgs omits --model only when the job object itself carries none, though validateManifest never lets such a job run', () => {
  const args = claudeArgs(job({ tier: 'mid', model: undefined }));
  assert.equal(args.includes('--model'), false);
});

test('preflight (plan) output surfaces tier, tierReason, and the required explicit model as advisory metadata', async t => {
  const root = await fixture(t);
  const report = await preflightProject(root, manifest([job({ tier: 'expensive', tierReason: 'Concurrency: new async retry queue.', model: 'claude-sonnet-4-6' })]));
  assert.equal(report.jobs[0].tier, 'expensive');
  assert.equal(report.jobs[0].tierReason, 'Concurrency: new async retry queue.');
  assert.equal(report.jobs[0].model, 'claude-sonnet-4-6');
});

test('preflight (plan) output reports null tier for a manifest that does not use it', async t => {
  const root = await fixture(t);
  const report = await preflightProject(root, manifest());
  assert.equal(report.jobs[0].tier, null);
  assert.equal(report.jobs[0].tierReason, null);
});

test('inspect output surfaces tier, tierReason, and the explicit model per job', async t => {
  const root = await fixture(t);
  const { spawn } = await import('node:child_process');
  const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`;
  const fake = script => (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
  const state = await runManifest(root, manifest([job({ tier: 'mid', model: 'claude-haiku-4-5' })]), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated'); ${done}`) });
  const report = await inspectRun(root, state.id);
  assert.deepEqual(report.jobs, [{ id: 'writer', agent: 'claude', model: 'claude-haiku-4-5', tier: 'mid', tierReason: null, status: 'complete', result: null, transcript: 'saved', costUsd: null, costPer1kOutputTokens: null, tokens: null, modelsSeen: [], modelMismatch: false }]);
});
