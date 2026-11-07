// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateManifest, validateProject } from '../tools/swarm.mjs';
import { executeApi } from '../tools/api-adapters.mjs';
import { applyJobType } from '../tools/job-types.mjs';

const exec = promisify(execFile);

const endpointFixture = (over = {}) => ({
  name: 'dev2',
  baseUrl: 'http://127.0.0.1:18000',
  model: 'demo-model',
  slots: 3,
  keychain: { service: 'project-swarm', account: 'local.dev2' },
  ...over,
});

const bearerValue = () => ['fake', 'local', 'value'].join('-');

test('validateManifest accepts a local job with cacheContext', () => {
  const job = {
    id: 'T-cache',
    agent: 'local',
    model: 'local:dev2',
    sensitive: false,
    prompt: 'Write tests.',
    context: ['package.json', 'src/widget.mjs'],
    outputs: ['tests/widget.test.mjs'],
    cacheContext: ['package.json'],
  };
  validateManifest({ version: 1, jobs: [job] });
});

test('validateManifest still refuses cacheContext on cursor', () => {
  const job = {
    id: 'T-cli',
    agent: 'cursor',
    model: 'composer',
    sensitive: false,
    prompt: 'Write tests.',
    context: ['package.json', 'src/widget.mjs'],
    outputs: ['tests/widget.test.mjs'],
    cacheContext: ['package.json'],
  };
  assert.throws(
    () => validateManifest({ version: 1, jobs: [job] }),
    { code: 'cache-context-invalid' },
  );
});

test('validateProject routes a test-type ticket job with cacheContext to local', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-cache-route-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  await fs.promises.writeFile(path.join(root, 'src/widget.mjs'), 'export const x = 1;\n');
  await fs.promises.writeFile(path.join(root, 'tests/widget.test.mjs'), 'export {};\n');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);

  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-cache-route-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [endpointFixture()] } },
  }));

  let job = {
    id: 'T-0153',
    agent: 'auto',
    type: 'test',
    sensitive: false,
    prompt: 'Add a regression test for widget.',
    context: ['package.json', 'src/widget.mjs'],
    outputs: ['tests/widget.test.mjs'],
    cacheContext: ['package.json'],
  };
  ({ job } = applyJobType(job));

  const result = await validateProject(root, { version: 1, jobs: [job] }, {
    env: { SWARM_CONFIG: configPath, PATH: process.env.PATH },
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.routes[0].agent, 'local');
  assert.match(result.routes[0].model, /^local:/);
});

test('executeApi local request omits cache_control even with cacheContext on the job', async () => {
  const material = bearerValue();
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-cache-cfg-')), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    lanes: { local: { endpoints: [endpointFixture()] } },
  }));
  const answer = { summary: 'ok', files: [], edits: [] };
  let body;
  await executeApi(
    {
      id: 'j-cache',
      agent: 'local',
      model: 'local:dev2',
      sensitive: false,
      prompt: 'hi',
      context: ['package.json'],
      outputs: [],
      cacheContext: ['package.json'],
    },
    [{ path: 'package.json', content: '{"name":"x"}' }],
    {
      env: { SWARM_CONFIG: configPath },
      readLocal: () => material,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new Response(JSON.stringify({
            model: 'demo-model',
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
          })).body,
        };
      },
    },
  );
  assert.equal(typeof body.messages[1].content, 'string');
  assert.ok(!JSON.stringify(body).includes('cache_control'));
});
