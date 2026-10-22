import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runScopeCommand } from '../tools/scope-commands.mjs';
import { createLedger, writeLedger } from '../tools/tickets.mjs';

const put = async (root, file, value) => {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
};

const ticket = (extra = {}) => ({
  id: 'T-8005',
  title: 'Review recorder lane',
  type: 'build',
  epic: 'E',
  scopeRefs: ['R-001'],
  acceptance: ['the recorder stores the reviewer'],
  files: ['src/target.mjs'],
  tests: [],
  context: [],
  contracts: [],
  dependsOn: [],
  size: 'S',
  risk: 'low',
  sensitive: false,
  status: 'review',
  runId: 'source',
  ...extra,
});

const project = async (t, extra = {}) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'review-lanes-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeLedger(root, createLedger({ scope: { name: 'Review lanes', version: 1, hash: 'scope-hash' }, tickets: [ticket(extra)] }));
  return root;
};

const writeSecurityRun = async (root, { runId, agent, model, response }) => {
  const jobId = `sec-review-${runId}`;
  await put(root, `.swarm/security-reviews/${runId}.hashes.json`, JSON.stringify({ 'T-8005': 'source-hash' }));
  await put(root, `.swarm/runs/${runId}/state.json`, JSON.stringify({ id: runId, jobs: [{ id: jobId, status: 'complete', agent, model }] }));
  await put(root, `.swarm/runs/${runId}/${jobId}/response.txt`, `${JSON.stringify({ reviews: [{ ticket: 'T-8005', verdict: 'pass', findings: [] }] })}\n${response ?? ''}`);
};

const writeAcceptanceRun = async (root, { runId, agent, model, response }) => {
  const jobId = `acc-review-${runId}`;
  await put(root, `.swarm/acceptance-reviews/${runId}.hashes.json`, JSON.stringify({
    nonce: 'review-nonce',
    tickets: { 'T-8005': { filesHash: 'source-hash', lines: [1], lineHashes: { 1: 'line-hash' } } },
  }));
  await put(root, `.swarm/runs/${runId}/manifest.json`, JSON.stringify({ version: 1, jobs: [{ id: jobId, prompt: 'review review-nonce' }] }));
  await put(root, `.swarm/runs/${runId}/state.json`, JSON.stringify({ id: runId, jobs: [{ id: jobId, status: 'complete', agent, model }] }));
  await put(root, `.swarm/runs/${runId}/${jobId}/response.txt`, `${JSON.stringify({ acceptance: [{ ticket: 'T-8005', lines: [{ n: 1, verdict: 'pass', evidence: 'src/target.mjs is present' }] }] })}\n${response ?? ''}`);
};

const lastEvent = async (root, event) => {
  const text = await fs.readFile(path.join(root, '.swarm/project/tickets.log'), 'utf8');
  return JSON.parse(text.trim().split('\n').filter(line => line.includes(`"event":"${event}"`)).at(-1));
};

for (const reviewer of [
  { name: 'anthropic claude opus', agent: 'anthropic', model: 'claude-opus-5-5' },
  { name: 'claude opus', agent: 'claude', model: 'opus' },
]) {
  test(`security verdict records ${reviewer.name}`, async t => {
    const root = await project(t, { sensitive: true });
    await writeSecurityRun(root, { runId: `security-${reviewer.agent}`, ...reviewer });
    const result = await runScopeCommand(root, 'scope', ['security-review', `security-${reviewer.agent}`]);
    assert.equal(result.exitCode, 0, result.stdout);
    const records = JSON.parse(await fs.readFile(path.join(root, '.swarm/security-reviews/records.json'), 'utf8'));
    assert.deepEqual(records.tickets['T-8005'].reviewer, { agent: reviewer.agent, model: reviewer.model });
    assert.deepEqual((await lastEvent(root, 'security-review')).reviewer, { agent: reviewer.agent, model: reviewer.model });
  });
}

for (const reviewer of [
  { name: 'codex', agent: 'codex', model: 'gpt-5' },
  { name: 'anthropic haiku', agent: 'anthropic', model: 'claude-haiku-5-5' },
]) {
  test(`security refuses ${reviewer.name}`, async t => {
    const root = await project(t, { sensitive: true });
    await writeSecurityRun(root, { runId: `security-refused-${reviewer.agent}`, ...reviewer });
    const result = await runScopeCommand(root, 'scope', ['security-review', `security-refused-${reviewer.agent}`]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /accepted reviewers: .*claude\/opus.*anthropic\/claude-opus/);
  });
}

for (const reviewer of [
  { name: 'codex', agent: 'codex', model: 'gpt-5' },
  { name: 'cursor', agent: 'cursor', model: 'cursor-model' },
]) {
  test(`acceptance verdict records ${reviewer.name}`, async t => {
    const root = await project(t);
    await writeAcceptanceRun(root, { runId: `acceptance-${reviewer.agent}`, ...reviewer });
    const result = await runScopeCommand(root, 'scope', ['acceptance-review', `acceptance-${reviewer.agent}`]);
    assert.equal(result.exitCode, 0, result.stdout);
    const records = JSON.parse(await fs.readFile(path.join(root, '.swarm/acceptance-reviews/records.json'), 'utf8'));
    assert.deepEqual(records.tickets['T-8005'].reviewer, { agent: reviewer.agent, model: reviewer.model });
    assert.deepEqual((await lastEvent(root, 'acceptance-review')).reviewer, { agent: reviewer.agent, model: reviewer.model });
  });
}

test('acceptance refuses openrouter', async t => {
  const root = await project(t);
  await writeAcceptanceRun(root, { runId: 'acceptance-openrouter', agent: 'openrouter', model: 'claude-opus-5-5' });
  const result = await runScopeCommand(root, 'scope', ['acceptance-review', 'acceptance-openrouter']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /accepted reviewers: .*codex\/\<non-empty model\>.*cursor\/\<non-empty model\>/);
});
