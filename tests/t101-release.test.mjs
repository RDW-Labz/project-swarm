// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillRoot = path.join(root, 'templates/coordination/skills');
const pins = [
  '6fd947921b935b7e1e69293a200400f0fdd5c15f',
  '153fc1b93de6584562765cdce299324e1ff9e661',
];

test('T101 release records the vendored skills and their attribution', async () => {
  const [pkgText, changelog, notice] = await Promise.all([
    fs.readFile(path.join(root, 'package.json'), 'utf8'),
    fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    fs.readFile(path.join(root, 'NOTICE'), 'utf8'),
  ]);
  assert.equal(JSON.parse(pkgText).version, '1.49.0');
  assert.match(changelog, /^# Changelog\n\n## 1\.49\.0\n/);
  const current = changelog.split('## 1.49.0\n')[1].split('\n## ')[0];
  assert.match(current, /MIT License/);
  for (const pin of pins) {
    assert.ok(current.includes(pin), `missing changelog pin ${pin}`);
    assert.ok(notice.includes(pin), `missing NOTICE pin ${pin}`);
  }

  const entries = (await fs.readdir(skillRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  assert.deepEqual(entries.sort(), ['code-review', 'diagnosing-bugs', 'resolving-merge-conflicts', 'tdd', 'writing-for-agents']);
  for (const name of entries) {
    await assert.doesNotReject(fs.access(path.join(skillRoot, name, 'LICENSE')), `${name} is missing LICENSE`);
  }
});
