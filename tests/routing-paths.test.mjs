// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRoutingPath, ROUTING_RULE } from '../tools/routing-paths.mjs';
import { buildEvent, isHandBuilt } from '../tools/orchestrator-events.mjs';

test('isRoutingPath: routing files and everything else', () => {
  assert.ok(typeof ROUTING_RULE === 'string' && ROUTING_RULE.length > 20);
  for (const p of [
    'coordination/manifests/run-a.json',
    'coordination/Manifests/X.JSON',
    'HANDOFF.md',
    'coordination/HANDOFF.md',
    'coordination/TASK.md',
    'build-plan.md',
    'coordination/build-plan.md',
    'coordination/HANDOFF.previous.md',
    'coordination/HANDOFF.previous-2.md',
    'docs/state/usage-ledger.md',
    'docs/state/eval-scores.ndjson',
    'coordination/swarm-lessons.jsonl',
  ]) assert.equal(isRoutingPath(p), true, p);
  for (const p of [
    'tools/swarm.mjs',
    'tests/x.test.mjs',
    'docs/new-project.md',
    'package.json',
    'coordination/manifests/../../tools/a.mjs',
    'coordination/manifests/foo.txt',
    'docs/state/other.md',
    'src/HANDOFF.md',
  ]) assert.equal(isRoutingPath(p), false, p);
});

test('isHandBuilt and buildEvent respect routing and shell write filters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const memDir = path.join(home, '.claude', 'projects', 'proj', 'memory');
  await fs.mkdir(memDir, { recursive: true });

  assert.equal(isHandBuilt('Write', 'coordination/manifests/a.json'), false);
  assert.equal(isHandBuilt('Write', 'tools/swarm.mjs'), true);

  const base = { session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'x' } };
  const ev = (writes) => buildEvent('pre', base, {
    root,
    now: () => Date.UTC(2026, 9, 20, 12, 0, 0),
    analyze: () => ({ writes, git: [], inline: false, unknown: false }),
  });

  assert.equal(ev(['coordination/manifests/a.json']).hb, undefined);
  assert.deepEqual(ev(['coordination/manifests/a.json']).bf, ['coordination/manifests/a.json']);
  assert.equal(ev(['tools/a.mjs']).hb, 1);
  assert.equal(ev(['a b']).hb, 1);
  assert.equal(ev(['']).hb, undefined);
  const outside = path.join(os.tmpdir(), 'outside-swarm', 'nope.txt');
  assert.equal(ev([outside]).hb, undefined);
  assert.equal(ev([path.join(memDir, 'n.md')]).hb, undefined);
});
