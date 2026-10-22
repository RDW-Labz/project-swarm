// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFieldData, writeFieldExport } from '../tools/field-export.mjs';
import {
  assertScannedCleanBundle,
  bundleForPush,
  localFieldBundleTransport,
  pushFieldBundle,
} from '../tools/field-push.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-ops-'));
  const lessonDir = path.join(root, 'lessons', 'abcdef12');
  await fs.mkdir(lessonDir, { recursive: true });
  await fs.writeFile(path.join(lessonDir, 'L-0001.json'), JSON.stringify({
    id: 'L-0001', project: 'abcdef12', what: 'A field observation',
    rule: 'Keep the useful rule text private', fix: 'Use metadata only',
    stage: 'built', caughtBy: 'test', area: 'tool', status: 'shipped',
    version: '1.0.0', createdAt: '2026-10-21T12:00:00.000Z', tags: ['field', 'safe'],
  }));
  await fs.mkdir(path.join(root, '.swarm', 'runs', 'run-1'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', 'run-1', 'state.json'), JSON.stringify({
    lane: 'fast', jobs: [{ status: 'passed', durationMinutes: 2 }],
  }));
  return root;
}

test('refuses to push bundles that field export did not mark scanned-clean', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const file = await writeFieldExport(root, data);
  await assert.rejects(
    () => pushFieldBundle(root, { bundlePath: file, send: async () => {} }),
    error => error.code === 'field-push-not-scanned-clean',
  );
  await assert.rejects(
    () => assertScannedCleanBundle({ ...data, scannedClean: false }),
    error => error.code === 'field-push-not-scanned-clean',
  );
});

test('refuses directly supplied bundle without scanned-clean marker and does not deliver', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  let delivered = false;
  await assert.rejects(
    () => pushFieldBundle(root, { bundle: data, send: async () => { delivered = true; } }),
    error => error.code === 'field-push-not-scanned-clean',
  );
  assert.equal(delivered, false);
});

test('refuses directly supplied bundle that fakes scanned-clean but fails re-scan', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const bundle = bundleForPush(data);
  bundle.probe = ['reach', '@', 'example', '.', 'test'].join('');
  let delivered = false;
  await assert.rejects(
    () => pushFieldBundle(root, { bundle, send: async () => { delivered = true; } }),
    error => error.code === 'field-push-unsafe' && error.findings.includes('email'),
  );
  assert.equal(delivered, false);
});

test('pushes a scanned-clean export bundle to another machine inbox', async () => {
  const source = await fixture();
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'field-ops-dest-'));
  const data = await exportFieldData(source, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const bundle = bundleForPush(data);
  const file = await writeFieldExport(source, bundle);
  const pushed = await pushFieldBundle(source, {
    bundlePath: file,
    send: localFieldBundleTransport(dest),
  });
  assert.equal(pushed.scannedClean, true);
  const expected = path.join(dest, '.swarm', 'field', 'inbox', `2026-10-21-${data.projectId}.json`);
  const text = await fs.readFile(expected, 'utf8');
  const stored = JSON.parse(text);
  assert.equal(stored.projectId, data.projectId);
  assert.equal(stored.scannedClean, true);
  assert.equal(stored.lessons.length, data.lessons.length);
  const stat = await fs.stat(expected);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('refuses scanned-clean marker when payload still fails secret scanning', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const bundle = bundleForPush(data);
  bundle.probe = ['reach', '@', 'example', '.', 'test'].join('');
  await assert.rejects(
    () => assertScannedCleanBundle(bundle),
    error => error.code === 'field-push-unsafe' && error.findings.includes('email'),
  );
});
