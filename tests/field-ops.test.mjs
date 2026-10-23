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
import {
  CUSTOMER_CONTENT_KEYS,
  aggregateFieldReport,
  assertReportHasNoCustomerContent,
  buildFieldReport,
  collectFieldBundleMetadata,
  runFieldReport,
} from '../tools/field-report.mjs';

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

const RAW_RULE_SNIPPET = 'Keep the useful rule text private';
const RAW_WHAT_SNIPPET = 'A field observation';

function walkKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      walkKeys(child, keys);
    }
  }
  return keys;
}

test('field report aggregates pushed and local export metadata across machines', async () => {
  const source = await fixture();
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'field-ops-report-'));
  const data = await exportFieldData(source, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const bundle = bundleForPush(data);
  await writeFieldExport(source, bundle);
  await pushFieldBundle(source, {
    bundle,
    send: localFieldBundleTransport(dest),
  });
  const { records: localRecords } = await collectFieldBundleMetadata(source);
  const { records: remoteRecords } = await collectFieldBundleMetadata(dest);
  assert.equal(localRecords.length, 1);
  assert.equal(remoteRecords.length, 1);
  assert.equal(localRecords[0].source, 'exports');
  assert.equal(remoteRecords[0].source, 'inbox');
  const report = aggregateFieldReport([...localRecords, ...remoteRecords], {
    now: new Date('2026-10-22T09:00:00.000Z'),
  });
  assert.equal(report.bundleCount, 2);
  assert.equal(report.sources.exports, 1);
  assert.equal(report.sources.inbox, 1);
  assert.equal(report.lessons.total, 2);
  assert.equal(report.lessons.byArea.tool, 2);
  assert.equal(report.lessons.byStatus.shipped, 2);
  assert.equal(report.runs.total, 2);
  assert.equal(report.runs.byLane.fast, 2);
  assert.equal(report.runs.jobCount, 2);
  assert.equal(report.projects[data.projectId].bundles, 2);
  assert.equal(report.timestamps.earliestExportedAt, data.exportedAt);
});

test('field report never includes raw customer content fields or lesson text', async () => {
  const source = await fixture();
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'field-ops-report-unsafe-'));
  const data = await exportFieldData(source, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const bundle = bundleForPush(data);
  await pushFieldBundle(source, { bundle, send: localFieldBundleTransport(dest) });
  const poisoned = {
    ...bundle,
    rule: RAW_RULE_SNIPPET,
    what: RAW_WHAT_SNIPPET,
    fix: 'Do not leak this fix text',
    lessons: [{ ...bundle.lessons[0], rule: RAW_RULE_SNIPPET, what: RAW_WHAT_SNIPPET }],
  };
  const inboxDir = path.join(dest, '.swarm', 'field', 'inbox');
  await fs.writeFile(
    path.join(inboxDir, '2026-10-21-poisoned.json'),
    `${JSON.stringify(poisoned)}\n`,
  );
  const report = await buildFieldReport(dest, { now: new Date('2026-10-22T09:00:00.000Z') });
  assertReportHasNoCustomerContent(report);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(RAW_RULE_SNIPPET), false);
  assert.equal(serialized.includes(RAW_WHAT_SNIPPET), false);
  const keys = walkKeys(report);
  for (const key of CUSTOMER_CONTENT_KEYS) {
    assert.equal(keys.has(key), false, `report must not contain customer content key ${key}`);
  }
  assert.equal(report.lessons.total >= 1, true);
});

