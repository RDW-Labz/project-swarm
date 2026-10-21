// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJournal } from '../tools/journal.mjs';
import { EVENTS_FILE } from '../tools/orchestrator-events.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');

async function temp(t, prefix = 'swarm-policy-cli-') {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function project(t) {
  const root = await temp(t);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  return root;
}

function run(root, home, args, extraEnv = {}) {
  return exec(process.execPath, [swarm, '--root', root, ...args], {
    env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG, ...extraEnv },
  });
}

function fail(root, home, args) {
  return run(root, home, args).then(
    () => assert.fail('expected failure'),
    error => error,
  );
}

test('policy CLI verbs: init, show, validate, path, check, run', async t => {
  const root = await project(t);
  const home = await temp(t, 'swarm-policy-home-');
  const configDir = path.join(home, 'cfg');
  const configFile = path.join(configDir, 'config.json');
  await fs.mkdir(configDir, { recursive: true });
  const env = { SWARM_CONFIG: configFile };

  const pathOut = await run(root, home, ['policy', 'path'], env);
  assert.equal(pathOut.stderr, '');
  assert.match(pathOut.stdout.trim(), /policy\.json$/);

  const init = await run(root, home, ['policy', 'init'], env);
  assert.match(init.stdout, /Wrote default policy/);
  const policyFile = path.join(configDir, 'policy.json');
  await fs.rm(policyFile, { force: true });

  const show = await run(root, home, ['policy', 'show'], env);
  assert.match(show.stdout, /Never auto-approved/);
  assert.match(show.stdout, /ticket-routine/);

  const validate = await run(root, home, ['policy', 'validate'], env);
  assert.match(validate.stdout, /ok/);

  const auto = await run(root, home, ['policy', 'check', 'ticket-retry', '--facts', '{}'], env);
  const autoDecision = JSON.parse(auto.stdout.trim());
  assert.equal(autoDecision.decision, 'auto-approve');
  assert.equal(autoDecision.rule, 'ticket-routine');
  const journal = await readJournal(root, { limit: 20, kinds: ['auto-decision'] });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].rule, 'ticket-routine');
  const eventsText = await fs.readFile(path.join(root, EVENTS_FILE), 'utf8');
  const events = eventsText.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.kind === 'auto-decision');
  assert.equal(events.length, 1);
  assert.equal(events[0].rule, 'ticket-routine');

  const mainFacts = JSON.stringify({ branch: 'main', allSwarmProduced: true });
  const owner = await fail(root, home, ['policy', 'check', 'commit-push-swarm-branch', '--facts', mainFacts], env);
  assert.equal(owner.code, 3);
  const ownerDecision = JSON.parse(owner.stdout.trim());
  assert.equal(ownerDecision.decision, 'needs-owner');

  const runOut = await run(root, home, ['policy', 'run'], env);
  assert.equal(runOut.stderr, '');
  const summary = JSON.parse(runOut.stdout.trim());
  assert.equal(typeof summary.decided, 'number');
  assert.equal(typeof summary.left, 'number');
});

test('policy unknown verb prints usage and exits 2', async t => {
  const root = await project(t);
  const home = await temp(t);
  const err = await fail(root, home, ['policy', 'nope']);
  assert.equal(err.code, 2);
  assert.match(err.stdout, /Usage: swarm policy show/);
});

test('budget set then show round-trips project over machine default', async t => {
  const root = await project(t);
  const home = await temp(t);
  const configFile = path.join(home, 'machine.json');
  await fs.writeFile(configFile, `${JSON.stringify({ dailyLimit: { usd: 20, mode: 'stop' } })}\n`);
  const env = { SWARM_CONFIG: configFile };

  const set = await run(root, home, ['budget', 'set', '--daily', '8', '--mode', 'notify'], env);
  assert.equal(set.stderr, '');
  const projectFile = path.join(root, '.swarm', 'project', 'daily-limit.json');
  const saved = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  assert.deepEqual(saved, { usd: 8, mode: 'notify' });

  const show = await run(root, home, ['budget', 'show', '--json'], env);
  const payload = JSON.parse(show.stdout);
  assert.equal(payload.dailyLimitUsd, 8);
  assert.equal(payload.dailyLimitMode, 'notify');
  assert.equal(payload.source, 'project');
  assert.equal(payload.machine.usd, 20);
});
