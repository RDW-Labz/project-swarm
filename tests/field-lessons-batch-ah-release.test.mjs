// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function publicFiles() {
  const names = [
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'docs/lessons.md',
    'README.md',
    'skills/project-swarm/SKILL.md',
    'docs/manifest-reference.md',
    'templates/coordination/CONTRACT.md',
    'tests/field-lesson-t80-cli.test.mjs',
    'tests/field-lessons-batch-x.test.mjs',
    'tests/field-lessons-batch-ab-release.test.mjs',
    'tests/field-lessons-batch-ag-release.test.mjs',
  ];
  const entries = await Promise.all(names.map(async name => [name, await fs.readFile(path.join(root, name), 'utf8')]));
  return Object.fromEntries(entries);
}

test('AH release pins 1.50.0 and publishes five scrubbed lesson dispositions', async () => {
  const text = await publicFiles();
  const pkg = JSON.parse(text['package.json']);
  const lock = JSON.parse(text['package-lock.json']);
  assert.equal(pkg.version, '1.50.0');
  assert.equal(lock.version, '1.50.0');
  assert.equal(lock.packages[''].version, '1.50.0');

  const changelog = text['CHANGELOG.md'];
  assert.match(changelog, /^# Changelog\n\n## 1\.50\.0\n/);
  const current = changelog.split('## 1.48.0\n')[1].split('\n## 1.47.0\n')[0];
  const bullets = current.split('\n').filter(line => line.startsWith('- '));
  assert.equal(bullets.length, 5);
  for (const lesson of [357, 358, 359, 360, 361]) assert.ok(current.includes(`(lesson ${lesson})`));

  const expectedLessons = [
    '357. **Read-only questions need explicit routing.** Follow the selected tier and report any configured fallback before presenting its answer. An unsupported route must never silently choose another provider.',
    '358. **Directory references can describe real context.** Accept directory and glob references when they match carried files. Keep refusing real inputs that the worker will not receive.',
    '359. **Decision values need source evidence.** Pin fixed constants with literal expected values in tests and quote the source values in review summaries. Warn when a held summary names a value absent from the added change.',
    '360. **Tests need durable inputs.** Keep runtime and test fixtures in tracked locations that survive a clean checkout. Refuse source and test references to temporary coordinator material and warn about scratch data in build context.',
    '361. **Progress timestamps must come from a clock.** Append progress notes with a tool-generated UTC timestamp. A generated timestamp describes when the note was recorded, not when an earlier event occurred.',
  ];
  for (const entry of expectedLessons) assert.equal((text['docs/lessons.md'].match(new RegExp(`^${entry.split('. ')[0]}\\. `, 'gm')) ?? []).length, 1);
  for (const entry of expectedLessons) assert.ok(text['docs/lessons.md'].includes(entry));

  const docs = [text['README.md'], text['skills/project-swarm/SKILL.md'], text['docs/manifest-reference.md']].join('\n');
  for (const phrase of [
    '--tier cheap|mid|expensive',
    'tiers.<tier>.fallback',
    'ask-agent-fallback',
    'ask-agent-fallback-unconfigured',
    'ask-route-invalid',
    'Native Codex read-only remains unsupported',
    'note [--file',
    'work-folder-reference',
    'work-folder-context',
    'decision-value-not-in-diff',
    'decision-value-diff-unavailable',
  ]) assert.ok(docs.includes(phrase), `missing public reference: ${phrase}`);
  assert.match(text['templates/coordination/CONTRACT.md'], /\| constant \| source file:line \| exact value and unit \| decision reference \| pinning test file and test name \|/);
  assert.match(text['templates/coordination/CONTRACT.md'], /Quote decision-fixed values from the source constant in the review summary; name the test that pins each value\. Do not copy numbers from the ticket\./);
});

test('AH retains historical AG dispositions while advancing active release pins', async () => {
  const text = await publicFiles();
  const changelog = text['CHANGELOG.md'];
  const historical = changelog.split('## 1.47.0\n')[1].split('\n## 1.46.1\n')[0];
  const bullets = historical.split('\n').filter(line => line.startsWith('- '));
  assert.equal(bullets.length, 9);
  for (const lesson of [343, 345, 348, 351, 352, 353, 354, 355]) assert.ok(historical.includes(`(lesson ${lesson})`));
  assert.ok(historical.includes('Worktree jobs now default outside the repository root'));
  assert.ok(historical.includes('Design-only Codex jobs are told to read and grep without tests or installs'));
  assert.match(historical, /\n\nDesign-only Codex jobs are told to read and grep without tests or installs; sandbox test failures do not block them\. \(lesson 356\)\n/);

  const expectedPins = {
    'README.md': '1.50.0',
    'skills/project-swarm/SKILL.md': '1.48.0',
    'tests/field-lesson-t80-cli.test.mjs': '1.50.0',
    'tests/field-lessons-batch-x.test.mjs': '1.50.0',
    'tests/field-lessons-batch-ab-release.test.mjs': '1.50.0',
    'tests/field-lessons-batch-ag-release.test.mjs': '1.50.0',
  };
  for (const [file, version] of Object.entries(expectedPins)) {
    assert.match(text[file], new RegExp(version.replaceAll('.', '\\.')));
  }
});
