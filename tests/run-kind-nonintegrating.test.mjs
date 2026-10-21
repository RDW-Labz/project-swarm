// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autopilotStep, decide } from '../tools/autopilot.mjs';
import { isNonIntegratingRun } from '../tools/run-kind.mjs';
import { validateManifest } from '../tools/swarm/core-31.mjs';
import { appendEvent } from '../tools/journal.mjs';

const NOW = Date.parse('2030-03-01T12:00:00.000Z');

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-kind-'));
  await fs.mkdir(path.join(dir, '.swarm', 'project'), { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('isNonIntegratingRun accepts state flag, manifest integrate false, and legacy id patterns', () => {
  assert.equal(isNonIntegratingRun({ id: 'doctor-smoke-1', nonIntegrating: true }, null), true);
  assert.equal(isNonIntegratingRun({ id: 'wave-1' }, { version: 1, jobs: [{ id: 'j', agent: 'auto', model: 'm', prompt: 'p', context: [], outputs: ['a.txt'] }], integrate: false }), true);
  assert.equal(isNonIntegratingRun({ id: 'doctor-probe-abc' }, null), true);
  assert.equal(isNonIntegratingRun({ id: 'lane-test-1' }, null), true);
  assert.equal(isNonIntegratingRun({ id: 'lane-smoke-2' }, null), true);
  assert.equal(isNonIntegratingRun({ id: 'bakeoff-x' }, null), true);
  assert.equal(isNonIntegratingRun({ id: 'eval-fixture' }, null), true);
  assert.equal(isNonIntegratingRun({ id: 'wave-1' }, { version: 1, jobs: [{ id: 'doctor-smoke', agent: 'auto', model: 'm', prompt: 'p', context: [], outputs: ['a.txt'] }] }), true);
  assert.equal(isNonIntegratingRun({ id: 'wave-2' }, null), false);
});

test('validateManifest accepts integrate false', () => {
  const manifest = validateManifest({
    version: 1,
    integrate: false,
    jobs: [{
      id: 'job-1',
      agent: 'codex',
      model: 'gpt-5',
      prompt: 'do work',
      context: ['a.txt'],
      outputs: ['b.txt'],
    }],
  });
  assert.equal(manifest.integrate, false);
});

test('smoke and probe runs never raise complete-but-not-integrated blockers; normal runs still do', async t => {
  const root = await tempRoot(t);
  const { appendIntegrateBlockerIfNeeded, readJournal: loadJournal } = await import('../tools/journal.mjs');
  const baseDeps = {
    loadRuns: async () => [],
    readJournal: async () => loadJournal(root, { limit: Infinity }),
    appendEvent: async (r, event) => appendEvent(r, event, { now: () => NOW }),
    appendIntegrateBlockerIfNeeded,
    readPlan: async () => null,
    checkout: async () => ({ branch: 'main', dirty: false }),
  };
  for (const id of ['doctor-smoke-1', 'lane-test-9']) {
    const deps = {
      ...baseDeps,
      loadRuns: async () => [{ id, status: 'complete', integrated: false, integrable: true }],
    };
    const step = await autopilotStep(root, deps, { now: () => NOW, memory: new Set() });
    assert.equal(step.blocked.length, 0, id);
    assert.equal(decide({ id, status: 'complete', integrated: false, integrable: true }, { now: NOW, events: [] }), null);
  }
  const normal = await autopilotStep(root, {
    ...baseDeps,
    loadRuns: async () => [{ id: 'wave-1', status: 'complete', integrated: false, integrable: true }],
    checkout: async () => ({ branch: 'main', dirty: false }),
  }, { now: () => NOW, memory: new Set() });
  assert.ok(normal.blocked.includes('integrate-checkout-wave-1'));
});
