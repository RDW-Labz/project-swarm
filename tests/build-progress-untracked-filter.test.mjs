// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProgress, offLedgerRunHref, OFF_LEDGER_LIST_ANCHOR_ID } from '../tools/build-progress.mjs';

const projectJsPath = new URL('../tools/watch-assets/project.js', import.meta.url);

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'build-progress-filter-')));
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify({
    version: 1,
    scope: { file: 'missing-scope.md', name: 'Filter fixture' },
    tickets: [],
    approved: { at: new Date(NOW - 1000).toISOString() },
  }));
  await fs.writeFile(path.join(root, 'history.ndjson'), '');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function run(root, id, state) {
  const dir = path.join(root, '.swarm', 'runs', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ id, status: 'complete', startedAt: new Date(NOW - 1000).toISOString(), ...state }));
}

test('off-ledger counts exclude smoke, probe, lane tests, and non-integrating runs', async t => {
  const root = await fixture(t);
  const job = id => ({ id, status: 'complete' });
  await run(root, 'smoke-run', { manifestFile: 'smoke.mjs', jobs: [job('smoke-job')] });
  await run(root, 'probe-run', { jobs: [job('probe-job')] });
  await run(root, 'lane-test-run', { jobs: [job('lane-test-job')] });
  await run(root, 'lane-bench-run', { jobs: [job('lane-bench-job')] });
  await run(root, 'doctor-run', { jobs: [job('doctor-job')] });
  await run(root, 'non-integrating', { nonIntegrating: true, jobs: [job('real-job')] });
  await run(root, 'manifest-run', { manifest: 'release.json', jobs: [job('real-job')] });

  const progress = await buildProgress({ root, projectId: 'filter-fixture', now: NOW, historyFile: path.join(root, 'history.ndjson') });
  assert.deepEqual(progress.untracked.runs.map(item => item.runId), ['manifest-run']);
  assert.equal(progress.untracked.jobs, 1);
  assert.deepEqual(progress.untracked.newest, [{ runId: 'manifest-run', name: 'manifest-run', startedAt: new Date(NOW - 1000).toISOString(), status: 'complete' }]);
  assert.equal(progress.untracked.listAnchorId, OFF_LEDGER_LIST_ANCHOR_ID);
  assert.equal(progress.untracked.countHref, `#${OFF_LEDGER_LIST_ANCHOR_ID}`);
  const manifest = progress.untracked.runs.find(item => item.runId === 'manifest-run');
  assert.ok(manifest);
  assert.equal(manifest.href, offLedgerRunHref('filter-fixture', 'manifest-run'));
  for (const excluded of ['smoke-run', 'probe-run', 'lane-test-run', 'lane-bench-run', 'doctor-run', 'non-integrating']) {
    assert.equal(progress.untracked.runs.some(item => item.runId === excluded), false);
  }
});

test('project.js links untracked count to the off-ledger list anchor', () => {
  const source = readFileSync(projectJsPath, 'utf8');
  assert.match(source, /untrackedCount\.setAttribute\('href',\s*untracked\.countHref/);
  assert.match(source, /offTitle\.id\s*=\s*listAnchor/);
  assert.match(source, /runLink\.setAttribute\('href',\s*run\.href/);
});
