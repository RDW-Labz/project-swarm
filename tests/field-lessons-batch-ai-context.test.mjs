// SPDX-License-Identifier: Apache-2.0
// Focused coverage for lessons 362, 364, and 379.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  missingMechanismWarnings,
  previewHarnessWarnings,
} from '../tools/context-check.mjs';
import {
  CODEX_OWNERSHIP_LINE,
  codexMessage,
} from '../tools/codex-adapter.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-context-ai-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('L362 warns deterministically when rendered UI roots have no preview harness check', async t => {
  const root = await fixture(t);
  const job = {
    id: 'ui',
    outputs: ['styles/chat.css', 'src/components/Chat.jsx'],
    previewViews: ['chat'],
  };

  const warnings = previewHarnessWarnings(root, job, []);

  assert.deepEqual(warnings, [{
    code: 'preview-harness-missing',
    jobId: 'ui',
    outputs: ['src/components/Chat.jsx', 'styles/chat.css'],
    views: ['chat'],
    message: 'job ui changes rendered UI roots (src/components/Chat.jsx, styles/chat.css); configure a preview-harness check covering views: chat',
  }]);
});

test('L362 warns only for uncovered views and accepts a preview harness covering every affected view', async t => {
  const root = await fixture(t);
  const job = { id: 'ui', outputs: ['src/components/Chat.jsx'], previewViews: ['chat', 'inbox'] };
  const partial = previewHarnessWarnings(root, job, [{
    name: 'preview-harness',
    argv: ['npm', 'run', 'preview-harness', '--', 'chat'],
  }]);
  assert.deepEqual(partial, [{
    code: 'preview-harness-coverage',
    jobId: 'ui',
    outputs: ['src/components/Chat.jsx'],
    views: ['inbox'],
    message: 'job ui preview-harness check does not cover views: inbox',
  }]);
  assert.deepEqual(previewHarnessWarnings(root, job, [{
    name: 'preview-harness',
    argv: ['npm', 'run', 'preview-harness', '--', 'chat', 'inbox'],
  }]), []);
});

test('L364 gives Codex the exact ownership instruction when CHANGELOG or active version files are omitted', () => {
  const activeVersionFiles = ['package.json', 'package-lock.json'];
  const omitted = codexMessage(
    { id: 'build', prompt: 'Implement the fix.', context: [], outputs: ['tools/fix.mjs'] },
    { versionFiles: activeVersionFiles },
  );
  assert.ok(omitted.includes(CODEX_OWNERSHIP_LINE.trim()));
  assert.ok(omitted.indexOf(CODEX_OWNERSHIP_LINE.trim()) < omitted.indexOf('TASK:'));

  const owned = codexMessage({
    id: 'release', prompt: 'Prepare the release.', context: [],
    outputs: ['CHANGELOG.md', 'package.json', 'package-lock.json'],
  }, { versionFiles: activeVersionFiles });
  assert.ok(!owned.includes(CODEX_OWNERSHIP_LINE.trim()));

  const customVersion = codexMessage(
    { id: 'build', prompt: 'Implement the fix.', context: [], outputs: ['tools/fix.mjs'] },
    { versionFiles: ['VERSION'] },
  );
  assert.ok(customVersion.includes(CODEX_OWNERSHIP_LINE.trim()));
});

test('L379 warns with only the missing identifier and preserves private prompt redaction', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/worker.mjs'), 'export function submitIntent() {}\n');
  const warnings = missingMechanismWarnings(root, {
    id: 'mechanism',
    prompt: 'Use existing `submitIntent` and `missingHook`; private token sk-live-should-not-leak.',
    privateData: true,
  }, ['src/worker.mjs']);

  assert.deepEqual(warnings, [{
    code: 'missing-mechanism',
    jobId: 'mechanism',
    token: 'missingHook',
    message: 'job mechanism names mechanism missingHook, but no repository file or symbol contains it',
  }]);
});
