// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createE2eDataTracker,
  cleanupE2eData,
  withE2eCleanup,
  pathAllowed,
} from '../tools/e2e-data-cleanup.mjs';

const tempBase = path.join('/var', 'swarm-e2e-temp');
const projectRoot = path.join('/var', 'swarm-e2e-project');

function deps() {
  const rmCalls = [];
  const dropCalls = [];
  const rm = async (target, options) => {
    rmCalls.push({ target, options });
  };
  const dropDb = async (name) => {
    dropCalls.push(name);
  };
  return { rm, dropDb, rmCalls, dropCalls };
}

test('pathAllowed accepts project root and temp base only', () => {
  assert.equal(pathAllowed(path.join(projectRoot, '.swarm', 'e2e', 'r1', 'x.db'), projectRoot, tempBase), true);
  assert.equal(pathAllowed(path.join(tempBase, 'swarm-ui-abc'), projectRoot, tempBase), true);
  assert.equal(pathAllowed('/etc/passwd', projectRoot, tempBase), false);
});

test('cleanup removes tracked temp dirs, e2e files, and databases', async () => {
  const { rm, dropDb, rmCalls, dropCalls } = deps();
  const tracker = createE2eDataTracker({ root: projectRoot, runId: 'run-a', tmpdir: tempBase });
  const tmpDir = path.join(tempBase, 'swarm-e2e-run');
  const sqlite = tracker.e2ePath('fixture.sqlite');
  tracker.track('tmpdir', tmpDir);
  tracker.track('file', sqlite);
  tracker.track('db', 'swarm_e2e_fixture');

  const result = await cleanupE2eData(tracker, { rm, dropDb });

  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.removed,
    [
      { kind: 'tmpdir', value: tmpDir },
      { kind: 'file', value: sqlite },
      { kind: 'db', value: 'swarm_e2e_fixture' },
    ],
  );
  assert.deepEqual(rmCalls.map((c) => c.target), [tmpDir, sqlite]);
  assert.deepEqual(dropCalls, ['swarm_e2e_fixture']);
});

test('withE2eCleanup cleans up after success and after a thrown error', async () => {
  const { rm, dropDb, rmCalls } = deps();
  const tmpDir = path.join(tempBase, 'after-throw');

  await withE2eCleanup(
    async (tracker) => {
      tracker.track('tmpdir', tmpDir);
      return 'ok';
    },
    { root: projectRoot, runId: 'ok-run', rm, dropDb, tmpdir: tempBase },
  );
  assert.deepEqual(rmCalls.map((c) => c.target), [tmpDir]);

  rmCalls.length = 0;
  await assert.rejects(
    () => withE2eCleanup(
      async (tracker) => {
        tracker.track('tmpdir', tmpDir);
        throw new Error('e2e failed');
      },
      { root: projectRoot, runId: 'bad-run', rm, dropDb, tmpdir: tempBase },
    ),
    /e2e failed/,
  );
  assert.deepEqual(rmCalls.map((c) => c.target), [tmpDir]);
});

test('tracked path outside project root and temp is refused, not removed', async () => {
  const { rm, dropDb, rmCalls, dropCalls } = deps();
  const tracker = createE2eDataTracker({ root: projectRoot, runId: 'refuse', tmpdir: tempBase });
  const outside = path.join('/outside', 'leak');
  const inside = path.join(tempBase, 'allowed');
  tracker.track('file', outside);
  tracker.track('tmpdir', inside);

  const result = await cleanupE2eData(tracker, { rm, dropDb });

  assert.deepEqual(result.refused, [{ kind: 'file', value: outside }]);
  assert.deepEqual(result.removed, [{ kind: 'tmpdir', value: inside }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(rmCalls.map((c) => c.target), [inside]);
  assert.deepEqual(dropCalls, []);
});