test('field report buckets regex-valid but unknown area and lane as other', async () => {
  const unknownArea = 'acme-internal-proj';
  const unknownLane = 'acme-internal-proj';
  const report = aggregateFieldReport([{
    source: 'exports',
    projectId: 'a'.repeat(64),
    exportedAt: '2026-10-21T15:30:00.000Z',
    scannedClean: true,
    lessonCount: 1,
    runCount: 1,
    lessons: [{ id: 'L-1', area: unknownArea, status: 'shipped', ruleLength: 0, tags: [] }],
    runs: [{ lane: unknownLane, jobs: 1, pass: 1, fail: 0, medianMinutes: 1 }],
  }], { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.lessons.byArea.other, 1);
  assert.equal(report.lessons.byArea[unknownArea], undefined);
  assert.equal(report.runs.byLane.other, 1);
  assert.equal(report.runs.byLane[unknownLane], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(report.lessons.byArea, unknownArea), false);
  assert.equal(Object.prototype.hasOwnProperty.call(report.runs.byLane, unknownLane), false);
});

test('field report buckets unknown area, status, and lane as other in count maps', async () => {
  const maliciousKey = '__proto__';
  const report = aggregateFieldReport([{
    source: 'exports',
    projectId: 'a'.repeat(64),
    exportedAt: '2026-10-21T15:30:00.000Z',
    scannedClean: true,
    lessonCount: 1,
    runCount: 1,
    lessons: [{ id: 'L-1', area: maliciousKey, status: maliciousKey, ruleLength: 0, tags: [] }],
    runs: [{ lane: maliciousKey, jobs: 1, pass: 1, fail: 0, medianMinutes: 1 }],
  }], { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.lessons.byArea.other, 1);
  assert.equal(report.lessons.byArea[maliciousKey], undefined);
  assert.equal(report.lessons.byStatus.other, 1);
  assert.equal(report.lessons.byStatus[maliciousKey], undefined);
  assert.equal(report.runs.byLane.other, 1);
  assert.equal(report.runs.byLane[maliciousKey], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(report.lessons.byArea, maliciousKey), false);
});

test('field report records unparseable bundle files in skippedBundles', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const bundle = bundleForPush(data);
  const exportsDir = path.join(root, '.swarm', 'field', 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  await fs.writeFile(path.join(exportsDir, '2026-10-21-broken.json'), '{ not json\n');
  await writeFieldExport(root, bundle);
  const report = await buildFieldReport(root, { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.bundleCount, 1);
  assert.equal(report.skippedBundles.length, 1);
  assert.equal(report.skippedBundles[0].source, 'exports');
  assert.equal(report.skippedBundles[0].file, '2026-10-21-broken.json');
  assert.equal(report.skippedBundles[0].reason, 'field-report-bundle-unparseable');
});

test('field report excludes unscanned export bundles and reports the rejection', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  await writeFieldExport(root, data);
  const report = await buildFieldReport(root, { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.bundleCount, 0);
  assert.equal(report.lessons.total, 0);
  assert.equal(report.skippedBundles.length, 1);
  assert.equal(report.skippedBundles[0].source, 'exports');
  assert.equal(report.skippedBundles[0].reason, 'field-push-not-scanned-clean');
});

test('field report excludes unscanned inbox bundles and reports the rejection', async () => {
  const root = await fixture();
  const data = await exportFieldData(root, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  const inboxDir = path.join(root, '.swarm', 'field', 'inbox');
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(
    path.join(inboxDir, `2026-10-21-${data.projectId}.json`),
    `${JSON.stringify(data)}\n`,
  );
  const report = await buildFieldReport(root, { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.bundleCount, 0);
  assert.equal(report.skippedBundles.length, 1);
  assert.equal(report.skippedBundles[0].source, 'inbox');
  assert.equal(report.skippedBundles[0].reason, 'field-push-not-scanned-clean');
});

test('field report bundleCount counts only accepted bundles', async () => {
  const goodId = 'b'.repeat(64);
  const report = aggregateFieldReport([
    {
      source: 'exports',
      projectId: goodId,
      exportedAt: '2026-10-21T15:30:00.000Z',
      scannedClean: true,
      lessonCount: 0,
      runCount: 0,
      lessons: [],
      runs: [],
    },
    {
      source: 'exports',
      projectId: 'not-a-hash',
      exportedAt: '2026-10-21T15:30:00.000Z',
      scannedClean: true,
      lessonCount: 0,
      runCount: 0,
      lessons: [],
      runs: [],
    },
  ], { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.bundleCount, 1);
  assert.equal(report.sources.exports, 1);
});

test('runFieldReport writes aggregate file and stays metadata-only', async () => {
  const source = await fixture();
  const data = await exportFieldData(source, { now: new Date('2026-10-21T15:30:00.000Z'), projectId: 'abcdef12' });
  await writeFieldExport(source, bundleForPush(data));
  const report = await runFieldReport(source, { now: new Date('2026-10-22T09:00:00.000Z') });
  assert.equal(report.bundleCount, 1);
  const reportFile = path.join(source, '.swarm', 'field', 'reports', '2026-10-22-aggregate.json');
  const stored = JSON.parse(await fs.readFile(reportFile, 'utf8'));
  assertReportHasNoCustomerContent(stored);
  const stat = await fs.stat(reportFile);
  assert.equal(stat.mode & 0o777, 0o600);
});
