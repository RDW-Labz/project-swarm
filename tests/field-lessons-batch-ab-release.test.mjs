// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('release: 1.53.0', () => {
  test('package.json, package-lock.json, and CHANGELOG.md agree on 1.53.0 while 1.46.1 history remains', async () => {
    const [pkgText, lockText, changelog] = await Promise.all(
      ['package.json', 'package-lock.json', 'CHANGELOG.md'].map(file => fs.readFile(path.join(root, file), 'utf8')),
    );
    const pkg = JSON.parse(pkgText);
    const lock = JSON.parse(lockText);
    assert.equal(pkg.version, '1.53.0');
    assert.equal(lock.version, '1.53.0');
    assert.equal(lock.packages[''].version, '1.53.0');
    assert.match(changelog, /^# Changelog\n\n## 1\.53\.0\n/);
    const section = changelog.split('## 1.46.1\n')[1].split('\n## ')[0];
    const bullets = section.split('\n').filter(line => line.startsWith('- '));
    assert.equal(bullets.length, 3);
    for (const [index, lesson] of [347, 349, 350].entries()) assert.ok(bullets[index].endsWith(`(lesson ${lesson})`));
  });

  test('the five release lessons name flags and warnings present in command source', async () => {
    const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    const heading = changelog.indexOf('## 1.44.0\n');
    const nextHeading = changelog.indexOf('\n## ', heading + 1);
    assert.ok(heading > -1);
    assert.ok(nextHeading > heading);
    assert.ok(changelog.slice(nextHeading).startsWith('\n## 1.43.0\n'));
    const section = changelog.slice(heading, nextHeading);
    const bullets = section.split('\n').filter(line => line.startsWith('- '));
    assert.equal(bullets.length, 5);
    for (const [index, lesson] of [327, 328, 330, 331, 332].entries()) {
      assert.ok(bullets[index].endsWith(`(lesson ${lesson})`), `lesson ${lesson}`);
    }
    for (const name of ['scaffold job --command', 'command-handler-not-in-job', '--accept-blocked', 'check-hit-swarm-dir', 'git-ignored-fixture', 'max-output-below-model-default']) {
      assert.ok(section.includes(name), `Missing release contract name: ${name}`);
    }
    const source = (await Promise.all(
      ['tools/swarm.mjs', 'tools/scaffold.mjs', 'tools/ship.mjs'].map(file => fs.readFile(path.join(root, file), 'utf8')),
    )).join('\n');
    const flags = [...section.matchAll(/--[a-z][a-z0-9-]*/g)].map(match => match[0]);
    const warnings = [...section.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map(match => match[1]);
    assert.ok(flags.length > 0);
    assert.ok(warnings.length > 0);
    for (const name of new Set([...flags, ...warnings])) {
      assert.ok(source.includes(name), `Release flag or warning missing from command source: ${name}`);
    }
  });
});
