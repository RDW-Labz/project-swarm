// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  dependencyFieldsChanged,
  skipsDependencyAuditForFile,
  filterNewVulnerabilities,
} from '../tools/dependency-diff.mjs';
import { runSecurityGate } from '../tools/security-gate.mjs';

const NOW = Date.parse('2025-01-01T00:00:00Z');
const noFetch = async () => { throw new Error('no fetch expected'); };
const jsonRes = (body, status = 200) => ({ status, ok: status < 300, json: async () => body });
const meta = (license) => ({
  time: { created: new Date(NOW - 500 * 864e5).toISOString() },
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': { license } },
});
const registry = (m, downloads = 100000) => async (url) => (new URL(url).hostname === 'api.npmjs.org' ? jsonRes({ downloads }) : jsonRes(m));

test('scripts-only change skips dependency-field comparison', () => {
  const before = JSON.stringify({ scripts: { test: 'node old.js' }, version: '1.0.0' });
  const after = JSON.stringify({ scripts: { test: 'node new.js' }, version: '1.0.0' });
  assert.equal(dependencyFieldsChanged(before, after), false);
  assert.equal(skipsDependencyAuditForFile('package.json', before, after), true);
});

test('adding a dev dependency does not skip', () => {
  const before = JSON.stringify({ devDependencies: { eslint: '^8.0.0' } });
  const after = JSON.stringify({ devDependencies: { eslint: '^8.0.0', prettier: '^3.0.0' } });
  assert.equal(dependencyFieldsChanged(before, after), true);
});

test('a postinstall script change does not skip', () => {
  const before = JSON.stringify({ scripts: { test: 'vitest' } });
  const after = JSON.stringify({ scripts: { test: 'vitest', postinstall: 'node setup.js' } });
  assert.equal(dependencyFieldsChanged(before, after), true);
});

test('overrides change does not skip', () => {
  const before = JSON.stringify({ overrides: { lodash: '4.17.21' } });
  const after = JSON.stringify({ overrides: { lodash: '4.17.22' } });
  assert.equal(dependencyFieldsChanged(before, after), true);
});

test('version bump alone skips', () => {
  const before = JSON.stringify({ name: 'app', version: '1.0.0' });
  const after = JSON.stringify({ name: 'app', version: '1.0.1' });
  assert.equal(dependencyFieldsChanged(before, after), false);
});

test('a lockfile change does not skip audit for the lock path', () => {
  assert.equal(skipsDependencyAuditForFile('package-lock.json', '{}', '{"lockfileVersion":3}'), false);
});

test('unparsable input does not skip', () => {
  assert.equal(dependencyFieldsChanged('{', '{"name":"x"}'), true);
  assert.equal(dependencyFieldsChanged('{"name":"x"}', 'not json'), true);
});

test('filterNewVulnerabilities drops findings already on the base tree', () => {
  const shared = { name: 'lodash', severity: 'high', id: 'GHSA-1' };
  const onlyNew = { name: 'left-pad', severity: 'high', id: 'GHSA-2' };
  const filtered = filterNewVulnerabilities([shared, onlyNew], [shared]);
  assert.deepEqual(filtered, [onlyNew]);
});

test('queue audit does not block on a finding present at base', async () => {
  const auditPayload = {
    vulnerabilities: {
      lodash: {
        name: 'lodash',
        severity: 'high',
        via: [{ source: 1001, severity: 'high' }],
      },
    },
  };
  const exec = async (argv) => {
    if (argv[0] === 'npm' && argv[1] === 'audit') {
      return { exitCode: 1, stdout: JSON.stringify(auditPayload) };
    }
    throw new Error(`unexpected exec ${argv.join(' ')}`);
  };
  const root = await mkdtemp(path.join(os.tmpdir(), 'swarm-dep-diff-'));
  try {
    const prev = JSON.stringify({ dependencies: { lodash: '^4.17.0' } });
    const next = JSON.stringify({ dependencies: { lodash: '^4.17.21' } });
    await writeFile(path.join(root, 'package-lock.json'), '{}');
    const gate = await runSecurityGate({
      changes: [{ file: 'package.json', bytes: Buffer.from(next), previous: Buffer.from(prev) }],
      policy: { requireVulnerabilityScan: true },
      exec,
      fetchImpl: registry(meta('MIT')),
      cwd: root,
      now: () => NOW,
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.blocks.some((b) => b.check === 'vulnerability'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scripts-only package.json skips vulnerability check in the gate', async () => {
  const before = JSON.stringify({ scripts: { build: 'tsc' }, version: '1.0.0' });
  const after = JSON.stringify({ scripts: { build: 'tsc -b' }, version: '1.0.0' });
  const gate = await runSecurityGate({
    changes: [{ file: 'package.json', bytes: Buffer.from(after), previous: Buffer.from(before) }],
    policy: { requireVulnerabilityScan: true },
    exec: async () => { throw new Error('no scanners'); },
    fetchImpl: noFetch,
    now: () => NOW,
  });
  assert.equal(gate.checked.includes('vulnerability'), false);
  assert.ok(gate.skipped.some((s) => s.includes('dependency fields unchanged; audit skipped')));
});
