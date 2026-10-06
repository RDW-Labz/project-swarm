// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('AG historical dispositions remain under 1.47.0 while active release pins advance', async () => {
  const files = await Promise.all([
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'docs/lessons.md',
    'README.md',
    'skills/project-swarm/SKILL.md',
    'templates/coordination/CONTRACT.md',
    'docs/providers.md',
    'docs/setup.md',
    'docs/manifest-reference.md',
    'docs/verification.md',
  ].map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')]));
  const text = Object.fromEntries(files);
  const pkg = JSON.parse(text['package.json']);
  const lock = JSON.parse(text['package-lock.json']);
  assert.equal(pkg.version, '1.50.0');
  assert.equal(lock.version, '1.50.0');
  assert.equal(lock.packages[''].version, '1.50.0');

  assert.match(text['CHANGELOG.md'], /^# Changelog\n\n## 1\.50\.0\n/);
  const current = text['CHANGELOG.md'].split('## 1.47.0\n')[1].split('\n## 1.46.1\n')[0];
  const currentBullets = current.split('\n').filter(line => line.startsWith('- '));
  assert.equal(currentBullets.length, 9);
  for (const lesson of [343, 345, 348, 351, 352, 353, 354, 355]) {
    assert.ok(current.includes(`(lesson ${lesson})`), `missing lesson ${lesson} in current release`);
  }
  assert.match(current, /lesson 356/);

  const historicalStart = text['CHANGELOG.md'].indexOf('## 1.46.1\n');
  const historicalEnd = text['CHANGELOG.md'].indexOf('\n## ', historicalStart + 1);
  const historical = text['CHANGELOG.md'].slice(historicalStart, historicalEnd);
  const historicalBullets = historical.split('\n').filter(line => line.startsWith('- '));
  assert.equal(historicalBullets.length, 3);
  for (const [index, lesson] of [347, 349, 350].entries()) {
    assert.ok(historicalBullets[index].endsWith(`(lesson ${lesson})`));
  }

  for (const [id, phrase] of [
    [343, 'Vendored runtime dependencies need coverage.'],
    [345, 'Externally validated values need an accepting rule.'],
    [348, 'A human-review hold survives green checks.'],
    [351, 'Exploratory work needs an honest file scope.'],
    [352, 'Build tools need durable storage and availability checks.'],
    [353, 'Test caches need narrow write access.'],
    [354, 'A retry needs evidence and a fresh result.'],
    [355, 'A mutant must defeat every effective writer.'],
  ]) {
    assert.equal((text['docs/lessons.md'].match(new RegExp(`^${id}\\. `, 'gm')) ?? []).length, 1);
    assert.ok(text['docs/lessons.md'].includes(`${id}. **${phrase}`));
  }
  assert.match(text['docs/lessons.md'], /^356\. \*\*Design-only jobs should not be blocked by sandbox tests\./m);

  assert.match(text['README.md'], /outside the project root by default/);
  assert.match(text['README.md'], /worktreesOutsideRoot: false/);
  assert.match(text['README.md'], /vendored-core-missing-runtime-wheels/);
  assert.match(text['skills/project-swarm/SKILL.md'], /v1\.48\.0/);
  assert.match(text['templates/coordination/CONTRACT.md'], /\| value \| consumer \| validated-by \(file:line or existing example\) \|/);
  assert.match(text['docs/setup.md'], /worktreesOutsideRoot/);
  assert.match(text['docs/manifest-reference.md'], /`scope`.*"open"/);
  for (const code of ['scope-open-invalid', 'scope-open-path', 'scope-open-too-large', 'narrow-output-scope', 'toolchain-missing', 'rerun-flaky-ci-ineligible']) {
    assert.match(text['docs/manifest-reference.md'], new RegExp(code));
  }
  assert.match(text['docs/manifest-reference.md'], /toolchain-inventory-invalid/);
  assert.match(text['docs/manifest-reference.md'], /--rerun-flaky-ci 0\|1/);
  assert.match(text['docs/providers.md'], /vite-temp-not-writable/);
  assert.match(text['docs/verification.md'], /redundant-writer/);
});
