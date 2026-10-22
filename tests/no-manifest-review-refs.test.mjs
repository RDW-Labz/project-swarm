// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = fileURLToPath(new URL('../tools', import.meta.url));
const securityGatePath = fileURLToPath(new URL('../tools/security-gate.mjs', import.meta.url));
const swarmPath = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function listToolSources() {
  const out = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.mjs')) out.push(full);
    }
  }
  await walk(toolsDir);
  return out;
}

const forbidden = [
  'manifest-review.mjs',
  'peekIntegrateManifestReviewContext',
  'setIntegrateManifestReviewContext',
  'attemptManifestReviewForGate',
  'runManifestReviewCommand',
  'manifestApproveActor',
  'agentManifestApproveRefusalMessage',
];

test('tools tree has no imports or mentions of manifest-review.mjs', async () => {
  const hits = [];
  for (const file of await listToolSources()) {
    const text = await fs.readFile(file, 'utf8');
    for (const needle of forbidden) {
      if (text.includes(needle)) hits.push(`${path.relative(toolsDir, file)}: ${needle}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('forgeable review record: security gate does not run autonomous manifest review', async () => {
  const text = await fs.readFile(securityGatePath, 'utf8');
  assert.doesNotMatch(text, /manifest-review\.mjs/);
  assert.doesNotMatch(text, /manifestReview/);
});

test('gate crash: security gate does not reassign policy or blocks after review', async () => {
  const text = await fs.readFile(securityGatePath, 'utf8');
  assert.doesNotMatch(text, /attemptManifestReviewForGate/);
  assert.doesNotMatch(text, /resolved\.policy/);
  assert.doesNotMatch(text, /resolved\.blocks/);
});

test('path-less blocks cleared other files: security gate does not filter blocks without path checks', async () => {
  const text = await fs.readFile(securityGatePath, 'utf8');
  assert.doesNotMatch(text, /blocks\.filter\(b=>!\(b\.check==='unsupported-manifest'/);
  assert.doesNotMatch(text, /blocks\.filter\(b=>!\(b\.check==='install-script'/);
});

test('swarm integrate has no manifest review command or review context hook', async () => {
  const text = await fs.readFile(swarmPath, 'utf8');
  assert.doesNotMatch(text, /swarm manifest review/);
  assert.doesNotMatch(text, /setIntegrateManifestReviewContext/);
  assert.doesNotMatch(text, /manifestReview/);
});
