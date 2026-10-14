import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflightProject, PREFLIGHT_THRESHOLDS } from '../tools/preflight.mjs';

const job = (id, fields = {}) => ({ id, agent: 'claude', model: 'sonnet', prompt: 'Implement the stated behavior and report its acceptance check.', context: [], outputs: [], ...fields });
const manifest = (...jobs) => ({ version: 1, concurrency: 2, jobs });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('finds stale-snapshot dependency even at concurrency one; same-job input/output is valid', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'contract.ts'), 'old contract');
  const input = { ...manifest(
    job('contract', { context: ['contract.ts'], outputs: ['contract.ts'] }),
    job('consumer', { context: ['contract.ts'], outputs: ['consumer.ts'] }),
  ), concurrency: 1 };
  const before = JSON.stringify(input);
  const report = await preflightProject(root, input);
  assert.equal(report.snapshotHazards.length, 1);
  assert.equal(report.snapshotHazards[0].writerJobId, 'contract');
  assert.equal(report.snapshotHazards[0].readerJobId, 'consumer');
  assert.match(report.snapshotHazards[0].message, /later run after integration/);
  assert.equal(report.reviewRequired, true);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(await fs.readdir(root), ['contract.ts']);
});

test('accounts for UTF-8 bytes, deduplicates within a job, and reports repeated copied context', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'contract.ts'), 'é');
  await fs.writeFile(path.join(root, 'existing.ts'), '12345');
  const report = await preflightProject(root, manifest(
    job('a', { context: ['contract.ts', 'existing.ts'], outputs: ['existing.ts', 'new.ts'] }),
    job('b', { context: ['contract.ts'] }),
  ));
  assert.equal(report.jobs[0].contextBytes, 7);
  assert.equal(report.totalContextBytes, 9);
  assert.deepEqual(report.jobs[0].largestContexts.map(file => file.path), ['existing.ts', 'contract.ts']);
  assert.deepEqual(report.jobs[0].files.find(file => file.path === 'new.ts'), { path: 'new.ts', bytes: 0, exists: false, context: false, output: true });
  assert.equal(report.repeatedContext.length, 1);
  assert.equal(report.repeatedContext[0].path, 'contract.ts');
  assert.equal(report.repeatedContext[0].copiedBytes, 4);
  assert.equal(report.repeatedContext[0].repeatedBytes, 2);
  assert.equal(report.reviewRequired, false);
  assert.ok(!JSON.stringify(report).includes('é'));
});

test('size and output warnings are advisory, use strict thresholds, and permit coherent large jobs', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(PREFLIGHT_THRESHOLDS.contextBytes, 'a'));
  const outputs = Array.from({ length: 5 }, (_, index) => `output${index}.txt`);
  const input = manifest(job('boundary', { context: ['large.txt'], outputs }));
  assert.deepEqual((await preflightProject(root, input)).advisories, []);
  await fs.appendFile(path.join(root, 'large.txt'), 'a');
  input.jobs[0].outputs.push('sixth.txt');
  const report = await preflightProject(root, input);
  assert.equal(report.validated, true);
  assert.equal(report.advisoryOnly, true);
  assert.deepEqual(report.advisories.map(item => item.code), ['review-output-scope', 'review-context-size']);
  assert.match(report.limitations[0], /do not measure semantic complexity/);
});

test('sorts equal-size files deterministically and counts existing outputs as copied context', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'z.txt'), '123');
  await fs.writeFile(path.join(root, 'a.txt'), 'abc');
  const input = manifest(job('one', { outputs: ['z.txt', 'a.txt'] }));
  const first = await preflightProject(root, input);
  assert.deepEqual(first, await preflightProject(root, input));
  assert.equal(first.totalContextBytes, 6);
  assert.deepEqual(first.jobs[0].largestContexts.map(file => file.path), ['a.txt', 'z.txt']);
});

test('fails closed for missing inputs, traversal, reserved paths, and invalid manifests', async t => {
  const root = await fixture(t);
  await assert.rejects(preflightProject(root, manifest(job('missing', { context: ['missing.txt'] }))), /Missing context/);
  for (const file of ['../escape', '/tmp/escape', '.env.local', '.git/config', '.swarm/state']) {
    await assert.rejects(preflightProject(root, manifest(job('unsafe', { outputs: [file] }))), /path/i);
  }
  await assert.rejects(preflightProject(root, manifest(job('a', { outputs: ['same.txt'] }), job('b', { outputs: ['same.txt'] }))), /collision/);
  await assert.rejects(preflightProject(root, { ...manifest(job('a')), concurrency: 513 }), /Concurrency/);
  assert.equal((await preflightProject(root, { ...manifest(job('accepted')), concurrency: 512 })).validated, true);
  assert.deepEqual(await fs.readdir(root), []);
});

test('refuses linked inputs and output parents without reading their targets', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'real'));
  await fs.writeFile(path.join(root, 'real', 'private.txt'), 'private contents');
  await fs.symlink(path.join(root, 'real'), path.join(root, 'linked'));
  await fs.symlink(path.join(root, 'real', 'private.txt'), path.join(root, 'input-link'));
  await assert.rejects(preflightProject(root, manifest(job('a', { context: ['input-link'] }))), /Symlink refused/);
  await assert.rejects(preflightProject(root, manifest(job('a', { outputs: ['linked/new.txt'] }))), /Symlink refused/);
  assert.deepEqual(await fs.readdir(path.join(root, 'real')), ['private.txt']);
});


test('CLI emits dependency advisories with exit zero and invalid paths with nonzero, without spawning', async t => {
 const root=await fixture(t);
 await fs.writeFile(path.join(root,'input.txt'),'fixture');
 const input=manifest(job('writer',{outputs:['input.txt']}),job('reader',{context:['input.txt']}));
 await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(input));
 const runner=fileURLToPath(new URL('../tools/swarm.mjs',import.meta.url));
 const invoke=()=>spawnSync(process.execPath,[runner,'--root',root,'preflight','plan.json'],{encoding:'utf8'});
 const advisory=invoke();assert.equal(advisory.status,0,advisory.stderr);
 const report=JSON.parse(advisory.stdout);assert.equal(report.reviewRequired,true);assert.equal(report.snapshotHazards.length,1);
 assert.deepEqual((await fs.readdir(root)).sort(),['input.txt','plan.json']);
 input.jobs[1].context=['.env.local'];await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(input));
 const invalid=invoke();assert.notEqual(invalid.status,0);assert.equal(JSON.parse(invalid.stderr).status,'error');
 assert.deepEqual((await fs.readdir(root)).sort(),['input.txt','plan.json']);
});
