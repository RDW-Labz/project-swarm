// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest } from '../tools/swarm.mjs';
import { REPORT_PROMPT_LINE } from '../tools/reports.mjs';

const exec = promisify(execFile);
const env = { SWARM_CONFIG: process.env.SWARM_CONFIG };

async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-short-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  env.SWARM_SPEND_DIR = path.join(root, '.swarm/spend');
  await fs.writeFile(path.join(root, 'input.txt'), 'x\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'input.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'f']);
  return root;
}

test('API lanes never get the CLI "finish with one JSON line" report instruction; the short report rides in the envelope', async t => {
  const root = await repo(t);
  const bodies = [];
  const reply = { done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/a.txt', content: 'a\n' }], edits: [], result: { status: 'complete', summary: 'wrote it', files: ['out/a.txt'], risks: [], followups: [] } }) } };
  const state = await runManifest(root, {
    version: 1, report: 'short',
    jobs: [{ id: 'a', agent: 'ollama', model: 'm', prompt: 'Write out/a.txt', context: ['input.txt'], outputs: ['out/a.txt'], timeoutMs: 5000 }],
  }, { env, id: 'short-1', fetchImpl: async (url, options) => { bodies.push(options.body); return new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } }); } });
  assert.equal(state.status, 'complete');
  assert.equal(bodies.length, 1);
  assert.ok(!bodies[0].includes(REPORT_PROMPT_LINE.slice(0, 40)), 'the CLI report line is not in an API request');
});
